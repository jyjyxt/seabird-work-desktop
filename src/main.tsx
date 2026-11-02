import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { ArrowUpRight, Bot, Braces, ChevronDown, ChevronRight, Database, FileCode2, FileText, Folder, FolderOpen, HardDrive, Layers2, PanelLeft, Play, Plus, RefreshCw, Save, Send, X } from 'lucide-react';
import seabirdLogo from './assets/seabird.svg';
import './styles.css';

type Entry = { name: string; path: string; is_dir: boolean };
type Agent = { id: string; path: string | null };
type Result = { columns: string[]; rows: string[][]; message: string };
type View = 'home' | 'agent' | 'files' | 'database';
type AgentEvent = { run_id: string; kind: 'output' | 'done' | 'error'; text: string };
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
  const [file, setFile] = useState('');
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [sql, setSql] = useState('SELECT * FROM notes ORDER BY created_at DESC;');
  const [result, setResult] = useState<Result | null>(null);
  const [dbPath, setDbPath] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('codex');
  const [prompt, setPrompt] = useState('');
  const [agentOutput, setAgentOutput] = useState('');
  const [agentRunning, setAgentRunning] = useState(false);
  const [stoppingAgent, setStoppingAgent] = useState(false);
  const stopRequested = useRef(false);
  const [agentEventsReady, setAgentEventsReady] = useState(false);
  const [registering, setRegistering] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [setupReport, setSetupReport] = useState<SetupReport | null>(null);
  const [setupCommand, setSetupCommand] = useState('');
  const activeRun = useRef('');
  const desktop = isTauri();
  const dirty = content !== saved;

  const fail = (e: unknown) => setNotice(errorText(e));
  const detect = useCallback(async () => { if (!desktop) return; try { setAgents(await invoke<Agent[]>('detect_agents')); } catch (e) { fail(e); } }, [desktop]);
  const loadFolder = useCallback(async (workspace: string, path: string) => {
    const items = await invoke<Entry[]>('list_files', { root: workspace, path });
    setEntries(previous => ({ ...previous, [path]: items }));
  }, []);
  useEffect(() => { void detect(); if (desktop) invoke<string>('database_path').then(setDbPath).catch(fail); }, [desktop, detect]);
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
      if (data.kind === 'output') setAgentOutput(previous => (previous + data.text).slice(-500_000));
      else {
        setAgentOutput(previous => previous + `\n${stopRequested.current ? '任务已停止' : data.text}\n`);
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
  useEffect(() => { if (root && desktop) loadFolder(root, root).catch(fail); }, [root, desktop, loadFolder]);
  const confirmDiscard = () => !dirty || window.confirm('当前文件有未保存的修改，确定放弃吗？');
  const chooseFolder = async () => {
    if (!desktop) { setNotice('请在桌面应用中选择本地文件夹。'); return; }
    if (agentRunning || connecting) { setNotice('正在执行任务或连接 Agent，请结束后再切换目录。'); return; }
    if (!confirmDiscard()) return;
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择工作目录' });
      if (typeof selected === 'string') { await invoke('remember_workspace', { root: selected }); setRoot(selected); localStorage.setItem('seabird-root', selected); setEntries({}); setExpanded({}); setFile(''); setContent(''); setSaved(''); setSetupReport(null); setNotice(''); }
    } catch (e) { fail(e); }
  };
  const openFile = async (path: string) => {
    if (path === file) { setView('files'); return; }
    if (!confirmDiscard()) return;
    try { const text = await invoke<string>('read_file', { root, path }); setFile(path); setContent(text); setSaved(text); setView('files'); setNotice(''); } catch (e) { fail(e); }
  };
  const save = async () => { if (!file) return; try { await invoke('write_file', { root, path: file, content }); setSaved(content); setNotice('文件已保存'); } catch (e) { fail(e); } };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (!(event.metaKey || event.ctrlKey)) return; if (event.key.toLowerCase() === 's' && file) { event.preventDefault(); void save(); } else if (['1', '2', '3'].includes(event.key)) { event.preventDefault(); setView(({ '1': 'home', '2': 'files', '3': 'database' } as const)[event.key as '1' | '2' | '3']); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  const toggleFolder = async (path: string) => { if (!expanded[path]) { try { await loadFolder(root, path); } catch (e) { fail(e); return; } } setExpanded(p => ({ ...p, [path]: !p[path] })); };
  const runAgent = async () => {
    if (!root || !prompt.trim() || agentRunning) return;
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeRun.current = runId;
    stopRequested.current = false;
    setAgentOutput('');
    setAgentRunning(true);
    try { await invoke('start_agent', { root, id: selectedAgent, prompt, runId }); }
    catch (e) { if (activeRun.current === runId) { activeRun.current = ''; setAgentRunning(false); } fail(e); }
  };
  const stopAgent = async () => {
    if (!activeRun.current || stoppingAgent) return;
    stopRequested.current = true;
    setStoppingAgent(true);
    try { await invoke('stop_agent', { runId: activeRun.current }); }
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
  const executeSql = async () => { try { setBusy(true); setResult(await invoke<Result>('run_sql', { sql })); setNotice(''); } catch (e) { setResult(null); fail(e); } finally { setBusy(false); } };
  const tree = (path: string, depth = 0): React.ReactNode => (entries[path] || []).map(entry => <React.Fragment key={entry.path}><button className={`tree-item ${file === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 12 + depth * 15 }} onClick={() => entry.is_dir ? void toggleFolder(entry.path) : void openFile(entry.path)} title={entry.path}>{entry.is_dir ? (expanded[entry.path] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>) : <span className="tree-spacer"/>}{entry.is_dir ? <Folder size={15}/> : <FileCode2 size={15}/>}<span>{entry.name}</span></button>{entry.is_dir && expanded[entry.path] && tree(entry.path, depth + 1)}</React.Fragment>);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><img src={seabirdLogo} alt=""/></div><div><strong>seabird</strong><small>YOUR LOCAL WORKSPACE</small></div><PanelLeft className="sidebar-icon" size={16}/></div>
      <div className="sidebar-scroll"><div className="side-label">工作空间 <button onClick={chooseFolder} title="选择工作目录"><Plus size={15}/></button></div>
        <button className="workspace-switch" onClick={chooseFolder}><span className="workspace-icon"><FolderOpen size={16}/></span><span className="workspace-name"><b>{root ? basename(root) : '选择工作目录'}</b><small>{root ? '本地工作空间' : '打开一个本地文件夹'}</small></span><ChevronDown size={15}/></button>
        <div className="side-label navigation-label">工作台</div>
        <nav><button className={`nav-item ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}><Layers2 size={17}/> 概览 <span>⌘ 1</span></button><button className={`nav-item ${view === 'agent' ? 'active' : ''}`} onClick={() => setView('agent')}><Bot size={17}/> Agent</button><button className={`nav-item ${view === 'files' ? 'active' : ''}`} onClick={() => setView('files')}><Folder size={17}/> 文件 <span>⌘ 2</span></button><button className={`nav-item ${view === 'database' ? 'active' : ''}`} onClick={() => setView('database')}><Database size={17}/> 数据库 <span>⌘ 3</span></button></nav>
        <div className="side-label files-label">文件浏览器 <button onClick={() => root && loadFolder(root, root).catch(fail)} title="刷新文件"><RefreshCw size={13}/></button></div>
        {root ? <div className="file-tree"><div className="tree-root"><ChevronDown size={13}/><span>{basename(root)}</span></div>{tree(root)}</div> : <p className="side-empty">打开文件夹后，文件会显示在这里。</p>}
      </div><div className="sidebar-bottom"><div className="status-dot"/><span>本地工作台</span><span className="sidebar-version">v0.1</span></div>
    </aside>
    <main className="main"><header className="topbar"><div className="breadcrumbs"><span>工作空间</span><ChevronRight size={14}/><strong>{view === 'home' ? '概览' : view === 'agent' ? 'Agent' : view === 'files' ? '文件' : '数据库'}</strong></div><div className="top-actions"><span className="local-badge"><span/> 本地运行</span><button className="icon-button" title="刷新工具状态" onClick={detect}><RefreshCw size={16}/></button></div></header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={15}/></button></div>}
      {view === 'home' && <div className="page home-page"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> YOUR SPACE TO CREATE</div><h1>你的工作，<br/><span>从这里开始。</span></h1><p>文件、数据和 AI 助手，聚在一个顺手的地方。</p></div><div className="heading-symbol"><img src={seabirdLogo} alt=""/><small>LOCAL FIRST<br/>MADE FOR YOU</small></div></div>
        <div className="section-head"><div><span className="section-kicker">WORKSPACE</span><h2>当前工作空间</h2></div><button className="text-button" onClick={chooseFolder}>{root ? '切换目录' : '选择目录'} <ArrowUpRight size={15}/></button></div>
        <div className="workspace-card"><div className="folder-art"><FolderOpen size={26} strokeWidth={1.5}/></div><div className="workspace-card-copy"><div className="card-title">{root ? basename(root) : '打开你的第一个文件夹'} <span className="outline-badge">LOCAL</span></div><p>{root || '选择一个本地文件夹，开始浏览和编辑文件。'}</p></div><button className="secondary-button" onClick={chooseFolder}>{root ? '更换' : '选择文件夹'} <ArrowUpRight size={15}/></button></div>
        <div className="section-head agent-heading"><div><span className="section-kicker">YOUR ASSISTANTS</span><h2>AI 助手 <span className="count">{agents.filter(a => a.path).length} / 2 已安装</span></h2></div><button className="text-button" onClick={detect}><RefreshCw size={14}/> 重新检测</button></div>
        <div className="agent-grid">{Object.entries(agentInfo).map(([id, info]) => { const agent = agents.find(a => a.id === id); return <div className="agent-card" key={id}><div className="agent-top"><div className={`agent-mark ${info.color}`}>{info.mark}</div><span className={`agent-status ${agent?.path ? 'ready' : ''}`}><i/>{agent?.path ? '已安装' : '未检测到'}</span></div><h3>{info.name}</h3><p>{info.description}</p><div className="agent-bottom"><span title={agent?.path || '请先安装命令行程序'}>{agent?.path ? '命令行已就绪' : '需要安装命令行程序'}</span><button disabled={!agent?.path || busy} onClick={() => { setSelectedAgent(id); setView('agent'); }} aria-label={`使用 ${info.name}`} title={`使用 ${info.name}`}><ArrowUpRight size={17}/></button></div></div>; })}</div>
        <div className="section-head quick-heading"><div><span className="section-kicker">PICK UP WHERE YOU LEFT OFF</span><h2>快捷访问</h2></div></div><div className="quick-grid"><button onClick={() => setView('files')}><span className="quick-icon blue"><FileText size={18}/></span><span><b>浏览文件</b><small>查看并编辑工作目录</small></span><ArrowUpRight size={16}/></button><button onClick={() => setView('database')}><span className="quick-icon purple"><Database size={18}/></span><span><b>SQLite 数据库</b><small>查询和管理本地数据</small></span><ArrowUpRight size={16}/></button></div>
        <div className="home-footer"><span><span className="status-dot"/> 一切都在你的设备上</span><span>想法在这里落地 <span className="footer-star">✳</span></span></div>
      </div>}
      {view === 'agent' && <div className="page tool-page agent-page"><div className="tool-heading"><div><span className="section-kicker">YOUR LOCAL AGENTS</span><h1>Agent 工作台</h1><p>给本机 Agent 一个任务，在当前工作目录中执行。</p></div><button className="primary-button" disabled={!desktop || !root || connecting || agentRunning} onClick={connectAgents}><RefreshCw size={15}/> {connecting ? '正在连接…' : '一键连接本机 Agent'}</button></div>
        <div className="agent-workspace"><FolderOpen size={16}/><span>当前工作目录</span><strong title={root}>{root || '尚未选择'}</strong><button className="text-button" onClick={chooseFolder}>切换</button></div>
        {setupReport && <div className="setup-results"><div className="panel-title"><span>上次连接结果{setupReport.ok ? ' · 配置完成' : ' · 部分项目需要处理'}</span><small>工作目录：{setupReport.workspace}</small></div>{setupReport.agents.map(agent => <div className="setup-result" key={agent.id}><span><b>{agentInfo[agent.id]?.name || agent.id}</b><small>{agent.version || '未检测到'}{agent.path ? ` · ${agent.path}` : ''}</small></span><div><strong className={agent.bridge === 'connected' ? 'setup-success' : 'setup-warning'}>{agent.bridge === 'connected' ? 'MCP 已配置' : agent.bridge === 'not_installed' ? '未安装' : agent.bridge === 'conflict' ? '配置冲突' : '需要处理'}</strong><small>{agent.auth === 'configured' ? '登录已配置，实际请求时验证' : agent.auth === 'not_logged_in' ? '未登录' : '登录状态未知'} · {agent.detail}</small></div></div>)}</div>}
        <div className="task-panel"><div className="panel-title"><span><Bot size={16}/> 执行任务</span><span className="agent-select"><label htmlFor="agent-select">Agent</label><select id="agent-select" value={selectedAgent} disabled={agentRunning} onChange={e => setSelectedAgent(e.target.value)}>{Object.entries(agentInfo).map(([id, info]) => <option key={id} value={id}>{info.name}{agents.find(a => a.id === id)?.path ? '' : '（未检测到）'}</option>)}</select></span></div>
          <textarea aria-label="任务内容" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="例如：整理工作目录里的素材，为公众号列出三个选题。" disabled={agentRunning}/><div className="task-actions"><span>{agents.find(a => a.id === selectedAgent)?.path ? '使用本机已有的登录和权限配置' : '请先安装并登录所选 Agent'}</span>{agentRunning ? <button className="secondary-button" disabled={stoppingAgent} onClick={stopAgent}>{stoppingAgent ? '正在停止…' : '停止任务'}</button> : <button className="primary-button" disabled={!desktop || !root || !agentEventsReady || !prompt.trim() || !agents.find(a => a.id === selectedAgent)?.path} onClick={runAgent}><Send size={14}/>开始任务</button>}</div></div>
        <div className="result-panel agent-result"><div className="panel-title"><span>执行结果</span><small>{agentRunning ? '正在执行' : agentOutput ? '执行结束' : '等待任务'}</small></div>{agentOutput ? <pre className="agent-output">{agentOutput}</pre> : <div className="result-empty">任务输出会显示在这里。</div>}</div>
        <div className="bridge-section"><div className="section-head"><div><span className="section-kicker">CONNECT TO SEABIRD</span><h2>从 Agent 配置连接</h2></div></div><p>在本机 Agent 或终端执行这条命令，即可检测并配置全部已安装的 Agent。</p>{setupCommand && <div className="setup-command-row"><pre className="setup-command" tabIndex={0}>{setupCommand}</pre><button className="secondary-button" onClick={copySetupCommand}>复制命令</button></div>}<p>一键连接会注册本地 MCP，允许 Agent 读取、创建和修改当前工作目录中的文本文件。</p><div className="bridge-list">{Object.entries(agentInfo).map(([id, info]) => <div key={id}><span><b>{info.name}</b><small>{agents.find(a => a.id === id)?.path ? '已安装' : '未检测到'}</small></span><div className="bridge-buttons"><button className="text-button" disabled={!desktop || !!registering || connecting || !agents.find(a => a.id === id)?.path} onClick={() => unregisterBridge(id)}>{registering === id ? '处理中…' : '移除 MCP 连接'}</button></div></div>)}</div><small className="bridge-help">连接绑定当前目录；切换目录后，需要先移除 Agent 中原有的 seabird 连接，再重新注册。Agent 是否能执行操作取决于它自身的权限设置。</small></div>
      </div>}
      {view === 'files' && <div className="page tool-page"><div className="tool-heading"><div><span className="section-kicker">YOUR FILES</span><h1>文件</h1><p>浏览和编辑工作目录中的文本文件。</p></div><button className="secondary-button" onClick={chooseFolder}><FolderOpen size={16}/> {root ? '切换目录' : '选择文件夹'}</button></div>{file ? <div className="editor-panel"><div className="editor-header"><div><FileCode2 size={16}/><b>{basename(file)}</b>{dirty && <span className="unsaved">未保存</span>}</div><button className="primary-button" onClick={save} disabled={!dirty}><Save size={15}/> 保存</button></div><div className="file-path">{file}</div><textarea className="editor" aria-label="文件内容" spellCheck={false} value={content} onChange={e => setContent(e.target.value)}/><div className="editor-footer">纯文本编辑器 <span>{content.split('\n').length} 行 · ⌘ / Ctrl + S 保存</span></div></div> : <div className="empty-state"><div className="empty-icon"><FileText size={25}/></div><h3>选择一个文件</h3><p>{root ? '从左侧文件浏览器打开文本文件。' : '先选择一个工作目录，然后从左侧打开文件。'}</p>{!root && <button className="primary-button" onClick={chooseFolder}>选择工作目录</button>}</div>}</div>}
      {view === 'database' && <div className="page tool-page"><div className="tool-heading"><div><span className="section-kicker">LOCAL DATABASE</span><h1>数据库</h1><p>用 SQL 查询和管理你的本地数据。</p></div><span className="database-badge"><span className="status-dot"/> SQLite 3</span></div><div className="db-location"><HardDrive size={16}/><span><b>应用数据库</b><small>{dbPath || '在桌面应用中可用'}</small></span></div><div className="sql-panel"><div className="panel-title"><span><Braces size={16}/> SQL 查询</span><small>每次执行一条语句</small></div><textarea spellCheck={false} aria-label="SQL 查询" value={sql} onChange={e => setSql(e.target.value)}/><div className="sql-actions"><span>内置 notes 表，可自由创建其他表。</span><button className="primary-button" onClick={executeSql} disabled={!desktop || busy || !sql.trim()}><Play size={14} fill="currentColor"/> 执行查询</button></div></div><div className="result-panel"><div className="panel-title"><span><Database size={16}/> 查询结果</span><small>{result?.message || '等待执行'}</small></div>{result?.columns.length ? <div className="table-wrap"><table><thead><tr>{result.columns.map((col, i) => <th key={i}>{col}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>{result.rows.length === 0 && <div className="result-empty">没有匹配的数据</div>}</div> : <div className="result-empty">{result ? result.message : '执行查询后，结果将显示在这里。'}</div>}</div></div>}
      <div className="bottom-bar"><span><span className="status-dot"/> {desktop ? '本地模式' : '浏览器预览'}</span><span>{root ? basename(root) : '未选择工作目录'} <span className="bottom-separator">/</span> Seabird</span></div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
