<p align="center">
  <img src="src/assets/seabird.svg" alt="Seabird Logo" width="160" />
</p>

# Seabird 工作台

一个基于 React、TypeScript、Tauri 2 和 SQLite 的本地桌面工作台。

## 功能

- 首次启动时自动创建并使用系统文稿目录下的 `seabird` 文件夹（macOS 通常为 `~/Documents/seabird`）作为工作目录。可随时切换到其他本地文件夹，应用会记住你的选择。浏览目录中的文件，打开和保存最大 2 MB 的 UTF-8 文本文件。快捷键：`⌘/Ctrl + S` 保存，`⌘/Ctrl + 1/2/3` 切换页面。
- 在「Agent」页面点击「一键连接本机 Agent」，或从该页面复制 `--setup` 命令交给已安装的 Agent 执行。Seabird 会检测 Codex 和 Claude Code，读取现有登录状态，检查本地 MCP 握手，并为已安装的 Agent 注册 MCP。已有的不同 `seabird` MCP 配置不会被覆盖；显示冲突时，请确认并移除旧连接后重试。首次配置或切换目录后，请新建 Agent 会话。
- 检测本机 `codex` 和 `claude` 命令。在「Agent」页面使用所选工具执行任务，并在当前会话中继续对话。Seabird 解析 CLI 的结构化输出，通过原生会话 ID 续接上下文；新建对话、切换 Agent 或工作目录会开始新会话。工具使用各自已有的登录状态和权限配置；它们需要交互式审批时，非交互任务可能失败或无法继续。Seabird 不保存对话列表，关闭应用后无法从界面恢复会话；CLI 本身可能保存会话记录。
- 在「Agent」页面可以将 Seabird 注册为 Codex 或 Claude Code 的用户级 MCP 服务。新会话可通过本地标准输入输出连接，在注册时选择的工作目录中列出、读取、创建和覆盖文本文件。连接不会开放网络端口；MCP 客户端可以修改该目录中的文件。切换工作目录或移动应用后，需先移除旧连接再重新注册。
- 内置 SQLite 数据库和 SQL 控制台，首次使用时创建 `notes` 表。每次执行一条 SQL，查询结果最多显示 500 行。数据库文件位于应用数据目录中的 `workbench.sqlite3`，其完整路径会显示在数据库页面。

从终端也可运行 Seabird 可执行文件并附加 `--setup`；使用 `--workspace <文件夹路径>` 可指定工作目录。命令会输出每个 Agent 的配置结果；出现未登录、配置冲突或检查失败时返回非零退出状态。Agent 的认证是否有效仍需实际发起请求验证。

Agent 每轮通过各自的 CLI 执行，并使用 CLI 的原生会话续接；当前没有接入交互式审批或 ACP。Codex 的 JSON 输出按完整消息显示，Claude Code 的输出按完整内容块显示。

工作目录之外的文件不能通过编辑器访问；符号链接不会出现在文件树中。`.git`、`node_modules` 和 `target` 目录默认隐藏。

## 开发

需要 Node.js、npm、Rust，以及 [Tauri 2 对应系统的前置依赖](https://v2.tauri.app/start/prerequisites/)（Linux 还需要 WebKitGTK 等系统库）。

```bash
git clone git@github-jyjyxt:jyjyxt/seabird-work-desktop.git
cd seabird-work-desktop
npm install
npm run tauri dev
```

这里的 `github-jyjyxt` 使用本机已配置的 `jyjyxt` SSH 身份；在其他设备上，请先为该账号配置 SSH 主机别名。

开发模式下，修改 `src/` 中的 React、TypeScript 或 CSS 并保存后，界面会自动更新；修改 `src-tauri/` 中的 Rust 代码后，应用会重新编译并启动。

只预览界面可运行 `npm run dev`，本地文件、AI 工具和数据库功能需要在 Tauri 桌面应用内使用。

## 打包

```bash
npm run tauri build
```

请分别在目标 macOS、Windows 和 Linux 系统上构建和验证对应安装包。macOS 首次启动助手时可能需要授权 Seabird 控制「终端」；Linux 需要安装支持的终端模拟器。工具必须已经安装，并能在系统 PATH 中找到；macOS/Linux 使用登录 shell 检测命令。
