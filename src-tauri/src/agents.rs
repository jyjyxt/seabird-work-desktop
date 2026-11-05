//! Agent registry and executable discovery.
use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub const IDS: &[&str] = &["codex", "claude"];

/// Native protocol selection and launch options live beside discovery.
pub fn interactive_command(id: &str, session: Option<&str>) -> Result<Command, String> {
    let executable = find_agent(id).ok_or_else(|| format!("未找到 {id}，请先安装"))?;
    let mut cmd = Command::new(executable);
    match id {
        "codex" => {
            cmd.args(["app-server", "--stdio"]);
        }
        "claude" => {
            cmd.args([
                "--print",
                "--verbose",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--permission-prompt-tool",
                "stdio",
            ]);
            if let Some(session) = session {
                cmd.args(["--resume", session]);
            }
        }
        _ => return Err("不支持的 Agent".into()),
    }
    Ok(cmd)
}

pub fn find_agent(id: &str) -> Option<String> {
    if !IDS.contains(&id) {
        return None;
    }
    #[cfg(windows)]
    let output = Command::new("where").arg(id).output().ok();
    #[cfg(not(windows))]
    let output = Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
        .args(["-lc", &format!("command -v {id}")])
        .output()
        .ok();
    if let Some(output) = output.filter(|output| output.status.success()) {
        if let Some(path) = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| Path::new(line).is_file())
        {
            return Some(path.to_string());
        }
    }
    let name = if cfg!(windows) {
        format!("{id}.exe")
    } else {
        id.to_string()
    };
    let mut candidates = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        candidates.extend([home.join(".local/bin"), home.join(".cargo/bin")]);
    }
    #[cfg(not(windows))]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    for candidate in candidates {
        let path = candidate.join(&name);
        if path.is_file() {
            return Some(path.to_string_lossy().into_owned());
        }
    }
    crate::setup::saved_agent(id)
}
