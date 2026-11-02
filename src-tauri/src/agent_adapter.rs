//! Translate the native CLI JSONL streams into the workbench's small event model.
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub enum Event {
    Session(String),
    Output(String),
    Failure(String),
}

pub fn args(id: &str, session: Option<&str>) -> Result<Vec<String>, String> {
    if let Some(value) = session {
        if !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
            || value.len() > 128
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("会话标识无效".into());
        }
    }
    let values: Vec<&str> = match (id, session) {
        ("codex", Some(s)) => vec!["exec", "resume", "--json", "--skip-git-repo-check", s, "-"],
        ("codex", None) => vec!["exec", "--json", "--skip-git-repo-check", "-"],
        ("claude", Some(s)) => vec![
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--resume",
            s,
        ],
        ("claude", None) => vec!["--print", "--output-format", "stream-json", "--verbose"],
        _ => return Err("不支持的 Agent".into()),
    };
    Ok(values.into_iter().map(str::to_owned).collect())
}

pub fn parse(id: &str, line: &str) -> Vec<Event> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return vec![Event::Output(format!("{line}\n"))];
    };
    let kind = value["type"].as_str().unwrap_or_default();
    let mut events = Vec::new();
    if id == "codex" {
        if kind == "thread.started" {
            if let Some(session) = value["thread_id"].as_str() {
                events.push(Event::Session(session.into()));
            }
        } else if kind == "item.completed" {
            let item = &value["item"];
            match item["type"].as_str().unwrap_or_default() {
                "agent_message" => {
                    if let Some(text) = item["text"].as_str() {
                        events.push(Event::Output(format!("{text}\n")));
                    }
                }
                "command_execution" => events.push(Event::Output(format!(
                    "[命令] {}\n",
                    item["command"].as_str().unwrap_or_default()
                ))),
                "file_change" => events.push(Event::Output("[文件已更新]\n".into())),
                "mcp_tool_call" => events.push(Event::Output(format!(
                    "[工具] {}\n",
                    item["tool"].as_str().unwrap_or_default()
                ))),
                _ => {}
            }
        } else if kind == "turn.failed" || kind == "error" {
            let message = value["error"]["message"]
                .as_str()
                .or_else(|| value["message"].as_str())
                .unwrap_or("Codex 执行失败");
            events.push(Event::Failure(message.into()));
        }
    } else if id == "claude" {
        if kind == "system" && value["subtype"] == "init" {
            if let Some(session) = value["session_id"].as_str() {
                events.push(Event::Session(session.into()));
            }
        } else if kind == "assistant" && value["parent_tool_use_id"].is_null() {
            if let Some(blocks) = value["message"]["content"].as_array() {
                for block in blocks {
                    match block["type"].as_str().unwrap_or_default() {
                        "text" => {
                            if let Some(text) = block["text"].as_str() {
                                events.push(Event::Output(format!("{text}\n")));
                            }
                        }
                        "tool_use" => events.push(Event::Output(format!(
                            "[工具] {}\n",
                            block["name"].as_str().unwrap_or_default()
                        ))),
                        _ => {}
                    }
                }
            }
        } else if kind == "result" && value["is_error"].as_bool() == Some(true) {
            events.push(Event::Failure(
                value["result"]
                    .as_str()
                    .unwrap_or("Claude Code 执行失败")
                    .into(),
            ));
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sessions_and_messages_from_both_protocols() {
        assert_eq!(
            parse(
                "codex",
                r#"{"type":"thread.started","thread_id":"abc-123"}"#
            ),
            vec![Event::Session("abc-123".into())]
        );
        assert_eq!(
            parse(
                "codex",
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"你好"}}"#
            ),
            vec![Event::Output("你好\n".into())]
        );
        assert_eq!(
            parse(
                "claude",
                r#"{"type":"system","subtype":"init","session_id":"abc-123"}"#
            ),
            vec![Event::Session("abc-123".into())]
        );
        assert_eq!(
            parse(
                "claude",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"完成"}]}}"#
            ),
            vec![Event::Output("完成\n".into())]
        );
        assert!(matches!(
            parse(
                "claude",
                r#"{"type":"result","is_error":true,"result":"failed"}"#
            )
            .as_slice(),
            [Event::Failure(_)]
        ));
    }
    #[test]
    fn resume_uses_explicit_id_and_rejects_flags() {
        assert_eq!(
            args("codex", Some("abc-123")).unwrap(),
            [
                "exec",
                "resume",
                "--json",
                "--skip-git-repo-check",
                "abc-123",
                "-"
            ]
        );
        assert!(args("claude", Some("--dangerous")).is_err());
    }
}
