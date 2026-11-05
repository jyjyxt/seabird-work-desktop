import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { ArrowUpRight, Bookmark, Bot, Braces, ChevronDown, ChevronRight, Compass, Database, FileCode2, FileText, Folder, FolderOpen, HardDrive, Layers2, PanelLeft, Play, RefreshCw, Save, Send, X } from 'lucide-react';
import seabirdLogo from './assets/seabird.svg';
import './styles.css';
import ContentWorkspace, { type ContentView } from './ContentWorkspace';

type Entry = { name: string; path: string; is_dir: boolean };
type Agent = { id: string; path: string | null };
type Result = { columns: string[]; rows: string[][]; message: string };
type View = ContentView | 'agent' | 'files' | 'database' | 'settings';
type AgentEvent = { run_id: string; kind: 'output' | 'activity' | 'session' | 'request' | 'request_resolved' | 'done' | 'error'; text: string };
type Conversation = { id: string; agent: string; sessionId: string; output: string; title: string };
type AgentRequest = { key: string; method: string; params: Record<string, any> };
type Question = { id: string; label: string; options: string[]; multiple: boolean; secret: boolean };
function requestQuestions(request: AgentRequest): Question[] {
  const raw = request.method === 'can_use_tool' ? request.params.input?.questions : request.params.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((q: any) => ({ id: request.method === 'can_use_tool' ? String(q.question || '') : String(q.id || ''), label: String(q.question || q.header || ''), options: Array.isArray(q.options) ? q.options.map((o: any) => String(o.label || o)) : [], multiple: !!q.multiSelect, secret: !!q.isSecret })).filter((q: Question) => q.id && q.label);
}

type AgentSetup = { id: string; path: string | null; version: string | null; auth: string; bridge: string; detail: string };
type SetupReport = { workspace: string; agents: AgentSetup[]; ok: boolean };
const agentInfo: Record<string, { name: string; description: string; mark: string; color: string }> = {
  codex: { name: 'Codex', description: 'OpenAI 的编程助手', mark: '✳', color: 'mint' },
  claude: { name: 'Claude Code', description: 'Anthropic 的编程助手', mark: '✦', color: 'peach' },
};
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const errorText = (e: unknown) => String(e);

function App() {
  const [view, setView] = useState<View>('home');
  const [root, setRoot] = useState(() => localStorage.getItem('seabird-root') || '');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [entries, setEntries] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [rootExpanded, setRootExpanded] = useState(false);
  const [file, setFile] = useState('');
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [sql, setSql] = useState('SELECT * FROM notes ORDER BY created_at DESC;');
  const [result, setResult] = useState<Result | null>(null);
  const [dbPath, setDbPath] = useState('');
  const [backupPath, setBackupPath] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('codex');
  const [prompt, setPrompt] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const conversationsRef = useRef<Conversation[]>([]);
  const [conversationId, setConversationId] = useState('');
  const conversationIdRef = useRef('');
  const rootRef = useRef(root);
  const pendingSaves = useRef(new Map<string, { root: string; conversation: Conversation }>());
  const saving = useRef(false);
  const [requests, setRequests] = useState<AgentRequest[]>([]);
  const request = requests[0] || null;
  const supportedRequest = !!request && ['can_use_tool', 'item/tool/requestUserInput', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(request.method);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [responding, setResponding] = useState(false);
  useEffect(() => { setAnswers({}); }, [request?.key]);
  const currentConversation = conversations.find(c => c.id === conversationId);
  const agentOutput = currentConversation?.output || '';
  const sessionId = currentConversation?.sessionId || '';
  const setCurrentId = (id: string) => { conversationIdRef.current = id; setConversationId(id); };
  const updateConversation = (id: string, fn: (conversation: Conversation) => Conversation) => {
    const old = conversationsRef.current.find(c => c.id === id);
    if (!old) return;
    const next = fn(old);
    conversationsRef.current = conversationsRef.current.map(c => c.id === id ? next : c);
    setConversations(conversationsRef.current);
    const workspace = rootRef.current;
    pendingSaves.current.set(`${workspace}\0${next.id}`, { root: workspace, conversation: next });
    if (!saving.current) {
      saving.current = true;
      void (async () => {
        try {
          while (pendingSaves.current.size) {
            const key = pendingSaves.current.keys().next().value as string;
            const item = pendingSaves.current.get(key)!;
            pendingSaves.current.delete(key);
            try { await invoke<void>('save_conversation', item); } catch (error) { fail(error); }
          }
        } finally { saving.current = false; }
      })();
    }
  };
  const [agentRunning, setAgentRunning] = useState(false);
  const [stoppingAgent, setStoppingAgent] = useState(false);
  const stopRequested = useRef(false);
  const [agentEventsReady, setAgentEventsReady] = useState(false);
  const [registering, setRegistering] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [setupReport, setSetupReport] = useState<SetupReport | null>(null);
  const [setupCommand, setSetupCommand] = useState('');
  const activeRun = useRef('');
  const contentDirty = useRef(false);
  const contentBusy = useRef(false);
  const setContentDirty = useCallback((value: boolean) => { contentDirty.current = value; }, []);
  const setContentBusy = useCallback((value: boolean) => { contentBusy.current = value; }, []);
  const desktop = isTauri();
  const macOS = desktop && /Mac/i.test(navigator.platform);
  const dirty = content !== saved;
  useEffect(() => { if (view === 'files') setRootExpanded(true); }, [view]);

  const fail = (e: unknown) => setNotice(errorText(e));
  const detect = useCallback(async () => { if (!desktop) return; try { setAgents(await invoke<Agent[]>('detect_agents')); } catch (e) { fail(e); } }, [desktop]);
  const loadFolder = useCallback(async (workspace: string, path: string) => {
    const items = await invoke<Entry[]>('list_files', { root: workspace, path });
    setEntries(previous => ({ ...previous, [path]: items }));
  }, []);
  useEffect(() => { void detect(); if (desktop) { invoke<string>('database_path').then(setDbPath).catch(fail); invoke<string>('backup_path').then(setBackupPath).catch(fail); } }, [desktop, detect]);
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    const initializeWorkspace = async () => {
      try {
        const saved = await invoke<string | null>('saved_workspace');
        if (cancelled) return;
        const legacy = localStorage.getItem('seabird-root');
        const path = saved || legacy || await invoke<string>('default_workspace');
        if (cancelled) return;
        if (!saved) await invoke('remember_workspace', { root: path });
        if (cancelled) return;
        localStorage.setItem('seabird-root', path);
        setRoot(path);
      } catch (error) { if (!cancelled) fail(error); }
    };
    void initializeWorkspace();
    invoke<string>('setup_command').then(command => { if (!cancelled) setSetupCommand(command); }).catch(fail);
    return () => { cancelled = true; };
  }, [desktop]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<AgentEvent>('agent-event', event => {
      const data = event.payload;
      if (data.run_id !== activeRun.current) return;
      const current = conversationIdRef.current;
      if (data.kind === 'output' || data.kind === 'activity') updateConversation(current, c => ({ ...c, output: (c.output + data.text).slice(-500_000) }));
      else if (data.kind === 'session') updateConversation(current, c => ({ ...c, sessionId: data.text }));
      else if (data.kind === 'request') { try { const incoming = JSON.parse(data.text) as AgentRequest; setRequests(previous => previous.some(r => r.key === incoming.key) ? previous : [...previous, incoming]); } catch { setNotice('无法读取 Agent 请求'); } }
      else if (data.kind === 'request_resolved') { setRequests(previous => previous.filter(r => r.key !== data.text)); }
      else {
        updateConversation(current, c => ({ ...c, output: c.output + `\n${stopRequested.current ? '任务已停止' : data.text}\n` }));
        setRequests([]);
        stopRequested.current = false;
        setStoppingAgent(false);
        setAgentRunning(false);
        activeRun.current = '';
      }
    }).then(stop => {
      if (disposed) stop();
      else { unlisten = stop; setAgentEventsReady(true); }
    }).catch(fail);
    return () => { disposed = true; setAgentEventsReady(false); unlisten?.(); };
  }, [desktop]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const refresh = () => { invoke<SetupReport | null>('saved_setup_report').then(report => { if (!disposed) setSetupReport(report); }).catch(fail); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { disposed = true; window.removeEventListener('focus', refresh); };
  }, [desktop]);
  useEffect(() => {
    rootRef.current = root;
    if (!root || !desktop) return;
    let disposed = false;
    loadFolder(root, root).catch(fail);
    setCurrentId(''); conversationsRef.current = []; setConversations([]); setHistoryLoading(true);
    invoke<Conversation[]>('list_conversations', { root }).then(items => { if (!disposed) { conversationsRef.current = items; setConversations(items); setHistoryLoading(false); } }).catch(error => { if (!disposed) { setHistoryLoading(false); fail(error); } });
    return () => { disposed = true; };
  }, [root, desktop, loadFolder]);
  const confirmDiscard = () => !dirty || window.confirm('当前文件有未保存的修改，确定放弃吗？');
  const chooseFolder = async () => {
    if (!desktop) { setNotice('请在桌面应用中选择本地文件夹。'); return; }
    if (agentRunning || connecting) { setNotice('正在执行任务或连接 Agent，请结束后再切换目录。'); return; }
    if (contentBusy.current) { setNotice('正在保存内容或导入文件，请完成后再切换目录。'); return; }
    if (!confirmDiscard()) return;
    if (contentDirty.current && !window.confirm('素材或文章有未保存的修改，切换目录将丢失这些修改，确定继续吗？')) return;
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择工作目录' });
      if (typeof selected === 'string') { await invoke('remember_workspace', { root: selected }); if (selected !== root) { setCurrentId(''); setRequests([]); } setRoot(selected); localStorage.setItem('seabird-root', selected); setEntries({}); setExpanded({}); setFile(''); setContent(''); setSaved(''); setSetupReport(null); setNotice(''); }
    } catch (e) { fail(e); }
  };
  const openFile = async (path: string) => {
    if (path === file) { setView('files'); return; }
    if (!confirmDiscard()) return;
    try { const text = await invoke<string>('read_file', { root, path }); setFile(path); setContent(text); setSaved(text); setView('files'); setNotice(''); } catch (e) { fail(e); }
  };
  const save = async () => { if (!file) return; try { await invoke('write_file', { root, path: file, content }); setSaved(content); setNotice('文件已保存'); } catch (e) { fail(e); } };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (!(event.metaKey || event.ctrlKey)) return; if (event.key.toLowerCase() === 's' && file && view === 'files') { event.preventDefault(); void save(); } else if (['1', '2', '3'].includes(event.key)) { event.preventDefault(); setView(({ '1': 'home', '2': 'materials', '3': 'articles' } as const)[event.key as '1' | '2' | '3']); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  const toggleFolder = async (path: string) => { if (!expanded[path]) { try { await loadFolder(root, path); } catch (e) { fail(e); return; } } setExpanded(p => ({ ...p, [path]: !p[path] })); };
  const chooseAgent = (id: string) => {
    if (agentRunning || id === selectedAgent) return;
    setSelectedAgent(id); setCurrentId(''); setRequests([]);
  };
  const runAgent = async () => {
    if (!root || !prompt.trim() || agentRunning) return;
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let conversation = conversationsRef.current.find(c => c.id === conversationIdRef.current);
    if (!conversation) {
      conversation = { id: runId, agent: selectedAgent, sessionId: '', output: '', title: prompt.trim().slice(0, 40) };
      conversationsRef.current = [conversation, ...conversationsRef.current];
      setConversations(conversationsRef.current); setCurrentId(conversation.id);
    }
    const current = conversation;
    activeRun.current = runId; stopRequested.current = false;
    const task = prompt.trim();
    updateConversation(current.id, c => ({ ...c, output: `${c.output}${c.output ? '\n' : ''}你：${task}\n\n${agentInfo[c.agent].name}：\n`.slice(-500_000) }));
    setAgentRunning(true);
    try { await invoke('start_interactive', { root, id: current.agent, prompt: task, runId, sessionId: current.sessionId || null }); setPrompt(''); }
    catch (e) { if (activeRun.current === runId) { activeRun.current = ''; setAgentRunning(false); } updateConversation(current.id, c => ({ ...c, output: c.output + `\n启动失败：${errorText(e)}\n` })); fail(e); }
  };
  const respondToAgent = async (action: 'allow' | 'deny') => {
    if (!request || responding) return;
    const questions = requestQuestions(request);
    if (action === 'allow' && questions.some(q => !answers[q.id]?.trim())) { setNotice('请回答每个问题'); return; }
    setResponding(true);
    try { await invoke('respond_interactive', { runId: activeRun.current, key: request.key, action, answers }); setRequests(previous => previous.filter(r => r.key !== request.key)); setAnswers({}); }
    catch (e) { fail(e); }
    finally { setResponding(false); }
  };
  const stopAgent = async () => {
    if (!activeRun.current || stoppingAgent) return;
    stopRequested.current = true;
    setStoppingAgent(true);
    try { await invoke('stop_interactive', { runId: activeRun.current }); }
    catch (e) { stopRequested.current = false; setStoppingAgent(false); fail(e); }
  };
  const connectAgents = async () => {
    if (!root || connecting) return;
    setConnecting(true);
    setNotice('');
    try {
      const report = await invoke<SetupReport>('setup_agents', { root });
      setSetupReport(report);
      await detect();
    } catch (e) { fail(e); }
    finally { setConnecting(false); }
  };
  const unregisterBridge = async (id: string) => {
    setRegistering(id);
    try { setNotice(await invoke<string>('unregister_bridge', { id })); setSetupReport(null); }
    catch (e) { fail(e); }
    finally { setRegistering(''); }
  };
  const copySetupCommand = async () => {
    try { await navigator.clipboard.writeText(setupCommand); setNotice('一键连接命令已复制'); }
    catch { setNotice('请选中下方命令并手动复制。'); }
  };
  const copyAgentTask = async () => {
    const cli = setupCommand.replace(/ --setup$/, '');
    const task = `请帮我配置 Seabird 与你当前 Agent 的连接。Seabird CLI 位于本机，先运行 ${cli} --help 查看当前版本的用法。目标工作目录：${JSON.stringify(root)}。请检查当前 Agent 的 MCP 状态，只为当前 Agent 配置连接，保留已有的其他配置；如果存在同名冲突或需要登录，请说明情况。完成后报告结果，提醒我在新会话中调用 workspace_info 验证。`;
    try { await navigator.clipboard.writeText(task); setNotice('配置任务已复制，粘贴给 Codex 或 Claude Code 即可'); }
    catch { setNotice('无法复制，请使用下方命令或查看 README。'); }
  };
  const executeSql = async () => { try { setBusy(true); setResult(await invoke<Result>('run_sql', { sql })); setNotice(''); } catch (e) { setResult(null); fail(e); } finally { setBusy(false); } };
  const tree = (path: string, depth = 0): React.ReactNode => (entries[path] || []).map(entry => <React.Fragment key={entry.path}><button className={`tree-item ${file === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 12 + depth * 15 }} onClick={() => entry.is_dir ? void toggleFolder(entry.path) : void openFile(entry.path)} title={entry.path}>{entry.is_dir ? (expanded[entry.path] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>) : <span className="tree-spacer"/>}{entry.is_dir ? <Folder size={15}/> : <FileCode2 size={15}/>}<span>{entry.name}</span></button>{entry.is_dir && expanded[entry.path] && tree(entry.path, depth + 1)}</React.Fragment>);

  return <div className={`app-shell${macOS ? ' macos' : ''}`}>
    <aside className="sidebar">
      <div className="brand" data-tauri-drag-region><div className="brand-mark" data-tauri-drag-region><img src={seabirdLogo} alt="" draggable={false} data-tauri-drag-region/></div><div data-tauri-drag-region><strong data-tauri-drag-region>seabird</strong><small data-tauri-drag-region>YOUR LOCAL WORKSPACE</small></div><PanelLeft className="sidebar-icon" size={16}/></div>
      <div className="sidebar-scroll">
        <nav><button className={`nav-item ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}><Layers2 size={17}/> 工作台 <span>⌘ 1</span></button></nav>
        <div className="side-label navigation-label">内容</div>
        <nav><button className={`nav-item ${view === 'materials' ? 'active' : ''}`} onClick={() => setView('materials')}><Bookmark size={17}/> 素材 <span>⌘ 2</span></button><button className={`nav-item ${view === 'articles' ? 'active' : ''}`} onClick={() => setView('articles')}><FileText size={17}/> 文章 <span>⌘ 3</span></button></nav>
        <div className="side-label navigation-label">发现</div>
        <nav><button className={`nav-item ${view === 'discover' ? 'active' : ''}`} onClick={() => setView('discover')}><Compass size={17}/> 热点发现</button></nav>
        <div className="side-label navigation-label">工具</div>
        <nav><button className={`nav-item ${view === 'agent' ? 'active' : ''}`} onClick={() => setView('agent')}><Bot size={17}/> Agent</button><button className={`nav-item ${view === 'settings' || view === 'files' || view === 'database' ? 'active' : ''}`} onClick={() => setView('settings')}><Folder size={17}/> 设置与文件</button></nav>
        {view === 'files' && <><div className="side-label files-label">文件浏览器 <button onClick={() => root && loadFolder(root, root).catch(fail)} title="刷新文件"><RefreshCw size={13}/></button></div>{root ? <div className="file-tree"><button className="tree-root" aria-expanded={rootExpanded} onClick={() => setRootExpanded(open => !open)}>{rootExpanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<span>{basename(root)}</span></button>{rootExpanded && tree(root)}</div> : <p className="side-empty">打开文件夹后，文件会显示在这里。</p>}</>}
      </div><div className="sidebar-bottom"><div className="status-dot"/><span>本地工作台</span><span className="sidebar-version">v0.1</span></div>
    </aside>
    <main className="main"><header className="topbar" data-tauri-drag-region><div className="breadcrumbs"><span>内容工作台</span><ChevronRight size={14}/><strong>{({ home: '工作台', materials: '素材', articles: '文章', discover: '热点发现', agent: 'Agent', files: '文件', database: '数据库', settings: '设置与文件' } as const)[view]}</strong></div><div className="top-actions"><span className="local-badge"><span/> 本地运行</span><button className="icon-button" title="刷新工具状态" onClick={detect}><RefreshCw size={16}/></button></div></header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={15}/></button></div>}
      <ContentWorkspace view={view} root={root} desktop={desktop} onNavigate={setView} onDirty={setContentDirty} onBusy={setContentBusy} onAgent={(task) => { if (agentRunning) { setNotice('Agent 正在执行任务，请结束后再发送新任务。'); return; } if (prompt.trim() && !window.confirm('Agent 输入框已有未发送的内容，确定替换吗？')) return; setPrompt(task); setCurrentId(''); setView('agent'); }}/>
      {view === 'settings' && <div className="page tool-page"><div className="tool-heading"><div><span className="section-kicker">SETTINGS</span><h1>设置与文件</h1><p>管理本地内容位置与高级工具。</p></div></div><div className="workspace-card"><div className="folder-art"><FolderOpen size={24}/></div><div className="workspace-card-copy"><div className="card-title">本地素材目录</div><p>{root || '尚未选择目录'}</p></div><button className="secondary-button" onClick={chooseFolder}>切换目录</button></div><p className="settings-note">图片和视频保存在此目录。切换目录会显示该目录对应的素材和文章；数据库与连接配置保存在系统应用数据目录。</p><div className="settings-storage"><b>数据库与配置备份</b><span>{backupPath || '桌面应用中显示备份位置'}</span><small>素材与文章保存后会更新本地数据库备份；连接配置也会保留备份。备份不包含图片和视频文件，请另行备份素材目录。</small></div><div className="quick-grid settings-tools"><button onClick={() => setView('files')}><span className="quick-icon blue"><FileText size={18}/></span><span><b>浏览本地文件</b><small>查看当前目录的文件</small></span><ArrowUpRight size={16}/></button><button onClick={() => setView('database')}><span className="quick-icon purple"><Database size={18}/></span><span><b>数据库工具</b><small>查看本地数据与数据库位置</small></span><ArrowUpRight size={16}/></button></div></div>}
      {view === 'agent' && <div className="page tool-page agent-page"><div className="tool-heading"><div><span className="section-kicker">YOUR LOCAL AGENTS</span><h1>Agent 工作台</h1><p>在 Seabird 中使用本机 Codex 或 Claude Code；对话无需先配置 MCP。</p></div></div>
        <div className="agent-workspace"><FolderOpen size={16}/><span>当前工作目录</span><strong title={root}>{root || '尚未选择'}</strong><button className="text-button" onClick={chooseFolder}>切换</button></div>
        {setupReport && <div className="setup-results"><div className="panel-title"><span>上次连接结果{setupReport.ok ? ' · 配置完成' : ' · 部分项目需要处理'}</span><small>工作目录：{setupReport.workspace}</small></div>{setupReport.agents.map(agent => <div className="setup-result" key={agent.id}><span><b>{agentInfo[agent.id]?.name || agent.id}</b><small>{agent.version || '未检测到'}{agent.path ? ` · ${agent.path}` : ''}</small></span><div><strong className={agent.bridge === 'connected' ? 'setup-success' : 'setup-warning'}>{agent.bridge === 'connected' ? 'MCP 已配置' : agent.bridge === 'not_installed' ? '未安装' : agent.bridge === 'conflict' ? '配置冲突' : '需要处理'}</strong><small>{agent.auth === 'configured' ? '登录已配置，实际请求时验证' : agent.auth === 'not_logged_in' ? '未登录' : '登录状态未知'} · {agent.detail}</small></div></div>)}</div>}
        {conversations.length > 0 && <div className="history-panel"><div className="panel-title"><span>历史对话</span><small>保存在此设备 · 当前工作目录</small></div><div className="history-list">{conversations.map(c => <button key={c.id} disabled={agentRunning} className={conversationId === c.id ? 'history-item selected' : 'history-item'} onClick={() => { setCurrentId(c.id); setSelectedAgent(c.agent); setRequests([]); }}><b>{c.title}</b><small>{agentInfo[c.agent]?.name || c.agent}{c.sessionId ? '' : ' · 尚未建立会话'}</small></button>)}</div></div>}
        <div className="task-panel"><div className="panel-title"><span><Bot size={16}/> {sessionId ? '继续对话' : '新对话'}</span><span className="agent-select"><button className="text-button" disabled={agentRunning || (!sessionId && !agentOutput)} onClick={() => { setCurrentId(''); setRequests([]); }}>新建对话</button><label htmlFor="agent-select">Agent</label><select id="agent-select" value={selectedAgent} disabled={agentRunning} onChange={e => chooseAgent(e.target.value)}>{Object.entries(agentInfo).map(([id, info]) => <option key={id} value={id}>{info.name}{agents.find(a => a.id === id)?.path ? '' : '（未检测到）'}</option>)}</select></span></div>
          <textarea aria-label="任务内容" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="例如：整理工作目录里的素材，为公众号列出三个选题。" disabled={agentRunning}/><div className="task-actions"><span>{agents.find(a => a.id === selectedAgent)?.path ? '使用本机已有的登录和权限配置' : '请先安装并登录所选 Agent'}</span>{agentRunning ? <button className="secondary-button" disabled={stoppingAgent} onClick={stopAgent}>{stoppingAgent ? '正在停止…' : '停止任务'}</button> : <button className="primary-button" disabled={!desktop || !root || !agentEventsReady || historyLoading || !prompt.trim() || !agents.find(a => a.id === selectedAgent)?.path} onClick={runAgent}><Send size={14}/>{sessionId ? '发送' : '开始任务'}</button>}</div></div>
        {request && <div className="request-panel" role="region" aria-label="Agent 请求"><div className="panel-title"><span>{!supportedRequest ? '暂不支持此类请求' : requestQuestions(request).length ? 'Agent 需要你的回答' : 'Agent 请求操作权限'}</span><small>{request.method}</small></div>{requestQuestions(request).length ? requestQuestions(request).map(q => <div className="request-question" key={q.id}><label htmlFor={`answer-${q.id}`}>{q.label}{q.multiple ? '（多项可用逗号分隔）' : ''}</label>{q.options.length > 0 && <div className="answer-options">{q.options.map(option => <button key={option} type="button" className="secondary-button" onClick={() => setAnswers(previous => ({ ...previous, [q.id]: q.multiple && previous[q.id] ? `${previous[q.id]}, ${option}` : option }))}>{option}</button>)}</div>}<input id={`answer-${q.id}`} type={q.secret ? "password" : "text"} value={answers[q.id] || ''} onChange={event => setAnswers(previous => ({ ...previous, [q.id]: event.target.value }))} placeholder="输入或选择回答" /></div>) : <pre>{JSON.stringify(request.params, null, 2)}</pre>}<div className="request-actions"><button className="secondary-button" disabled={responding || !supportedRequest || (Array.isArray(request.params.availableDecisions) && !request.params.availableDecisions.includes('decline') && !request.params.availableDecisions.includes('cancel'))} onClick={() => respondToAgent('deny')}>拒绝</button><button className="primary-button" disabled={responding || !supportedRequest || (Array.isArray(request.params.availableDecisions) && !request.params.availableDecisions.includes('accept'))} onClick={() => respondToAgent('allow')}>{requestQuestions(request).length ? '提交回答' : '允许'}</button></div></div>}
        <div className="result-panel agent-result"><div className="panel-title"><span>执行结果</span><small>{agentRunning ? '正在执行' : agentOutput ? '执行结束' : '等待任务'}</small></div>{agentOutput ? <pre className="agent-output">{agentOutput}</pre> : <div className="result-empty">任务输出会显示在这里。</div>}</div>
        <div className="bridge-section"><div className="section-head"><div><span className="section-kicker">CONNECT TO SEABIRD</span><h2>让外部 Agent 使用 Seabird</h2></div><button className="primary-button" disabled={!setupCommand || !root} onClick={copyAgentTask}>复制配置任务</button></div><p>将配置任务粘贴给本机 Codex 或 Claude Code，让它检查并配置自己的连接。MCP 允许它读取、创建和覆盖当前工作目录中的文本文件。</p><p>也可以直接连接全部已安装的 Agent：</p><div className="setup-command-row">{setupCommand && <pre className="setup-command" tabIndex={0}>{setupCommand}</pre>}<button className="secondary-button" disabled={!setupCommand} onClick={copySetupCommand}>复制命令</button><button className="secondary-button" disabled={!desktop || !root || connecting || agentRunning} onClick={connectAgents}>{connecting ? '正在连接…' : '一键连接'}</button></div><div className="bridge-list">{Object.entries(agentInfo).map(([id, info]) => <div key={id}><span><b>{info.name}</b><small>{agents.find(a => a.id === id)?.path ? '已安装' : '未检测到'}</small></span><div className="bridge-buttons"><button className="text-button" disabled={!desktop || !!registering || connecting || !agents.find(a => a.id === id)?.path} onClick={() => unregisterBridge(id)}>{registering === id ? '处理中…' : '移除 MCP 连接'}</button></div></div>)}</div><small className="bridge-help">连接绑定当前目录；切换目录后，需要先移除 Agent 中原有的 seabird 连接，再重新注册。配置后请在新会话中验证。</small></div>
      </div>}
      {view === 'files' && <div className="page tool-page"><div className="tool-heading"><div><span className="section-kicker">YOUR FILES</span><h1>文件</h1><p>浏览和编辑工作目录中的文本文件。</p></div><button className="secondary-button" onClick={chooseFolder}><FolderOpen size={16}/> {root ? '切换目录' : '选择文件夹'}</button></div>{file ? <div className="editor-panel"><div className="editor-header"><div><FileCode2 size={16}/><b>{basename(file)}</b>{dirty && <span className="unsaved">未保存</span>}</div><button className="primary-button" onClick={save} disabled={!dirty}><Save size={15}/> 保存</button></div><div className="file-path">{file}</div><textarea className="editor" aria-label="文件内容" spellCheck={false} value={content} onChange={e => setContent(e.target.value)}/><div className="editor-footer">纯文本编辑器 <span>{content.split('\n').length} 行 · ⌘ / Ctrl + S 保存</span></div></div> : <div className="empty-state"><div className="empty-icon"><FileText size={25}/></div><h3>选择一个文件</h3><p>{root ? '从左侧文件浏览器打开文本文件。' : '先选择一个工作目录，然后从左侧打开文件。'}</p>{!root && <button className="primary-button" onClick={chooseFolder}>选择工作目录</button>}</div>}</div>}
      {view === 'database' && <div className="page tool-page"><div className="tool-heading"><div><span className="section-kicker">LOCAL DATABASE</span><h1>数据库</h1><p>用 SQL 查询和管理你的本地数据。</p></div><span className="database-badge"><span className="status-dot"/> SQLite 3</span></div><div className="db-location"><HardDrive size={16}/><span><b>应用数据库</b><small>{dbPath || '在桌面应用中可用'}</small></span></div><div className="sql-panel"><div className="panel-title"><span><Braces size={16}/> SQL 查询</span><small>每次执行一条语句</small></div><textarea spellCheck={false} aria-label="SQL 查询" value={sql} onChange={e => setSql(e.target.value)}/><div className="sql-actions"><span>内置 notes 表，可自由创建其他表。</span><button className="primary-button" onClick={executeSql} disabled={!desktop || busy || !sql.trim()}><Play size={14} fill="currentColor"/> 执行查询</button></div></div><div className="result-panel"><div className="panel-title"><span><Database size={16}/> 查询结果</span><small>{result?.message || '等待执行'}</small></div>{result?.columns.length ? <div className="table-wrap"><table><thead><tr>{result.columns.map((col, i) => <th key={i}>{col}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>{result.rows.length === 0 && <div className="result-empty">没有匹配的数据</div>}</div> : <div className="result-empty">{result ? result.message : '执行查询后，结果将显示在这里。'}</div>}</div></div>}
      <div className="bottom-bar"><span><span className="status-dot"/> {desktop ? '本地模式' : '浏览器预览'}</span><span>{root ? basename(root) : '未选择工作目录'} <span className="bottom-separator">/</span> Seabird</span></div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
