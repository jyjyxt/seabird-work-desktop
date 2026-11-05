//! MCP stdio bridge for agents launched by the user.
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
};

fn resolved(root: &Path, relative: &str, allow_new: bool) -> Result<PathBuf, String> {
    crate::workspace::resolve(root, relative, allow_new, true)
}

fn tools() -> Value {
    json!([
        {"name":"workspace_info","description":"获取 Seabird 当前连接的工作目录。","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"list_files","description":"列出工作目录中的文件和文件夹。","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"相对于工作目录的路径，默认为当前目录。"}},"additionalProperties":false}},
        {"name":"read_file","description":"读取工作目录中的 UTF-8 文本文件（最大 2 MB）。","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"相对文件路径"}},"required":["path"],"additionalProperties":false}},
        {"name":"write_file","description":"创建或覆盖工作目录中的 UTF-8 文本文件；父目录必须已存在。","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"相对文件路径"},"content":{"type":"string","description":"完整文件内容"}},"required":["path","content"],"additionalProperties":false}}
    ])
}

fn call_tool(root: &Path, name: &str, args: &Value) -> Result<String, String> {
    let path = || {
        args.get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "缺少 path".to_string())
    };
    match name {
        "workspace_info" => Ok(json!({"workspace":root}).to_string()),
        "list_files" => {
            let path = resolved(
                root,
                args.get("path").and_then(Value::as_str).unwrap_or("."),
                false,
            )?;
            let mut entries = Vec::new();
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_symlink() {
                    continue;
                }
                entries.push(json!({"name":entry.file_name().to_string_lossy(),"type":if kind.is_dir() {"directory"} else {"file"}}));
            }
            Ok(Value::Array(entries).to_string())
        }
        "read_file" => {
            let path = resolved(root, path()?, false)?;
            crate::workspace::read(&path)
        }
        "write_file" => {
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .ok_or("缺少 content")?;
            let path = resolved(root, path()?, true)?;
            crate::workspace::write(&path, content)?;
            Ok("已保存".into())
        }
        _ => Err(format!("未知工具：{name}")),
    }
}

fn handle(root: &Path, request: &Value) -> Option<Value> {
    let id = request.get("id")?.clone();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").unwrap_or(&Value::Null);
    let result = match method {
        "initialize" => {
            json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"seabird","version":env!("CARGO_PKG_VERSION")}})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools":tools()}),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").unwrap_or(&Value::Null);
            match call_tool(root, name, args) {
                Ok(text) => json!({"content":[{"type":"text","text":text}]}),
                Err(error) => json!({"content":[{"type":"text","text":error}],"isError":true}),
            }
        }
        _ => {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}),
            )
        }
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

pub fn run(workspace: &str) -> Result<(), String> {
    let root = fs::canonicalize(workspace).map_err(|e| format!("无法打开工作目录：{e}"))?;
    if !root.is_dir() {
        return Err("工作目录必须是文件夹".into());
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&root, &request),
            Err(_) => Some(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}),
            ),
        };
        if let Some(response) = response {
            writeln!(stdout, "{response}")
                .and_then(|_| stdout.flush())
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "seabird-bridge-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn handles_mcp_requests_and_workspace_files() {
        let root = temporary_workspace();
        let init = handle(
            &root,
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
        )
        .unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], "seabird");
        assert!(handle(
            &root,
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .is_none());
        let list = handle(
            &root,
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 4);
        call_tool(
            &root,
            "write_file",
            &json!({"path":"note.txt","content":"海鸟"}),
        )
        .unwrap();
        assert_eq!(
            call_tool(&root, "read_file", &json!({"path":"note.txt"})).unwrap(),
            "海鸟"
        );
        assert!(call_tool(&root, "read_file", &json!({"path":"../outside"})).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes_including_dangling_links() {
        let root = temporary_workspace();
        std::os::unix::fs::symlink(std::env::temp_dir(), root.join("external")).unwrap();
        std::os::unix::fs::symlink(
            std::env::temp_dir().join("nonexistent-seabird-target"),
            root.join("dangling"),
        )
        .unwrap();
        assert!(call_tool(
            &root,
            "write_file",
            &json!({"path":"external/escape.txt","content":"no"})
        )
        .is_err());
        assert!(call_tool(
            &root,
            "write_file",
            &json!({"path":"dangling","content":"no"})
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
