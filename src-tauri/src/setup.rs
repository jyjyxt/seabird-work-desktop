//! Shared one-command / desktop setup for local agent connections.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    pub workspace: Option<String>,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentSetup>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSetup {
    pub id: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub auth: String,
    pub bridge: String,
    pub detail: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct SetupReport {
    pub workspace: String,
    pub agents: Vec<AgentSetup>,
    pub ok: bool,
}
fn report(workspace: String, agents: Vec<AgentSetup>) -> SetupReport {
    let installed: Vec<_> = agents.iter().filter(|agent| agent.path.is_some()).collect();
    let ok = !installed.is_empty()
        && installed.iter().all(|agent| {
            agent.version.is_some() && agent.auth == "configured" && agent.bridge == "connected"
        });
    SetupReport {
        workspace,
        agents,
        ok,
    }
}

fn config_file() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法找到应用配置目录")?
        .join("com.seabird.workbench")
        .join("connections.json"))
}
fn read_settings_at(path: &Path) -> Result<Settings, String> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|e| format!("无法读取连接配置：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("无法读取连接配置：{e}")),
    }
}
fn save_settings_at(path: &Path, settings: &Settings) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("无效配置目录")?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path.parent().ok_or("无效配置目录")?,
            fs::Permissions::from_mode(0o700),
        )
        .map_err(|e| e.to_string())?;
    }
    let production_config = config_file().ok().as_deref() == Some(path);
    if production_config && path.exists() {
        crate::backup::configuration(path)
            .map_err(|error| format!("无法备份原配置，未修改本地配置：{error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let temp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    fs::write(&temp, bytes).map_err(|e| format!("无法保存连接配置：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("无法保存连接配置：{e}"));
    }
    if production_config {
        crate::backup::configuration(path)
            .map_err(|error| format!("本地配置已保存，但备份失败：{error}"))?;
    }
    Ok(())
}

// A separate SQLite lock coordinates all desktop and CLI read-modify-write operations.
fn update_settings_at<F>(path: &Path, update: F) -> Result<(), String>
where
    F: FnOnce(&mut Settings) -> Result<(), String>,
{
    fs::create_dir_all(path.parent().ok_or("无效配置目录")?).map_err(|e| e.to_string())?;
    let mut lock = rusqlite::Connection::open(path.with_extension("lock.sqlite3"))
        .map_err(|e| e.to_string())?;
    lock.busy_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    let transaction = lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut settings = read_settings_at(path)?;
    update(&mut settings)?;
    save_settings_at(path, &settings)?;
    transaction.commit().map_err(|e| e.to_string())
}
pub fn saved_report() -> Result<Option<SetupReport>, String> {
    let settings = read_settings_at(&config_file()?)?;
    if settings.agents.is_empty() {
        return Ok(None);
    }
    Ok(settings
        .workspace
        .map(|workspace| report(workspace, settings.agents.into_values().collect())))
}
pub fn saved_workspace() -> Result<Option<String>, String> {
    Ok(read_settings_at(&config_file()?)?.workspace)
}
pub fn saved_agent(id: &str) -> Option<String> {
    read_settings_at(&config_file().ok()?)
        .ok()?
        .agents
        .get(id)?
        .path
        .clone()
        .filter(|path| Path::new(path).is_file())
}

pub fn mark_removed(id: &str) -> Result<(), String> {
    let path = config_file()?;
    update_settings_at(&path, |settings| {
        if let Some(agent) = settings.agents.get_mut(id) {
            agent.bridge = "not_connected".into();
            agent.detail = "MCP 连接已移除".into();
        }
        Ok(())
    })
}
pub fn remember_workspace(root: &str) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|e| format!("无法打开工作目录：{e}"))?;
    if !root.is_dir() {
        return Err("请选择工作目录".into());
    }
    let path = config_file()?;
    let root = root.to_string_lossy().into_owned();
    update_settings_at(&path, |settings| {
        if settings.workspace.as_deref() != Some(root.as_str()) {
            for agent in settings.agents.values_mut() {
                agent.bridge = "stale".into();
                agent.detail = "工作目录已改变，请移除旧 MCP 连接后重新配置".into();
            }
        }
        settings.workspace = Some(root);
        Ok(())
    })
}
fn workspace(explicit: Option<&str>, settings: &Settings) -> Result<PathBuf, String> {
    let path = match explicit.or(settings.workspace.as_deref()) {
        Some(value) => PathBuf::from(value),
        None => {
            let path = dirs::document_dir()
                .ok_or("无法找到文稿目录，请在 Seabird 里选择工作目录")?
                .join("seabird");
            fs::create_dir_all(&path).map_err(|e| format!("无法创建默认工作目录：{e}"))?;
            path
        }
    };
    let path = fs::canonicalize(path)
        .map_err(|e| format!("无法打开工作目录：{e}；请在 Seabird 里重新选择"))?;
    if !path.is_dir() {
        return Err("工作目录必须是文件夹".into());
    }
    Ok(path)
}

pub(crate) fn run_command(
    executable: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<Output, String> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("无法读取输出")?;
    let mut stderr = child.stderr.take().ok_or("无法读取错误输出")?;
    let out_thread = thread::spawn(move || {
        let mut result = Vec::new();
        let _ = stdout.read_to_end(&mut result);
        result
    });
    let err_thread = thread::spawn(move || {
        let mut result = Vec::new();
        let _ = stderr.read_to_end(&mut result);
        result
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("检查超时".into());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    };
    Ok(Output {
        status,
        stdout: out_thread.join().unwrap_or_default(),
        stderr: err_thread.join().unwrap_or_default(),
    })
}
pub fn auth_status(id: &str, executable: &str) -> String {
    let args: &[&str] = if id == "codex" {
        &["login", "status"]
    } else {
        &["auth", "status"]
    };
    match run_command(executable, args, Duration::from_secs(8)) {
        Ok(output) if id == "claude" => {
            match serde_json::from_slice::<serde_json::Value>(&output.stdout)
                .ok()
                .and_then(|v| v.get("loggedIn").and_then(|x| x.as_bool()))
            {
                Some(true) => "configured".into(),
                Some(false) => "not_logged_in".into(),
                None => "unknown".into(),
            }
        }
        Ok(output) if output.status.success() => "configured".into(),
        Ok(output) => {
            let text = format!(
                "{} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .to_lowercase();
            if text.contains("not logged in") || text.contains("not authenticated") {
                "not_logged_in".into()
            } else {
                "unknown".into()
            }
        }
        Err(_) => "unknown".into(),
    }
}

pub fn verify_bridge(binary: &str, root: &str) -> Result<(), String> {
    let mut child = Command::new(binary)
        .args(["--mcp", root])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("无法连接本地 MCP 输入")?;
    let stdout = child.stdout.take().ok_or("无法读取本地 MCP 输出")?;
    let message = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"seabird-setup","version":"1"}}});
    if let Err(error) = writeln!(stdin, "{message}") {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.to_string());
    }
    drop(stdin);
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = send.send(result);
    });
    let response = receive.recv_timeout(Duration::from_secs(5));
    let _ = child.kill();
    let _ = child.wait();
    let line = response
        .map_err(|_| "本地 MCP 握手超时".to_string())?
        .map_err(|e| e.to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| format!("MCP 握手响应无效：{e}"))?;
    if value
        .pointer("/result/serverInfo/name")
        .and_then(|v| v.as_str())
        != Some("seabird")
    {
        return Err("MCP 握手未确认 Seabird".into());
    }
    Ok(())
}

fn bridge_check(
    id: &str,
    agent: &str,
    binary: &str,
    root: &str,
    install: bool,
) -> (String, String) {
    let get: &[&str] = if id == "codex" {
        &["mcp", "get", "seabird", "--json"]
    } else {
        &["mcp", "get", "seabird"]
    };
    let existing = match run_command(agent, get, Duration::from_secs(12)) {
        Ok(output) => output,
        Err(error) => return ("error".into(), format!("检查 MCP 连接失败：{error}")),
    };
    if existing.status.success() {
        let text = String::from_utf8_lossy(&existing.stdout);
        let matches = if id == "codex" {
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .is_some_and(|value| {
                    value.pointer("/transport/command").and_then(|v| v.as_str()) == Some(binary)
                        && value
                            .pointer("/transport/args")
                            .and_then(|v| v.as_array())
                            .is_some_and(|args| {
                                args == &[serde_json::json!("--mcp"), serde_json::json!(root)]
                            })
                        && value.get("enabled").and_then(|v| v.as_bool()) != Some(false)
                })
        } else {
            text.contains(binary) && text.contains(root) && text.contains("--mcp")
        };
        return if matches {
            ("connected".into(), "MCP 已指向当前工作目录".into())
        } else {
            (
                "conflict".into(),
                "已存在不同的 seabird MCP 配置，未覆盖；请先移除旧连接".into(),
            )
        };
    }
    let text = format!(
        "{} {}",
        String::from_utf8_lossy(&existing.stdout),
        String::from_utf8_lossy(&existing.stderr)
    );
    if !text.to_lowercase().contains("no mcp server named") {
        return (
            "error".into(),
            "无法确认现有 MCP 配置，未修改；请检查 Agent 配置或权限".into(),
        );
    }
    if !install {
        return ("not_connected".into(), "尚未配置 Seabird MCP".into());
    }
    let args: Vec<&str> = if id == "codex" {
        vec!["mcp", "add", "seabird", "--", binary, "--mcp", root]
    } else {
        vec![
            "mcp",
            "add",
            "--scope",
            "user",
            "--transport",
            "stdio",
            "seabird",
            "--",
            binary,
            "--mcp",
            root,
        ]
    };
    match run_command(agent, &args, Duration::from_secs(12)) {
        Ok(output) if output.status.success() => (
            "connected".into(),
            "已注册 MCP；请在新 Agent 会话中使用".into(),
        ),
        Ok(_) => (
            "error".into(),
            "注册 MCP 失败，请检查 Agent 配置和权限".into(),
        ),
        Err(error) => ("error".into(), format!("注册 MCP 失败：{error}")),
    }
}
fn bridge_status(id: &str, agent: &str, binary: &str, root: &str) -> (String, String) {
    bridge_check(id, agent, binary, root, true)
}

pub fn check_bridge(
    id: &str,
    agent: &str,
    binary: &str,
    root: &str,
    install: bool,
) -> (String, String) {
    bridge_check(id, agent, binary, root, install)
}

pub fn remove_bridge(id: &str, agent: &str) -> Result<(), String> {
    let args: &[&str] = match id {
        "codex" => &["mcp", "remove", "seabird"],
        "claude" => &["mcp", "remove", "--scope", "user", "seabird"],
        _ => return Err("不支持的 Agent".into()),
    };
    let output = run_command(agent, args, Duration::from_secs(12))?;
    if !output.status.success() {
        return Err(format!(
            "移除 MCP 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    mark_removed(id)
}
pub fn inspect(root: &str) -> Result<SetupReport, String> {
    let root = crate::workspace::root(root)?.to_string_lossy().into_owned();
    let binary = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    inspect_with(root, &binary, crate::find_agent)
}

fn inspect_with<F: Fn(&str) -> Option<String>>(
    root: String,
    binary: &str,
    discover: F,
) -> Result<SetupReport, String> {
    let handshake = verify_bridge(binary, &root);
    let agents = ["codex", "claude"]
        .iter()
        .map(|id| {
            let Some(path) = discover(id) else {
                return AgentSetup {
                    id: (*id).into(),
                    path: None,
                    version: None,
                    auth: "unknown".into(),
                    bridge: "not_installed".into(),
                    detail: "未检测到安装".into(),
                };
            };
            let version = run_command(&path, &["--version"], Duration::from_secs(8))
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .next()
                        .map(|s| s.chars().take(160).collect())
                });
            let auth = auth_status(id, &path);
            let (bridge, detail) = check_bridge(id, &path, binary, &root, false);
            let detail = match &handshake {
                Ok(()) => format!("{detail}；本地 MCP 服务握手正常，客户端调用尚未验证"),
                Err(e) => format!("{detail}；本地 MCP 服务握手失败：{e}"),
            };
            AgentSetup {
                id: (*id).into(),
                path: Some(path),
                version,
                auth,
                bridge,
                detail,
            }
        })
        .collect();
    Ok(report(root, agents))
}

fn configure_agent(id: &str, agent: Option<String>, binary: &str, root: &str) -> AgentSetup {
    let Some(path) = agent else {
        return AgentSetup {
            id: id.into(),
            path: None,
            version: None,
            auth: "unknown".into(),
            bridge: "not_installed".into(),
            detail: "未检测到安装，请安装后重新连接".into(),
        };
    };
    let version = match run_command(&path, &["--version"], Duration::from_secs(8)) {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .map(|s| s.chars().take(160).collect()),
        _ => None,
    };
    if version.is_none() {
        return AgentSetup {
            id: id.into(),
            path: Some(path),
            version: None,
            auth: "unknown".into(),
            bridge: "error".into(),
            detail: "找到命令但无法运行，请检查安装".into(),
        };
    }
    let auth = auth_status(id, &path);
    let (bridge, detail) = bridge_status(id, &path, binary, root);
    AgentSetup {
        id: id.into(),
        path: Some(path),
        version,
        auth,
        bridge,
        detail,
    }
}
fn setup_with<F>(
    path: &Path,
    explicit_root: Option<&str>,
    binary: &str,
    discover: F,
) -> Result<SetupReport, String>
where
    F: Fn(&str) -> Option<String>,
{
    let settings = read_settings_at(path)?;
    let original_workspace = settings.workspace.clone();
    let root = workspace(explicit_root, &settings)?
        .to_string_lossy()
        .into_owned();
    verify_bridge(binary, &root).map_err(|e| format!("本地 MCP 不可用，未修改 Agent 配置：{e}"))?;
    let mut agents = Vec::new();
    for id in ["codex", "claude"] {
        let result = configure_agent(id, discover(id), binary, &root);
        agents.push(result);
    }
    update_settings_at(path, |settings| {
        if settings.workspace != original_workspace {
            return Err("配置期间工作目录已改变，请重新连接".into());
        }
        for result in &agents {
            settings.agents.insert(result.id.clone(), result.clone());
        }
        settings.workspace = Some(root.clone());
        Ok(())
    })?;
    Ok(report(root, agents))
}
pub fn setup(explicit_root: Option<&str>) -> Result<SetupReport, String> {
    let path = config_file()?;
    let binary = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    setup_with(&path, explicit_root, &binary, super::find_agent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tempdir() -> PathBuf {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "seabird-setup-test-{}-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn saves_workspace_and_reports_partial_setup() {
        let dir = tempdir();
        let path = dir.join("settings.json");
        let mut settings = Settings::default();
        settings.workspace = Some(dir.to_string_lossy().into_owned());
        settings.agents.insert(
            "codex".into(),
            AgentSetup {
                id: "codex".into(),
                path: Some("/tmp/codex".into()),
                version: Some("1".into()),
                auth: "unknown".into(),
                bridge: "connected".into(),
                detail: "".into(),
            },
        );
        save_settings_at(&path, &settings).unwrap();
        let loaded = read_settings_at(&path).unwrap();
        assert_eq!(workspace(None, &loaded).unwrap(), dir);
        let result = report(
            loaded.workspace.unwrap(),
            loaded.agents.into_values().collect(),
        );
        assert!(!result.ok);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn registers_once_and_preserves_different_existing_connection() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir();
        let script = dir.join("codex");
        let state = dir.join("state");
        let count = dir.join("adds");
        let binary = "/tmp/seabird-test";
        let root = dir.to_string_lossy().to_string();
        let expected = serde_json::json!({"enabled":true,"transport":{"command":binary,"args":["--mcp",root]}}).to_string();
        let body = format!("#!/bin/sh\nif [ \"$1 $2\" = 'mcp get' ]; then\n if [ -f '{state}' ]; then cat '{state}'; exit 0; fi\n echo \"No MCP server named 'seabird' found\" >&2; exit 1\nfi\nif [ \"$1 $2\" = 'mcp add' ]; then\n printf '%s' '{expected}' > '{state}'\n echo add >> '{count}'\n exit 0\nfi\nexit 2\n", state=state.display(), count=count.display());
        fs::write(&script, body).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let agent = script.to_str().unwrap();
        assert_eq!(
            bridge_check("codex", agent, binary, &root, false).0,
            "not_connected"
        );
        assert!(!count.exists(), "status and preview must not register MCP");
        assert_eq!(bridge_status("codex", agent, binary, &root).0, "connected");
        assert_eq!(
            bridge_check("codex", agent, binary, &root, false).0,
            "connected"
        );
        assert_eq!(bridge_status("codex", agent, binary, &root).0, "connected");
        assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 1);
        fs::write(
            &state,
            r#"{"enabled":true,"transport":{"command":"/other","args":[]}}"#,
        )
        .unwrap();
        assert_eq!(bridge_status("codex", agent, binary, &root).0, "conflict");
        assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn inspection_reports_status_without_registering() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir();
        let bridge = dir.join("seabird");
        let agent = dir.join("codex");
        let writes = dir.join("writes");
        fs::write(&bridge, "#!/bin/sh\nread line\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"seabird\"}}}'\n").unwrap();
        let script = format!("#!/bin/sh\ncase \"$1 $2\" in\n '--version ') echo 'codex 1';;\n 'login status') exit 0;;\n 'mcp get') echo \"No MCP server named 'seabird' found\" >&2; exit 1;;\n 'mcp add') touch '{}';;\n *) exit 2;;\nesac\n", writes.display());
        fs::write(&agent, script).unwrap();
        for path in [&bridge, &agent] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = agent.to_string_lossy().into_owned();
        let report = inspect_with(
            dir.to_string_lossy().into_owned(),
            bridge.to_str().unwrap(),
            |id| (id == "codex").then(|| path.clone()),
        )
        .unwrap();
        assert_eq!(report.agents[0].auth, "configured");
        assert_eq!(report.agents[0].bridge, "not_connected");
        assert!(report.agents[0].detail.contains("客户端调用尚未验证"));
        assert_eq!(report.agents[1].bridge, "not_installed");
        assert!(!writes.exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn concurrent_updates_preserve_both_changes() {
        let dir = tempdir();
        let config = dir.join("settings.json");
        let mut threads = Vec::new();
        for id in ["codex", "claude"] {
            let path = config.clone();
            threads.push(std::thread::spawn(move || {
                update_settings_at(&path, |settings| {
                    settings.agents.insert(
                        id.into(),
                        AgentSetup {
                            id: id.into(),
                            path: None,
                            version: None,
                            auth: "unknown".into(),
                            bridge: "not_connected".into(),
                            detail: String::new(),
                        },
                    );
                    Ok(())
                })
                .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(read_settings_at(&config).unwrap().agents.len(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn one_setup_configures_both_agents_and_is_repeatable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir();
        let config = dir.join("connections.json");
        let binary = dir.join("seabird");
        let bridge_script = "#!/bin/sh\nread line\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"seabird\"}}}'\n";
        fs::write(&binary, bridge_script).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let binary_string = binary.to_string_lossy().into_owned();
        let root = dir.to_string_lossy().into_owned();
        for id in ["codex", "claude"] {
            let script = dir.join(id);
            let state = dir.join(format!("{id}-state"));
            let count = dir.join(format!("{id}-adds"));
            let get_result = if id == "codex" {
                serde_json::json!({"enabled":true,"transport":{"command":binary_string,"args":["--mcp",root]}}).to_string()
            } else {
                format!("Command: {binary_string}\nArgs: --mcp {root}")
            };
            let body = format!("#!/bin/sh\nif [ \"$1\" = '--version' ]; then echo '{id} 1.0'; exit 0; fi\nif [ \"$1 $2\" = 'login status' ]; then echo logged-in; exit 0; fi\nif [ \"$1 $2\" = 'auth status' ]; then echo '{{\"loggedIn\":true}}'; exit 0; fi\nif [ \"$1 $2\" = 'mcp get' ]; then\n if [ -f '{state}' ]; then cat '{state}'; exit 0; fi\n echo \"No MCP server named 'seabird' found\" >&2; exit 1\nfi\nif [ \"$1 $2\" = 'mcp add' ]; then\n printf '%s' '{get_result}' > '{state}'\n echo add >> '{count}'\n exit 0\nfi\nexit 2\n", state=state.display(), count=count.display());
            fs::write(&script, body).unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let discover = |id: &str| Some(dir.join(id).to_string_lossy().into_owned());
        let first = setup_with(&config, Some(&root), &binary_string, discover).unwrap();
        assert!(first.ok, "{first:?}");
        let second = setup_with(&config, None, &binary_string, discover).unwrap();
        assert!(second.ok, "{second:?}");
        for id in ["codex", "claude"] {
            assert_eq!(
                fs::read_to_string(dir.join(format!("{id}-adds")))
                    .unwrap()
                    .lines()
                    .count(),
                1
            );
        }
        assert_eq!(read_settings_at(&config).unwrap().agents.len(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_handshake_does_not_modify_agent_configuration() {
        let dir = tempdir();
        let config = dir.join("connections.json");
        let result = setup_with(
            &config,
            Some(dir.to_str().unwrap()),
            "/does-not-exist/seabird",
            |_| panic!("agent discovery must not run after failed handshake"),
        );
        assert!(result.is_err());
        assert!(!config.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
