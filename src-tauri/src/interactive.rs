//! Per-turn interactive transports for the installed Codex and Claude Code CLIs.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct Processes(pub Mutex<HashMap<String, Arc<Run>>>);
pub struct Run {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, Pending>>,
}
#[derive(Clone)]
struct Pending {
    id: Value,
    method: String,
    params: Value,
}
#[derive(Clone, serde::Serialize)]
struct Event {
    run_id: String,
    kind: String,
    text: String,
}
fn emit(app: &tauri::AppHandle, run: &str, kind: &str, text: impl Into<String>) {
    let _ = app.emit(
        "agent-event",
        Event {
            run_id: run.into(),
            kind: kind.into(),
            text: text.into(),
        },
    );
}
fn send(run: &Run, value: Value) -> Result<(), String> {
    let mut input = run.input.lock().map_err(|_| "Agent 输入不可用")?;
    writeln!(input, "{}", value)
        .and_then(|_| input.flush())
        .map_err(|e| format!("无法发送给 Agent：{e}"))
}
fn prompt_request(
    app: &tauri::AppHandle,
    run_id: &str,
    run: &Run,
    id: Value,
    method: &str,
    params: Value,
) {
    let key = id.to_string();
    if let Ok(mut pending) = run.pending.lock() {
        pending.insert(
            key.clone(),
            Pending {
                id,
                method: method.into(),
                params: params.clone(),
            },
        );
    }
    emit(
        app,
        run_id,
        "request",
        json!({"key":key,"method":method,"params":params}).to_string(),
    );
}

#[tauri::command]
pub fn start_interactive(
    app: tauri::AppHandle,
    processes: State<'_, Processes>,
    root: String,
    id: String,
    prompt: String,
    run_id: String,
    session_id: Option<String>,
) -> Result<(), String> {
    if prompt.trim().is_empty() || prompt.len() > 200_000 || run_id.is_empty() || run_id.len() > 128
    {
        return Err("任务内容或标识无效".into());
    }
    let root = std::fs::canonicalize(root).map_err(|e| format!("无法打开工作目录：{e}"))?;
    if !root.is_dir() {
        return Err("请选择工作目录".into());
    }
    if let Some(s) = &session_id {
        if s.is_empty()
            || s.len() > 128
            || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("会话标识无效".into());
        }
    }
    let executable = super::find_agent(&id).ok_or_else(|| format!("未找到 {id}，请先安装"))?;
    let mut cmd = Command::new(executable);
    match id.as_str() {
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
            if let Some(s) = &session_id {
                cmd.args(["--resume", s]);
            }
        }
        _ => return Err("不支持的 Agent".into()),
    }
    // Give each run its own process group so stopping a turn also stops its children.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 {id}：{e}"))?;
    let input = child.stdin.take().ok_or("无法打开 Agent 输入")?;
    let stdout = child.stdout.take().ok_or("无法读取 Agent 输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 Agent 错误输出")?;
    let run = Arc::new(Run {
        child: Mutex::new(child),
        input: Mutex::new(input),
        pending: Mutex::new(HashMap::new()),
    });
    {
        let mut running = processes.0.lock().map_err(|_| "无法记录 Agent 任务")?;
        if running.contains_key(&run_id) {
            let _ = run.child.lock().map(|mut c| c.kill());
            return Err("任务标识已存在".into());
        }
        running.insert(run_id.clone(), run.clone());
    }
    let setup = if id == "codex" {
        send(
            &run,
            json!({"id":0,"method":"initialize","params":{"clientInfo":{"name":"seabird","version":"0.1.0"},"capabilities":{}}}),
        )
    } else {
        send(&run, json!({"type":"control_request","request_id":"init","request":{"subtype":"initialize"}})).and_then(|_| send(&run, json!({"type":"user","session_id":"","message":{"role":"user","content":prompt}})))
    };
    if let Err(e) = setup {
        let _ = run.child.lock().map(|mut c| c.kill());
        if let Ok(mut r) = processes.0.lock() {
            r.remove(&run_id);
        }
        return Err(e);
    }
    thread::spawn(move || {
        let err_app = app.clone();
        let err_id = run_id.clone();
        let errors = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    emit(&err_app, &err_id, "activity", format!("{line}\n"));
                }
            }
        });
        let mut complete = false;
        let mut failure = None;
        let mut claude_streamed = false;
        let mut items: HashMap<String, Value> = HashMap::new();
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(v) => v,
                Err(e) => {
                    failure = Some(format!("读取 Agent 输出失败：{e}"));
                    break;
                }
            };
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if id == "codex" {
                if v.get("id").is_some() && v.get("method").is_none() {
                    if let Some(e) = v.get("error") {
                        failure = Some(format!(
                            "Codex 错误：{}",
                            e.get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("请求失败")
                        ));
                        break;
                    }
                    match v["id"].as_i64() {
                        Some(0) => {
                            let _ = send(&run, json!({"method":"initialized","params":{}}));
                            let p = if let Some(s) = &session_id {
                                json!({"threadId":s,"cwd":root})
                            } else {
                                json!({"cwd":root})
                            };
                            let method = if session_id.is_some() {
                                "thread/resume"
                            } else {
                                "thread/start"
                            };
                            if let Err(e) = send(&run, json!({"id":1,"method":method,"params":p})) {
                                failure = Some(e);
                                break;
                            }
                        }
                        Some(1) => {
                            if let Some(s) = v["result"]["thread"]["id"].as_str() {
                                emit(&app, &run_id, "session", s);
                                if let Err(e) = send(
                                    &run,
                                    json!({"id":2,"method":"turn/start","params":{"threadId":s,"input":[{"type":"text","text":prompt}]}}),
                                ) {
                                    failure = Some(e);
                                    break;
                                }
                            } else {
                                failure = Some("Codex 没有返回会话标识".into());
                                break;
                            }
                        }
                        _ => {}
                    }
                } else if let Some(method) = v["method"].as_str() {
                    let mut p = v.get("params").cloned().unwrap_or(json!({}));
                    if let Some(request_id) = v.get("id") {
                        if let Some(item_id) = p["itemId"].as_str() {
                            if let Some(item) = items.get(item_id) {
                                if let Some(obj) = p.as_object_mut() {
                                    obj.insert("item".into(), item.clone());
                                }
                            }
                        }
                        prompt_request(&app, &run_id, &run, request_id.clone(), method, p);
                        continue;
                    }
                    match method {
                        "item/agentMessage/delta" => {
                            if let Some(t) = p["delta"].as_str() {
                                emit(&app, &run_id, "output", t);
                            }
                        }
                        "item/commandExecution/outputDelta" => {
                            if let Some(t) = p["delta"].as_str() {
                                emit(&app, &run_id, "activity", t);
                            }
                        }
                        "item/started" => {
                            let item = &p["item"];
                            if let Some(item_id) = item["id"].as_str() {
                                items.insert(item_id.into(), item.clone());
                            }
                            let typ = item["type"].as_str().unwrap_or("");
                            if typ != "agentMessage" && typ != "reasoning" {
                                let detail = item["command"]
                                    .as_str()
                                    .or_else(|| item["tool"].as_str())
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| {
                                        if typ == "fileChange" {
                                            item["changes"].to_string()
                                        } else {
                                            String::new()
                                        }
                                    });
                                emit(&app, &run_id, "activity", format!("\n[{typ}] {detail}\n"));
                            }
                        }
                        "serverRequest/resolved" => {
                            let key = p["requestId"].to_string();
                            if let Ok(mut pending) = run.pending.lock() {
                                pending.remove(&key);
                            }
                            emit(&app, &run_id, "request_resolved", key);
                        }
                        "turn/completed" => {
                            let status = p["turn"]["status"].as_str().unwrap_or("");
                            if status != "completed" {
                                failure = Some(format!(
                                    "本轮{}：{}",
                                    status,
                                    p["turn"]["error"]["message"].as_str().unwrap_or("")
                                ));
                            }
                            complete = true;
                            break;
                        }
                        _ => {}
                    }
                }
            } else {
                match v["type"].as_str().unwrap_or("") {
                    "system" if v["subtype"] == "init" => {
                        if let Some(s) = v["session_id"].as_str() {
                            emit(&app, &run_id, "session", s);
                        }
                    }
                    "control_request" => {
                        let p = v["request"].clone();
                        prompt_request(
                            &app,
                            &run_id,
                            &run,
                            v["request_id"].clone(),
                            p["subtype"].as_str().unwrap_or("unknown"),
                            p.clone(),
                        );
                    }
                    "control_cancel_request" => {
                        let key = v["request_id"].to_string();
                        if let Ok(mut pending) = run.pending.lock() {
                            pending.remove(&key);
                        }
                        emit(&app, &run_id, "request_resolved", key);
                    }
                    "control_response" if v["response"]["subtype"] == "error" => {
                        failure = Some(
                            v["response"]["error"]
                                .as_str()
                                .unwrap_or("Claude 初始化失败")
                                .into(),
                        );
                        break;
                    }
                    "stream_event" => {
                        let event = &v["event"];
                        if event["type"] == "content_block_delta"
                            && event["delta"]["type"] == "text_delta"
                        {
                            if let Some(t) = event["delta"]["text"].as_str() {
                                claude_streamed = true;
                                emit(&app, &run_id, "output", t);
                            }
                        }
                    }
                    "assistant" if v["parent_tool_use_id"].is_null() => {
                        if let Some(blocks) = v["message"]["content"].as_array() {
                            for b in blocks {
                                match b["type"].as_str() {
                                    Some("text") if !claude_streamed => {
                                        if let Some(t) = b["text"].as_str() {
                                            emit(&app, &run_id, "output", t);
                                        }
                                    }
                                    Some("tool_use") => emit(
                                        &app,
                                        &run_id,
                                        "activity",
                                        format!("\n[工具] {}\n", b["name"].as_str().unwrap_or("")),
                                    ),
                                    _ => {}
                                }
                            }
                            claude_streamed = false;
                        }
                    }
                    "result" => {
                        if v["is_error"].as_bool() == Some(true) {
                            failure =
                                Some(v["result"].as_str().unwrap_or("Claude 执行失败").into());
                        }
                        complete = true;
                        break;
                    }
                    _ => {}
                }
            }
        }
        // A turn is complete; terminate the transport. Native history is owned by the CLI.
        if let Ok(mut child) = run.child.lock() {
            terminate(&mut child);
            let _ = child.wait();
        }
        let _ = errors.join();
        if let Ok(mut running) = app.state::<Processes>().0.lock() {
            running.remove(&run_id);
        }
        if let Some(e) = failure {
            emit(&app, &run_id, "error", e);
        } else if complete {
            emit(&app, &run_id, "done", "本轮完成");
        } else {
            emit(
                &app,
                &run_id,
                "error",
                "Agent 连接已结束，请检查登录状态和版本。",
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn respond_interactive(
    processes: State<'_, Processes>,
    run_id: String,
    key: String,
    action: String,
    answers: HashMap<String, String>,
) -> Result<(), String> {
    let run = processes
        .0
        .lock()
        .map_err(|_| "任务不可用")?
        .get(&run_id)
        .cloned()
        .ok_or("任务已经结束")?;
    let mut pending = run.pending.lock().map_err(|_| "请求不可用")?;
    let request = pending.get(&key).cloned().ok_or("请求已结束或已处理")?;
    let response = build_response(&request, &action, answers)?;
    send(&run, response)?;
    pending.remove(&key);
    Ok(())
}
fn build_response(
    request: &Pending,
    action: &str,
    answers: HashMap<String, String>,
) -> Result<Value, String> {
    let allow = action == "allow";
    if !allow && action != "deny" {
        return Err("无效的选择".into());
    }
    let response = if request.method == "can_use_tool" {
        let mut input = request.params["input"].clone();
        if request.params["tool_name"] == "AskUserQuestion" && allow {
            let map: serde_json::Map<String, Value> = answers
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            if let Some(obj) = input.as_object_mut() {
                obj.insert("answers".into(), Value::Object(map));
            }
        }
        let decision = if allow {
            json!({"behavior":"allow","updatedInput":input,"toolUseID":request.params["tool_use_id"]})
        } else {
            json!({"behavior":"deny","message":"用户拒绝了请求"})
        };
        json!({"type":"control_response","response":{"subtype":"success","request_id":request.id,"response":decision}})
    } else if request.method == "item/tool/requestUserInput" {
        let map: serde_json::Map<String, Value> = if allow {
            answers
                .into_iter()
                .map(|(k, v)| (k, json!({"answers":[v]})))
                .collect()
        } else {
            serde_json::Map::new()
        };
        json!({"id":request.id,"result":{"answers":map}})
    } else if request.method == "item/commandExecution/requestApproval"
        || request.method == "item/fileChange/requestApproval"
    {
        let offered = request.params["availableDecisions"].as_array();
        let accepts =
            |value: &str| offered.is_none_or(|choices| choices.iter().any(|v| v == value));
        let decision = if allow && accepts("accept") {
            "accept"
        } else if !allow && accepts("decline") {
            "decline"
        } else if !allow && accepts("cancel") {
            "cancel"
        } else {
            return Err("此请求不支持该选择".into());
        };
        json!({"id":request.id,"result":{"decision":decision}})
    } else if request.method == "item/permissions/requestApproval" {
        json!({"id":request.id,"result":{"permissions":if allow {request.params["permissions"].clone()} else {json!({})},"scope":"turn"}})
    } else {
        return Err(format!("暂不支持此请求：{}", request.method));
    };
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(method: &str, params: Value) -> Pending {
        Pending {
            id: json!(42),
            method: method.into(),
            params,
        }
    }
    #[test]
    fn codex_approval_respects_the_requested_scope() {
        let p = request(
            "item/commandExecution/requestApproval",
            json!({"availableDecisions":["accept","decline"]}),
        );
        assert_eq!(
            build_response(&p, "allow", HashMap::new()).unwrap()["result"]["decision"],
            "accept"
        );
        assert_eq!(
            build_response(&p, "deny", HashMap::new()).unwrap()["result"]["decision"],
            "decline"
        );
        let restricted = request(
            "item/commandExecution/requestApproval",
            json!({"availableDecisions":["decline"]}),
        );
        assert!(build_response(&restricted, "allow", HashMap::new()).is_err());
        let p = request(
            "item/permissions/requestApproval",
            json!({"permissions":{"network":{"enabled":true}}}),
        );
        assert_eq!(
            build_response(&p, "deny", HashMap::new()).unwrap()["result"]["permissions"],
            json!({})
        );
        assert_eq!(
            build_response(&p, "allow", HashMap::new()).unwrap()["result"]["permissions"],
            p.params["permissions"]
        );
    }
    #[test]
    fn questions_are_encoded_for_each_agent() {
        let answers = HashMap::from([("q1".into(), "Yes".into())]);
        let p = request("item/tool/requestUserInput", json!({}));
        assert_eq!(
            build_response(&p, "allow", answers.clone()).unwrap()["result"]["answers"]["q1"]
                ["answers"],
            json!(["Yes"])
        );
        assert_eq!(
            build_response(&p, "deny", answers.clone()).unwrap()["result"]["answers"],
            json!({})
        );
        let p = request(
            "can_use_tool",
            json!({"tool_name":"AskUserQuestion","tool_use_id":"tool-1","input":{"questions":[{"question":"q1"}]}}),
        );
        let result = build_response(&p, "allow", answers).unwrap();
        assert_eq!(
            result["response"]["response"]["updatedInput"]["answers"]["q1"],
            "Yes"
        );
        assert_eq!(result["response"]["response"]["toolUseID"], "tool-1");
        assert_eq!(
            build_response(&p, "deny", HashMap::new()).unwrap()["response"]["response"]["behavior"],
            "deny"
        );
        assert!(build_response(&request("unknown", json!({})), "allow", HashMap::new()).is_err());
    }
}
#[tauri::command]
pub fn stop_interactive(processes: State<'_, Processes>, run_id: String) -> Result<(), String> {
    let run = processes
        .0
        .lock()
        .map_err(|_| "任务不可用")?
        .get(&run_id)
        .cloned()
        .ok_or("任务已经结束")?;
    let mut child = run.child.lock().map_err(|_| "无法停止任务")?;
    terminate(&mut child);
    Ok(())
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        // The group was created at spawn and the child has not yet been reaped.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill();
}
