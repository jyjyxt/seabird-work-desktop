//! Command-line access for external agents. The desktop binary also serves MCP.
use crate::{find_agent, setup};
use serde_json::{json, Value};

const HELP: &str = "Seabird 本地工作台 CLI\n\n下方 seabird 表示 Seabird 可执行文件路径；程序未加入 PATH 时请使用完整路径。\n\n用法：\n  seabird --help\n  seabird version [--json]\n  seabird status [--json]\n  seabird workspace get [--json]\n  seabird workspace set --path <目录> [--json]\n  seabird agent list [--json]\n  seabird content list --workspace <目录> [--json]\n  seabird content save-material --workspace <目录> --input <JSON文件> [--json]\n  seabird content import-media --workspace <目录> --path <图片或视频> [--json]\n  seabird content save-article --workspace <目录> --input <JSON文件> [--json]\n  seabird mcp info --workspace <目录> [--json]\n  seabird mcp status <codex|claude> --workspace <目录> [--json]\n  seabird mcp install <codex|claude> --workspace <目录> [--dry-run] [--json]\n  seabird mcp remove <codex|claude> [--json]\n  seabird mcp serve --workspace <目录>\n\n内容写入 JSON 格式为 {\"item\":完整对象,\"expected\":原始对象}；新增时 item.id 为 0 且 expected 为 null，修改时 expected 必须是 list 返回的原始对象。素材字段：id,title,source,url,note,tags,media,updated_at；文章字段：id,title,body,versions,material_ids,updated_at。versions 如 {\"wechat\":{\"title\":\"标题\",\"body\":\"正文\"}}，无附件用 []，无版本用 {}，新内容 updated_at 用空字符串。写入后返回 id 和 backup_warning。导入图片或视频时先运行 content import-media，将返回的附件对象加入素材的 media 后保存；导入会复制文件。\n\nMCP 连接绑定指定目录，可读取、创建和覆盖该目录中的文本文件。配置后请在新 Agent 会话中验证。";

fn option(args: &[String], name: &str) -> Result<Option<String>, String> {
    let positions: Vec<_> = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| arg.as_str() == name)
        .collect();
    if positions.len() > 1 {
        return Err(format!("重复参数：{name}"));
    }
    match positions.first() {
        None => Ok(None),
        Some((index, _)) => args
            .get(index + 1)
            .filter(|s| !s.starts_with("--"))
            .cloned()
            .map(Some)
            .ok_or_else(|| format!("{name} 缺少值")),
    }
}

fn validate_options(args: &[String], values: &[&str], flags: &[&str]) -> Result<(), String> {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if values.contains(&arg) {
            if args.get(i + 1).is_none_or(|v| v.starts_with("--")) {
                return Err(format!("{arg} 缺少值"));
            }
            i += 2;
        } else if flags.contains(&arg) {
            if args[..i].iter().any(|v| v == arg) {
                return Err(format!("重复参数：{arg}"));
            }
            i += 1;
        } else {
            return Err(format!("未知参数：{arg}"));
        }
    }
    for name in values {
        option(args, name)?;
    }
    Ok(())
}

fn binary() -> Result<String, String> {
    Ok(std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned())
}

fn root(args: &[String]) -> Result<String, String> {
    let path = option(args, "--workspace")?.ok_or("请使用 --workspace 指定目录")?;
    let root = std::fs::canonicalize(&path).map_err(|e| format!("无法打开工作目录：{e}"))?;
    if !root.is_dir() {
        return Err("工作目录必须是文件夹".into());
    }
    Ok(root.to_string_lossy().into_owned())
}

fn agent(id: &str) -> Result<String, String> {
    if !["codex", "claude"].contains(&id) {
        return Err("仅支持 codex 或 claude".into());
    }
    find_agent(id).ok_or_else(|| format!("未检测到 {id}，请先安装"))
}

fn response(args: &[String]) -> Result<(Value, bool), String> {
    let first = args.first().map(String::as_str).unwrap_or("");
    let second = args.get(1).map(String::as_str).unwrap_or("");
    match (first, second) {
        ("version", _) => {
            validate_options(&args[1..], &[], &["--json"])?;
            Ok((
                json!({"schema_version":1,"version":env!("CARGO_PKG_VERSION")}),
                true,
            ))
        }
        ("status", _) => {
            validate_options(&args[1..], &[], &["--json"])?;
            Ok((
                json!({"schema_version":1,"executable":binary()?,"workspace":setup::saved_workspace()?,"agents":[{"id":"codex","path":find_agent("codex")},{"id":"claude","path":find_agent("claude")}]}),
                true,
            ))
        }
        ("workspace", "get") => {
            validate_options(&args[2..], &[], &["--json"])?;
            Ok((
                json!({"schema_version":1,"workspace":setup::saved_workspace()?}),
                true,
            ))
        }
        ("workspace", "set") => {
            validate_options(&args[2..], &["--path"], &["--json"])?;
            let path = option(&args[2..], "--path")?.ok_or("请使用 --path 指定目录")?;
            setup::remember_workspace(&path)?;
            Ok((
                json!({"schema_version":1,"workspace":setup::saved_workspace()?,"note":"已保存默认目录；已打开的窗口和 MCP 连接不会自动切换。"}),
                true,
            ))
        }
        ("agent", "list") => {
            validate_options(&args[2..], &[], &["--json"])?;
            let agents: Vec<_> = ["codex", "claude"]
                .iter()
                .map(|id| {
                    let path = find_agent(id);
                    let auth = path
                        .as_deref()
                        .map(|p| setup::auth_status(id, p))
                        .unwrap_or_else(|| "unknown".into());
                    json!({"id":id,"path":path,"auth":auth})
                })
                .collect();
            Ok((json!({"schema_version":1,"agents":agents}), true))
        }
        ("content", "import-media") => {
            validate_options(&args[2..], &["--workspace", "--path"], &["--json"])?;
            let workspace = root(&args[2..])?;
            let path = option(&args[2..], "--path")?.ok_or("请使用 --path 指定文件")?;
            let media = crate::content::cli_import_media(&workspace, &path)?;
            Ok((
                serde_json::to_value(media).map_err(|e| e.to_string())?,
                true,
            ))
        }
        ("content", "list" | "save-material" | "save-article") => {
            validate_options(
                &args[2..],
                if second == "list" {
                    &["--workspace"]
                } else {
                    &["--workspace", "--input"]
                },
                &["--json"],
            )?;
            let workspace = root(&args[2..])?;
            let input = if second == "list" {
                None
            } else {
                let path = option(&args[2..], "--input")?.ok_or("请使用 --input 指定 JSON 文件")?;
                let bytes = std::fs::read(path).map_err(|e| format!("无法读取 JSON 文件：{e}"))?;
                if bytes.len() > 8_000_000 {
                    return Err("输入文件过大".into());
                }
                Some(serde_json::from_slice(&bytes).map_err(|e| format!("JSON 格式错误：{e}"))?)
            };
            Ok((
                crate::content::cli_content(&workspace, second, input)?,
                true,
            ))
        }
        ("mcp", "info") => {
            validate_options(&args[2..], &["--workspace"], &["--json"])?;
            let root = root(&args[2..])?;
            Ok((
                json!({"schema_version":1,"name":"seabird","transport":"stdio","command":binary()?,"args":["--mcp",root],"tools":["workspace_info","list_files","read_file","write_file"]}),
                true,
            ))
        }
        ("mcp", "status" | "install") => {
            let id = args.get(2).ok_or("请指定 codex 或 claude")?;
            validate_options(
                &args[3..],
                &["--workspace"],
                if second == "install" {
                    &["--json", "--dry-run"]
                } else {
                    &["--json"]
                },
            )?;
            let root = root(&args[3..])?;
            let executable = binary()?;
            let agent = agent(id)?;
            let dry = args.iter().any(|arg| arg == "--dry-run");
            let planned_args = if id == "codex" {
                vec![
                    "mcp",
                    "add",
                    "seabird",
                    "--",
                    executable.as_str(),
                    "--mcp",
                    root.as_str(),
                ]
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
                    executable.as_str(),
                    "--mcp",
                    root.as_str(),
                ]
            };
            let (mut state, mut detail) =
                setup::check_bridge(id, &agent, &executable, &root, false);
            let mut handshake = "not_checked";
            if second == "install"
                && !dry
                && matches!(state.as_str(), "not_connected" | "connected")
            {
                setup::verify_bridge(&executable, &root)?;
                handshake = "passed";
                (state, detail) = setup::check_bridge(id, &agent, &executable, &root, true);
            }
            let ok = state == "connected"
                || (dry && state == "not_connected")
                || (second == "status" && state == "not_connected");
            Ok((
                json!({"schema_version":1,"agent":id,"workspace":root,"registration":state,"detail":detail,"dry_run":dry,"plan":{"command":agent,"args":planned_args},"server_handshake":handshake,"client_tool_call":"not_checked","next_action":if state == "connected" {"在新的 Agent 会话中调用 workspace_info 验证连接"} else if state == "not_connected" {"运行 mcp install 配置连接"} else {"检查现有连接，处理冲突后重试"}}),
                ok,
            ))
        }
        ("mcp", "remove") => {
            let id = args.get(2).ok_or("请指定 codex 或 claude")?;
            validate_options(&args[3..], &[], &["--json"])?;
            setup::remove_bridge(id, &agent(id)?)?;
            Ok((
                json!({"schema_version":1,"agent":id,"registration":"removed"}),
                true,
            ))
        }
        _ => Err("未知命令，请运行 --help 查看用法".into()),
    }
}

pub fn run(args: &[String]) -> i32 {
    if args == ["--help"] || args == ["-h"] || args == ["help"] {
        println!("{HELP}");
        return 0;
    }
    if args.first().is_some_and(|s| s == "mcp") && args.get(1).is_some_and(|s| s == "serve") {
        let result = validate_options(&args[2..], &["--workspace"], &[])
            .and_then(|_| root(&args[2..]))
            .and_then(|root| crate::run_bridge(&root));
        if let Err(error) = result {
            eprintln!("{error}");
            return 1;
        }
        return 0;
    }
    match response(args) {
        Ok((value, ok)) => {
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
            if ok {
                0
            } else {
                1
            }
        }
        Err(message) => {
            eprintln!(
                "{}",
                json!({"schema_version":1,"error":{"code":"command_failed","message":message,"next_action":"检查命令参数和本机环境，运行 --help 查看用法"}})
            );
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn validates_flags_and_workspace_arguments() {
        assert!(response(&args(&["version", "--unknown"])).is_err());
        assert!(response(&args(&["mcp", "info", "--workspace"])).is_err());
        assert!(response(&args(&[
            "mcp",
            "info",
            "--workspace",
            "/tmp",
            "--workspace",
            "/tmp"
        ]))
        .is_err());
        let (info, ok) =
            response(&args(&["mcp", "info", "--workspace", "/tmp", "--json"])).unwrap();
        assert!(ok);
        assert_eq!(info["transport"], "stdio");
        assert_eq!(info["args"][0], "--mcp");
    }
}
