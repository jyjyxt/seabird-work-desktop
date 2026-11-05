<p align="center">
  <img src="src/assets/seabird.svg" alt="Seabird Logo" width="160" />
</p>

# Seabird 工作台

一个基于 React、TypeScript、Tauri 2 和 SQLite 的本地桌面工作台。Seabird 本身不提供大模型：它使用本机已有的 Codex 或 Claude Code，也可以通过 CLI 和 MCP 被外部 Agent 调用。

## 功能

- 首次启动时自动创建并使用系统文稿目录下的 `seabird` 文件夹（macOS 通常为 `~/Documents/seabird`）作为本地素材目录。可在「设置与文件」中切换目录；素材和文章按目录区分。快捷键：`⌘/Ctrl + S` 保存当前素材、文章或文件，`⌘/Ctrl + 1/2/3` 切换工作台、素材和文章。
- 在「素材」中保存标题、来源、链接、标签和备注，也可导入图片或视频。导入的文件复制到素材目录下的 `seabird-media`，素材卡片和详情可预览图片或播放受系统支持的视频格式。删除素材或移除附件不会删除本地文件。支持 PNG、JPEG、GIF、WebP、AVIF、MP4、MOV、M4V 和 WebM，单文件最多 1 GB；实际播放取决于系统编解码器。
- 在「文章」中管理原稿、关联素材及 X、公众号、小红书的独立草稿版本，也可将文章和素材交给本机 Agent 协助构思。平台发布尚未接入，平台版本可复制后手动使用。
- 在「热点发现」可通过本机已安装的 `cloudl` 读取当前登录 X 账号的热门话题并收藏为素材。需要先完成 cloudl 浏览器连接和 X 登录；热点可能因账号和地区不同而变化。
- 在「Agent」页面点击「复制配置任务」，交给外部 Codex 或 Claude Code 检查和配置自己的 MCP 连接。也可以点击「一键连接」注册全部已安装的 Agent。已有的不同 `seabird` MCP 配置不会被覆盖；出现冲突时请检查旧连接。首次配置后请在新的 Agent 会话中验证。
- 检测本机 `codex` 和 `claude` 命令。在「Agent」页面直接对话，实时查看回答和工具活动；Agent 请求操作权限或提问时，可在页面中回复。对话记录保存在应用的 SQLite 数据库中，按工作目录查看；重新打开应用后可选择历史对话继续，实际上下文由对应 Agent 的原生会话恢复。需要先安装并登录对应 CLI，且原生会话记录仍然存在。
- 在「Agent」页面可以将 Seabird 注册为 Codex 或 Claude Code 的用户级 MCP 服务。新会话可通过本地标准输入输出连接，在注册时选择的工作目录中列出、读取、创建和覆盖文本文件。连接不会开放网络端口；MCP 客户端可以修改该目录中的文件。切换工作目录或移动应用后，需先移除旧连接再重新注册。
- 内置 SQLite 数据库和 SQL 控制台，首次使用时创建 `notes` 表。每次执行一条 SQL，查询结果最多显示 500 行。数据库文件位于应用数据目录中的 `workbench.sqlite3`，其完整路径会显示在数据库页面。

## 外部 Agent 接入

打开 Seabird 的「Agent」页面，选择工作目录并点击「复制配置任务」，将任务粘贴给本机 Codex 或 Claude Code。配置成功后开启新会话，请 Agent 调用 `workspace_info` 验证；单纯注册成功或 MCP 初始化成功并不代表客户端已实际调用成功。

Seabird 桌面可执行文件也提供 CLI；页面中的复制命令包含当前安装的实际路径。在终端或交给 Agent 使用时，将下面的 `SEABIRD` 替换为该可执行文件的完整路径（路径含空格时保留引号）。不要求该程序已加入 PATH：

```sh
"SEABIRD" --help
"SEABIRD" status --json
"SEABIRD" workspace get --json
"SEABIRD" workspace set --path "/path/to/workspace" --json
"SEABIRD" agent list --json
"SEABIRD" mcp info --workspace "/path/to/workspace" --json
"SEABIRD" mcp status codex --workspace "/path/to/workspace" --json
"SEABIRD" mcp install codex --workspace "/path/to/workspace" --dry-run --json
"SEABIRD" mcp install codex --workspace "/path/to/workspace" --json
"SEABIRD" mcp remove codex --json
```

将 `codex` 换成 `claude` 可配置 Claude Code。安装仅修改指定 Agent；预览和状态检查不写入其配置。命令输出 JSON，失败返回非零退出状态。`workspace set` 更新下次启动的默认目录，不会切换已打开的窗口或已注册的 MCP。登录状态来自各自 CLI 的探测，认证是否有效仍需实际发起请求验证。

标准 MCP 客户端可通过 `mcp info` 获取 stdio 的 `command` 和 `args`。Seabird MCP 提供工作目录信息和文件列出、读取、创建、覆盖操作；当前不提供数据库操作。随仓库提供的 [Seabird Skill](skills/seabird/SKILL.md) 可帮助支持 Skills 的 Agent 发现 CLI；不安装 Skill 也可使用命令和 MCP。

旧的 `--setup [--workspace <目录>]` 和 `--mcp <目录>` 仍可用。`--setup` 检查本地 MCP 握手并配置全部已安装的 Codex 和 Claude Code，出现未登录、配置冲突或检查失败时返回非零退出状态。

Agent 每轮通过本机 CLI 执行：Codex 使用 App Server，Claude Code 使用流式 JSON 控制接口。支持 Codex 的命令、文件及额外权限审批和用户提问，以及 Claude Code 的工具审批和 AskUserQuestion。其他类型的交互请求会显示为不支持，无法在界面中完成；请停止任务并检查 Agent 版本或配置。权限策略和可用能力仍由各自的 Agent 和用户配置决定。CLI 版本变化可能影响协议兼容性。

工作目录之外的文件不能通过编辑器访问；符号链接不会出现在文件树中。`.git`、`node_modules` 和 `target` 目录默认隐藏。

## 数据与备份

数据库保存在系统的应用数据目录，不在素材目录中；在「设置与文件 → 数据库工具」可查看完整路径。连接配置保存在系统配置目录。macOS/Linux 上应用数据和配置目录使用仅当前用户可访问的权限，数据库和配置文件使用 `0600`；Windows 使用系统继承的访问控制。数据没有由 Seabird 额外加密。

数据库快照和 Seabird 连接配置备份保存在独立的 `com.seabird.workbench-backups` 应用数据目录，路径显示在「设置与文件」中。保存内容会更新数据库最新快照，并保留每天首次快照；删除素材、文章或执行修改数据库的 SQL 前会额外保存删除前快照。配置变化时会更新配置备份。备份失败会在保存内容时提示；删除内容前无法备份时会停止删除。备份位于同一台设备，不能替代设备级或异地备份；它不包含素材目录中的图片和视频，请另外备份素材目录。

需要手动恢复时，先关闭 Seabird，完整复制现有应用数据目录作为保留；将选定的数据库快照复制为应用数据目录中的 `workbench.sqlite3`。如果原目录中有同名数据库的 `-wal` 或 `-shm` 文件，应先和原数据库一起移到保留副本中，再放入快照。连接配置可将 `connections-latest.json` 复制为系统配置目录中的 `connections.json`。不要在应用运行时覆盖这些文件。

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
