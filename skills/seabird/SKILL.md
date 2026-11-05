---
name: seabird
description: 使用本机 Seabird 工作台，检查工作目录或为 Codex、Claude Code 配置 Seabird MCP 时使用。
---

# Seabird

Seabird 是本地工作台；Agent 负责执行任务。它的桌面程序同时提供 CLI 和 MCP。安装路径由用户或 Seabird 的「Agent → 复制配置任务」提供，不要猜测路径。CLI 不一定在 PATH 中，路径包含空格时需要正确引用。

先运行当前安装的 Seabird 可执行文件并传入 `--help`，再按其帮助选择命令。需要机器可读输出时使用 `--json`。检查目标工作目录和当前 Agent；配置 MCP 时先检查状态或使用 `--dry-run`，只修改用户要求的 Agent，保留其他配置。遇到同名冲突时解释现状，不自行覆盖。配置完成后在新 Agent 会话中调用 `workspace_info` 验证；注册成功或服务端握手成功不代表客户端调用已验证。

MCP 目前只提供工作目录信息及文本文件操作；不要假设它可以操作数据库或控制桌面界面。需要登录时由用户完成登录，遵循当前 Agent 的权限规则。
