mod agent_adapter;
mod agents;
mod bridge;
mod cli;
mod interactive;
mod setup;
mod workspace;

pub fn run_setup(workspace: Option<&str>) -> Result<(String, bool), String> {
    let report = setup::setup(workspace)?;
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    Ok((json, report.ok))
}

pub fn run_bridge(workspace: &str) -> Result<(), String> {
    bridge::run(workspace)
}

pub fn run_cli(args: &[String]) -> i32 {
    cli::run(args)
}

use rusqlite::{types::ValueRef, Connection};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager, State};

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}
#[derive(Serialize)]
struct Agent {
    id: String,
    path: Option<String>,
}
#[derive(Serialize)]
struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
    message: String,
}

#[tauri::command]
async fn setup_agents(root: String) -> Result<setup::SetupReport, String> {
    tauri::async_runtime::spawn_blocking(move || setup::setup(Some(&root)))
        .await
        .map_err(|e| format!("连接失败：{e}"))?
}

#[tauri::command]
fn saved_setup_report() -> Result<Option<setup::SetupReport>, String> {
    setup::saved_report()
}

#[tauri::command]
fn saved_workspace() -> Result<Option<String>, String> {
    setup::saved_workspace()
}

#[tauri::command]
fn setup_command() -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    return Ok(format!("& \"{}\" --setup", executable.replace('\"', "`\"")));
    #[cfg(not(windows))]
    Ok(format!("{} --setup", shell_quote(&executable)))
}

#[tauri::command]
fn remember_workspace(root: String) -> Result<(), String> {
    setup::remember_workspace(&root)
}

#[tauri::command]
fn default_workspace(app: tauri::AppHandle) -> Result<String, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|e| format!("无法找到文稿目录：{e}"))?;
    let workspace = documents.join("seabird");
    fs::create_dir_all(&workspace).map_err(|e| format!("无法创建默认工作目录：{e}"))?;
    Ok(workspace.to_string_lossy().into_owned())
}

fn workspace_path(root: &str, path: &str) -> Result<PathBuf, String> {
    workspace::resolve(&workspace::root(root)?, path, false, false)
}

#[tauri::command]
fn list_files(root: String, path: String) -> Result<Vec<Entry>, String> {
    let path = workspace_path(&root, &path)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(path).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == "node_modules" || name == "target" {
            continue;
        }
        let file_type = item.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        entries.push(Entry {
            name,
            path: item.path().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}
#[tauri::command]
fn read_file(root: String, path: String) -> Result<String, String> {
    let path = workspace_path(&root, &path)?;
    workspace::read(&path)
}
#[tauri::command]
fn write_file(root: String, path: String, content: String) -> Result<(), String> {
    let path = workspace_path(&root, &path)?;
    workspace::write(&path, &content)
}
fn find_agent(id: &str) -> Option<String> {
    agents::find_agent(id)
}

#[tauri::command]
fn detect_agents() -> Vec<Agent> {
    agents::IDS
        .iter()
        .map(|id| Agent {
            id: id.to_string(),
            path: find_agent(id),
        })
        .collect()
}
#[derive(Default)]
struct AgentProcesses(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

#[derive(Clone, Serialize)]
struct AgentEvent {
    run_id: String,
    kind: String,
    text: String,
}

fn emit_agent(app: &tauri::AppHandle, run_id: &str, kind: &str, text: String) {
    let _ = app.emit(
        "agent-event",
        AgentEvent {
            run_id: run_id.into(),
            kind: kind.into(),
            text,
        },
    );
}

fn forward_output(mut stream: impl Read, app: &tauri::AppHandle, run_id: &str) {
    let mut buffer = [0u8; 4096];
    let mut pending = Vec::new();
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => pending.extend_from_slice(&buffer[..n]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                emit_agent(
                    app,
                    run_id,
                    "output",
                    format!("读取 Agent 输出失败：{error}\n"),
                );
                break;
            }
        }
        loop {
            match std::str::from_utf8(&pending) {
                Ok(text) => {
                    if !text.is_empty() {
                        emit_agent(app, run_id, "output", text.to_string());
                    }
                    pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        emit_agent(
                            app,
                            run_id,
                            "output",
                            String::from_utf8_lossy(&pending[..valid]).into_owned(),
                        );
                        pending.drain(..valid);
                    }
                    match error.error_len() {
                        Some(invalid) => {
                            emit_agent(app, run_id, "output", "�".into());
                            pending.drain(..invalid);
                        }
                        None => break,
                    }
                }
            }
        }
    }
    if !pending.is_empty() {
        emit_agent(
            app,
            run_id,
            "output",
            String::from_utf8_lossy(&pending).into_owned(),
        );
    }
}

#[tauri::command]
fn start_agent(
    app: tauri::AppHandle,
    processes: State<'_, AgentProcesses>,
    root: String,
    id: String,
    prompt: String,
    run_id: String,
    session_id: Option<String>,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("请输入任务内容".into());
    }
    if prompt.len() > 200_000 {
        return Err("任务内容过长".into());
    }
    if run_id.len() > 128 || run_id.is_empty() {
        return Err("任务标识无效".into());
    }
    let root = fs::canonicalize(root).map_err(|e| format!("无法打开工作目录：{e}"))?;
    if !root.is_dir() {
        return Err("请选择工作目录".into());
    }
    let executable = find_agent(&id).ok_or_else(|| format!("未找到 {id}，请检查安装和 PATH"))?;
    let mut command = Command::new(executable);
    command.args(agent_adapter::args(&id, session_id.as_deref())?);
    let mut child = command
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 {id}：{e}"))?;
    let mut stdin = child.stdin.take().ok_or("无法打开 Agent 输入")?;
    let stdout = child.stdout.take().ok_or("无法读取 Agent 输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 Agent 错误输出")?;
    let child = Arc::new(Mutex::new(child));
    let mut running = processes.0.lock().map_err(|_| "无法记录 Agent 任务")?;
    if running.contains_key(&run_id) {
        let _ = child.lock().map(|mut child| child.kill());
        return Err("任务标识已存在".into());
    }
    running.insert(run_id.clone(), Arc::clone(&child));
    drop(running);
    thread::spawn(move || {
        let input_app = app.clone();
        let input_id = run_id.clone();
        let input_thread = thread::spawn(move || {
            if let Err(error) = stdin.write_all(prompt.as_bytes()) {
                emit_agent(
                    &input_app,
                    &input_id,
                    "output",
                    format!("输入任务失败：{error}\n"),
                );
            }
        });
        let error_app = app.clone();
        let error_id = run_id.clone();
        let error_thread = thread::spawn(move || forward_output(stderr, &error_app, &error_id));
        let mut protocol_failure = None;
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !line.is_empty() => {
                    for event in agent_adapter::parse(&id, &line) {
                        match event {
                            agent_adapter::Event::Session(session) => {
                                emit_agent(&app, &run_id, "session", session)
                            }
                            agent_adapter::Event::Output(text) => {
                                emit_agent(&app, &run_id, "output", text)
                            }
                            agent_adapter::Event::Failure(text) => protocol_failure = Some(text),
                        }
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    protocol_failure = Some(format!("读取 Agent 输出失败：{error}"));
                    break;
                }
            }
        }
        let status = loop {
            let result = child
                .lock()
                .map_err(|_| std::io::Error::other("任务状态不可用"))
                .and_then(|mut child| child.try_wait());
            match result {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(error) => break Err(error),
            }
        };
        if let Ok(mut running) = app.state::<AgentProcesses>().0.lock() {
            running.remove(&run_id);
        }
        let _ = input_thread.join();
        let _ = error_thread.join();
        match (protocol_failure, status) {
            (Some(error), _) => emit_agent(&app, &run_id, "error", error),
            (None, Ok(status)) if status.success() => {
                emit_agent(&app, &run_id, "done", "本轮完成".into())
            }
            (None, Ok(status)) => {
                emit_agent(&app, &run_id, "error", format!("Agent 已退出：{status}"))
            }
            (None, Err(error)) => {
                emit_agent(&app, &run_id, "error", format!("无法获取执行结果：{error}"))
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_agent(processes: State<'_, AgentProcesses>, run_id: String) -> Result<(), String> {
    let child = processes
        .0
        .lock()
        .map_err(|_| "无法读取 Agent 任务")?
        .get(&run_id)
        .cloned()
        .ok_or("任务已经结束")?;
    let result = child
        .lock()
        .map_err(|_| "无法停止 Agent 任务")?
        .kill()
        .map_err(|e| format!("无法停止任务：{e}"));
    result
}

#[derive(Serialize)]
struct BridgeConfig {
    command: String,
    args: Vec<String>,
}
#[tauri::command]
fn bridge_config(root: String) -> Result<BridgeConfig, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("无法打开工作目录：{e}"))?;
    if !root.is_dir() {
        return Err("请选择工作目录".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(BridgeConfig {
        command: executable.to_string_lossy().into_owned(),
        args: vec!["--mcp".into(), root.to_string_lossy().into_owned()],
    })
}

#[tauri::command]
async fn register_bridge(root: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = bridge_config(root)?;
        let executable = find_agent(&id).ok_or_else(|| format!("未找到 {id}，请先安装"))?;
        let mut command = Command::new(executable);
        match id.as_str() {
            "codex" => {
                command.args(["mcp", "add", "seabird", "--"]);
            }
            "claude" => {
                command.args([
                    "mcp",
                    "add",
                    "--scope",
                    "user",
                    "--transport",
                    "stdio",
                    "seabird",
                    "--",
                ]);
            }
            _ => return Err("不支持的 Agent".into()),
        }
        let output = command
            .arg(config.command)
            .args(config.args)
            .output()
            .map_err(|e| format!("连接失败：{e}"))?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(format!(
                "连接失败：{}",
                if message.is_empty() { stdout } else { message }
            ));
        }
        Ok(format!(
            "已连接到 {}，新会话可访问当前工作目录",
            if id == "codex" {
                "Codex"
            } else {
                "Claude Code"
            }
        ))
    })
    .await
    .map_err(|e| format!("连接失败：{e}"))?
}

#[tauri::command]
async fn unregister_bridge(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let executable = find_agent(&id).ok_or_else(|| format!("未找到 {id}，请先安装"))?;
        let mut command = Command::new(executable);
        match id.as_str() {
            "codex" => {
                command.args(["mcp", "remove", "seabird"]);
            }
            "claude" => {
                command.args(["mcp", "remove", "--scope", "user", "seabird"]);
            }
            _ => return Err("不支持的 Agent".into()),
        }
        let output = command.output().map_err(|e| format!("移除失败：{e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(format!(
                "移除失败：{}",
                if stderr.is_empty() { stdout } else { stderr }
            ));
        }
        setup::mark_removed(&id)?;
        Ok("已移除 Seabird 的 MCP 连接".into())
    })
    .await
    .map_err(|e| format!("移除失败：{e}"))?
}

#[cfg(not(windows))]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
#[tauri::command]
fn launch_agent(root: String, id: String) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|e| format!("无法打开工作目录：{e}"))?;
    if !root.is_dir() {
        return Err("请选择文件夹作为工作目录".into());
    }
    let executable =
        find_agent(&id).ok_or_else(|| format!("未找到 {id} 的命令行程序，请检查安装和 PATH"))?;
    #[cfg(target_os = "macos")]
    {
        let command = format!(
            "cd {} && {}",
            shell_quote(&root.to_string_lossy()),
            shell_quote(&executable)
        );
        let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
        let status = Command::new("osascript")
            .args([
                "-e",
                &format!("tell application \"Terminal\" to do script \"{escaped}\""),
                "-e",
                "tell application \"Terminal\" to activate",
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("无法打开终端，请检查系统的自动化权限".into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        let command = format!("{}; exec ${{SHELL:-/bin/sh}}", shell_quote(&executable));
        let candidates = [
            (
                "x-terminal-emulator",
                vec!["-e", "sh", "-lc", command.as_str()],
            ),
            ("gnome-terminal", vec!["--", "sh", "-lc", command.as_str()]),
            ("konsole", vec!["-e", "sh", "-lc", command.as_str()]),
            ("xterm", vec!["-e", "sh", "-lc", command.as_str()]),
        ];
        if !candidates.iter().any(|(program, args)| {
            Command::new(program)
                .args(args)
                .current_dir(&root)
                .spawn()
                .is_ok()
        }) {
            return Err("未找到支持的终端程序".into());
        }
    }
    #[cfg(windows)]
    {
        // Start an interactive shell in the chosen directory; cmd resolves .cmd wrappers too.
        Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", &executable])
            .current_dir(&root)
            .spawn()
            .map_err(|e| format!("无法打开终端：{e}"))?;
    }
    Ok(())
}
fn database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("workbench.sqlite3")).map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);").map_err(|e| e.to_string())?;
    Ok(conn)
}
#[tauri::command]
fn run_sql(app: tauri::AppHandle, sql: String) -> Result<QueryResult, String> {
    let conn = database(&app)?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    if columns.is_empty() {
        let count = stmt.execute([]).map_err(|e| e.to_string())?;
        return Ok(QueryResult {
            columns,
            rows: vec![],
            message: format!("执行成功，影响 {count} 行"),
        });
    }
    let n = columns.len();
    let mut cursor = stmt.query([]).map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    while let Some(row) = cursor.next().map_err(|e| e.to_string())? {
        if rows.len() >= 500 {
            break;
        }
        let mut cells = Vec::new();
        for i in 0..n {
            cells.push(match row.get_ref(i).map_err(|e| e.to_string())? {
                ValueRef::Null => "NULL".into(),
                ValueRef::Integer(v) => v.to_string(),
                ValueRef::Real(v) => v.to_string(),
                ValueRef::Text(v) => String::from_utf8_lossy(v).into_owned(),
                ValueRef::Blob(v) => format!("[BLOB · {} bytes]", v.len()),
            });
        }
        rows.push(cells);
    }
    let message = format!(
        "返回 {} 行{}",
        rows.len(),
        if rows.len() == 500 {
            "（最多显示 500 行）"
        } else {
            ""
        }
    );
    Ok(QueryResult {
        columns,
        rows,
        message,
    })
}
#[tauri::command]
fn database_path(app: tauri::AppHandle) -> Result<String, String> {
    database(&app)?;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(Path::new("workbench.sqlite3"))
        .to_string_lossy()
        .into_owned())
}
#[tauri::command]
fn list_conversations(
    app: tauri::AppHandle,
    root: String,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = database(&app)?;
    read_conversations(&conn, &root)
}
fn read_conversations(conn: &Connection, root: &str) -> Result<Vec<serde_json::Value>, String> {
    ensure_conversations(conn)?;
    let mut stmt = conn
        .prepare("SELECT data FROM agent_conversations WHERE root = ?1 ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([root], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        let value = row.map_err(|e| e.to_string())?;
        result.push(serde_json::from_str(&value).map_err(|e| e.to_string())?);
    }
    Ok(result)
}
#[tauri::command]
fn save_conversation(
    app: tauri::AppHandle,
    root: String,
    conversation: serde_json::Value,
) -> Result<(), String> {
    let conn = database(&app)?;
    write_conversation(&conn, &root, &conversation)
}
fn ensure_conversations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS agent_conversations (id TEXT PRIMARY KEY, root TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)").map_err(|e| e.to_string())
}
fn write_conversation(
    conn: &Connection,
    root: &str,
    conversation: &serde_json::Value,
) -> Result<(), String> {
    let id = conversation["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or("会话标识无效")?;
    let data = serde_json::to_string(&conversation).map_err(|e| e.to_string())?;
    if data.len() > 2_000_000 {
        return Err("对话记录过长".into());
    }
    ensure_conversations(conn)?;
    conn.execute("INSERT INTO agent_conversations (id, root, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE root = excluded.root", rusqlite::params![id, root, data, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64]).map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
mod conversation_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn saves_latest_session_and_isolates_workspaces() {
        let conn = Connection::open_in_memory().unwrap();
        let first = json!({"id":"local-1","sessionId":"native-1","output":"first"});
        write_conversation(&conn, "/one", &first).unwrap();
        let updated = json!({"id":"local-1","sessionId":"native-1","output":"continued"});
        write_conversation(&conn, "/one", &updated).unwrap();
        assert_eq!(
            read_conversations(&conn, "/one").unwrap(),
            vec![updated.clone()]
        );
        assert!(read_conversations(&conn, "/two").unwrap().is_empty());
        write_conversation(&conn, "/two", &json!({"id":"local-1","output":"other"})).unwrap();
        assert_eq!(read_conversations(&conn, "/one").unwrap(), vec![updated]);
        assert!(read_conversations(&conn, "/two").unwrap().is_empty());
    }
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AgentProcesses::default())
        .manage(interactive::Processes::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_workspace,
            setup_agents,
            remember_workspace,
            saved_workspace,
            saved_setup_report,
            setup_command,
            list_files,
            read_file,
            write_file,
            detect_agents,
            start_agent,
            interactive::start_interactive,
            interactive::respond_interactive,
            interactive::stop_interactive,
            list_conversations,
            save_conversation,
            stop_agent,
            bridge_config,
            register_bridge,
            unregister_bridge,
            launch_agent,
            run_sql,
            database_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Seabird");
}
