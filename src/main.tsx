import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { ArrowUpRight, Bookmark, Bot, Braces, ChevronDown, ChevronRight, Compass, Database, FileCode2, FileText, Folder, FolderOpen, HardDrive, History, Layers2, PanelLeft, Play, Plus, RefreshCw, Save, Send, Square, Trash2, X } from 'lucide-react';
import seabirdLogo from './assets/seabird.svg';
import './styles.css';
import ContentWorkspace, { type ContentView } from './ContentWorkspace';
import { parseSaveSuggestions, type SaveSuggestion } from './saveSuggestions';
import { parseArticleEdit, type AgentContext, type ArticleEdit, type ArticleTarget } from './articleAgent';

type Entry = { name: string; path: string; is_dir: boolean };
type Agent = { id: string; path: string | null };
type Result = { columns: string[]; rows: string[][]; message: string };
type View = ContentView | 'files' | 'database' | 'settings';
type AgentEvent = { run_id: string; kind: 'output' | 'activity' | 'session' | 'request' | 'request_resolved' | 'done' | 'error'; text: string };
type ChatMessage = { role: 'user' | 'assistant' | 'activity' | 'system'; text: string; savedSuggestions?: Record<number, { id: number; warning: string | null }>; articleTarget?: ArticleTarget; editApplied?: boolean };
type Conversation = { id: string; agent: string; sessionId: string; output: string; title: string; messages?: ChatMessage[] };
type ConversationEntry = { conversation: Conversation; updated_at: number };
type ContentReference = { kind: 'article' | 'material'; id: number; title: string };
const appendMessage = (messages: ChatMessage[], role: ChatMessage['role'], text: string, merge = false): ChatMessage[] => {
  const next = messages.slice(-2000);
  const last = next[next.length - 1];
  if (merge && last?.role === role) next[next.length - 1] = { ...last, text: last.text + text };
  else next.push({ role, text });
  let remaining = 500_000;
  return next.reverse().flatMap(message => {
    if (remaining <= 0) return [];
    const clipped = { ...message, text: message.text.slice(-remaining) };
    remaining -= clipped.text.length;
    return [clipped];
  }).reverse();
};
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
  const [taskSuggestion, setTaskSuggestion] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [references, setReferences] = useState<ContentReference[]>([]);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [referenceItems, setReferenceItems] = useState<ContentReference[]>([]);
  const [referenceSearch, setReferenceSearch] = useState('');
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [referenceError, setReferenceError] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const taskContext = useRef<(() => AgentContext) | null>(null);
  const articleContext = useRef<(() => AgentContext) | null>(null);
  const [articleContextAvailable, setArticleContextAvailable] = useState(false);
  const articleApply = useRef<((target: ArticleTarget, edit: ArticleEdit, onUndo: () => void) => string | null) | null>(null);
  const activeArticleTarget = useRef<ArticleTarget | null>(null);
  const setArticleContext = useCallback((context: (() => AgentContext) | null) => { articleContext.current = context; setArticleContextAvailable(!!context); }, []);
  const setArticleApply = useCallback((apply: ((target: ArticleTarget, edit: ArticleEdit, onUndo: () => void) => string | null) | null) => { articleApply.current = apply; }, []);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const conversationsRef = useRef<Conversation[]>([]);
  const conversationUpdatedAt = useRef(new Map<string, number>());
  const [conversationId, setConversationId] = useState('');
  const conversationIdRef = useRef('');
  const rootRef = useRef(root);
  const pendingSaves = useRef(new Map<string, { root: string; conversation: Conversation }>());
  const saving = useRef<Promise<void> | null>(null);
  const deletingConversations = useRef(false);
  const [deletingHistory, setDeletingHistory] = useState(false);
  const historyRef = useRef<HTMLDetailsElement>(null);
  const [requests, setRequests] = useState<AgentRequest[]>([]);
  const request = requests[0] || null;
  const requestPanelRef = useRef<HTMLDivElement>(null);
  const supportedRequest = !!request && ['can_use_tool', 'item/tool/requestUserInput', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(request.method);
  const offeredDecisions = Array.isArray(request?.params.availableDecisions) ? request.params.availableDecisions : null;
  const approvalPrefix: string[] | undefined = request?.method === 'item/commandExecution/requestApproval' ? offeredDecisions?.map((decision: any) => decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment).find((prefix: unknown) => Array.isArray(prefix) && prefix.length > 0 && prefix.every(part => typeof part === 'string' && part.length > 0)) : undefined;
  const sessionApproval = !!request && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method) && !!offeredDecisions?.includes('acceptForSession');
  const canApprove = !offeredDecisions || !!approvalPrefix || sessionApproval || offeredDecisions.includes('accept');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [responding, setResponding] = useState(false);
  useEffect(() => { setAnswers({}); }, [request?.key]);
  const currentConversation = conversations.find(c => c.id === conversationId);
  const agentOutput = currentConversation?.output || '';
  const messages = currentConversation?.messages || [];
  const setCurrentId = (id: string) => { conversationIdRef.current = id; setConversationId(id); };
  const updateConversation = (id: string, fn: (conversation: Conversation) => Conversation) => {
    const old = conversationsRef.current.find(c => c.id === id);
    if (!old) return;
    const next = fn(old);
    conversationUpdatedAt.current.set(id, Date.now());
    conversationsRef.current = conversationsRef.current.map(c => c.id === id ? next : c);
    setConversations(conversationsRef.current);
    const workspace = rootRef.current;
    pendingSaves.current.set(`${workspace}\0${next.id}`, { root: workspace, conversation: next });
    if (!saving.current) {
      saving.current = (async () => {
        try {
          while (pendingSaves.current.size) {
            const key = pendingSaves.current.keys().next().value as string;
            const item = pendingSaves.current.get(key)!;
            pendingSaves.current.delete(key);
            try { await invoke<void>('save_conversation', item); } catch (error) { fail(error); }
          }
        } finally { saving.current = null; }
      })();
    }
  };
  const [agentRunning, setAgentRunning] = useState(false);
  const [savingSuggestion, setSavingSuggestion] = useState('');
  const savingSuggestionRef = useRef(false);
  const [suggestionError, setSuggestionError] = useState('');
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  useEffect(() => { if (agentPanelOpen && followTranscript.current && transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }, [agentOutput, messages, agentRunning, agentPanelOpen, conversationId]);
  useEffect(() => { followTranscript.current = true; if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }, [conversationId]);
  const [checkingAgents, setCheckingAgents] = useState(false);
  useEffect(() => { if (request && agentPanelOpen) requestPanelRef.current?.focus(); }, [request?.key, agentPanelOpen]);
  const [agentsDetected, setAgentsDetected] = useState(false);
  const [agentChecked, setAgentChecked] = useState(() => localStorage.getItem('seabird-agent-checked') === 'yes');
  const [stoppingAgent, setStoppingAgent] = useState(false);
  const stopRequested = useRef(false);
  const [agentEventsReady, setAgentEventsReady] = useState(false);
  const [registering, setRegistering] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [setupReport, setSetupReport] = useState<SetupReport | null>(null);
  const [setupCommand, setSetupCommand] = useState('');
  const [executablePath, setExecutablePath] = useState('');
  useEffect(() => {
    if (!setupReport || !agentsDetected) return;
    const ready = setupReport.agents.some(a => a.path && a.auth === 'configured' && agents.some(found => found.id === a.id && found.path));
    setAgentChecked(ready);
    if (ready) localStorage.setItem('seabird-agent-checked', 'yes'); else localStorage.removeItem('seabird-agent-checked');
  }, [setupReport, agentsDetected, agents]);
  const activeRun = useRef('');
  const contentDirty = useRef(false);
  const contentBusy = useRef(false);
  const setContentDirty = useCallback((value: boolean) => { contentDirty.current = value; }, []);
  const setContentBusy = useCallback((value: boolean) => { contentBusy.current = value; }, []);
  const desktop = isTauri();
  useEffect(() => {
    if (!referencePickerOpen || !root) return;
    let cancelled = false;
    setReferenceLoading(true); setReferenceError('');
    const loadReferences = async () => {
      try {
        const data = desktop ? await invoke<{ articles: { id: number; title: string }[]; materials: { id: number; title: string }[] }>('content_load', { root }) : JSON.parse(localStorage.getItem(`seabird-content-preview:${root}`) || '{"articles":[],"materials":[]}');
        if (!cancelled) setReferenceItems([...data.articles.map((item: { id: number; title: string }) => ({ kind: 'article' as const, id: item.id, title: item.title })), ...data.materials.map((item: { id: number; title: string }) => ({ kind: 'material' as const, id: item.id, title: item.title }))]);
      } catch (error) { if (!cancelled) setReferenceError(`无法读取文章和素材：${errorText(error)}`); }
      finally { if (!cancelled) setReferenceLoading(false); }
    };
    void loadReferences();
    return () => { cancelled = true; };
  }, [referencePickerOpen, root, desktop]);
  useEffect(() => { setReferences([]); setReferencePickerOpen(false); setReferenceSearch(''); }, [root]);
  const macOS = desktop && /Mac/i.test(navigator.platform);
  const dirty = content !== saved;
  useEffect(() => { if (view === 'files') setRootExpanded(true); }, [view]);

  const fail = (e: unknown) => setNotice(errorText(e));
  const detect = useCallback(async () => { if (!desktop) return; try { const found = await invoke<Agent[]>('detect_agents'); setAgents(found); setSelectedAgent(current => found.some(a => a.id === current && a.path) ? current : found.find(a => a.path)?.id || current); } catch (e) { fail(e); } finally { setAgentsDetected(true); } }, [desktop]);
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
    invoke<string>('executable_path').then(path => { if (!cancelled) setExecutablePath(path); }).catch(fail);
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
      if (data.kind === 'output' || data.kind === 'activity') updateConversation(current, c => { const messages = appendMessage(c.messages || [], data.kind === 'output' ? 'assistant' : 'activity', data.text, true); if (data.kind === 'output' && activeArticleTarget.current) messages[messages.length - 1] = { ...messages[messages.length - 1], articleTarget: activeArticleTarget.current }; return { ...c, messages }; });
      else if (data.kind === 'session') updateConversation(current, c => ({ ...c, sessionId: data.text }));
      else if (data.kind === 'request') { setAgentPanelOpen(true); try { const incoming = JSON.parse(data.text) as AgentRequest; setRequests(previous => previous.some(r => r.key === incoming.key) ? previous : [...previous, incoming]); } catch { setNotice('无法读取 Agent 请求'); } }
      else if (data.kind === 'request_resolved') { setRequests(previous => previous.filter(r => r.key !== data.text)); }
      else {
        if (stopRequested.current || data.kind === 'error') updateConversation(current, c => ({ ...c, messages: appendMessage(c.messages || [], 'system', stopRequested.current ? '任务已停止' : data.text) }));
        setRequests([]);
        stopRequested.current = false;
        setStoppingAgent(false);
        setAgentRunning(false);
        activeRun.current = '';
        activeArticleTarget.current = null;
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
    return () => { disposed = true; };
  }, [desktop]);
  useEffect(() => {
    rootRef.current = root;
    if (!root || !desktop) return;
    let disposed = false;
    loadFolder(root, root).catch(fail);
    setCurrentId(''); conversationsRef.current = []; conversationUpdatedAt.current.clear(); setConversations([]); setHistoryLoading(true);
    invoke<ConversationEntry[]>('list_conversations', { root }).then(entries => { if (!disposed) { const items = entries.map(entry => entry.conversation); conversationUpdatedAt.current = new Map(entries.map(entry => [entry.conversation.id, entry.updated_at])); conversationsRef.current = items; setConversations(items); const latest = entries[0]; if (latest && latest.updated_at > 0 && Date.now() - latest.updated_at < 24 * 60 * 60 * 1000 && !conversationIdRef.current && !taskContext.current) { setCurrentId(latest.conversation.id); setSelectedAgent(latest.conversation.agent); } setHistoryLoading(false); } }).catch(error => { if (!disposed) { setHistoryLoading(false); fail(error); } });
    return () => { disposed = true; };
  }, [root, desktop, loadFolder]);
  const confirmDiscard = () => !dirty || window.confirm('当前文件有未保存的修改，确定放弃吗？');
  const chooseFolder = async () => {
    if (!desktop) { setNotice('请在桌面应用中选择本地文件夹。'); return; }
    if (agentRunning || connecting || deletingConversations.current) { setNotice('正在执行任务或连接 Agent，请结束后再切换目录。'); return; }
    if (contentBusy.current || savingSuggestionRef.current) { setNotice('正在保存内容或导入文件，请完成后再切换目录。'); return; }
    if (!confirmDiscard()) return;
    if (contentDirty.current && !window.confirm('素材或文章有未保存的修改，切换目录将丢失这些修改，确定继续吗？')) return;
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择工作目录' });
      if (typeof selected === 'string') { if (selected !== root && (prompt.trim() || references.length > 0) && !window.confirm('对话中有未发送的内容，切换目录将清除它，确定继续吗？')) return; await invoke('remember_workspace', { root: selected }); if (selected !== root) { setCurrentId(''); setRequests([]); setPrompt(''); setTaskSuggestion(''); taskContext.current = null; setSelectedText(''); clearReferences(); } setRoot(selected); localStorage.setItem('seabird-root', selected); setEntries({}); setExpanded({}); setFile(''); setContent(''); setSaved(''); setSetupReport(null); setNotice(''); }
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
  const clearReferences = () => { setReferences([]); setReferencePickerOpen(false); setReferenceSearch(''); };
  const resetStaleConversation = () => {
    const updated = conversationUpdatedAt.current.get(conversationIdRef.current);
    if (updated !== undefined && Date.now() - updated >= 24 * 60 * 60 * 1000 && !agentRunning && !prompt.trim() && !references.length && !taskSuggestion && !taskContext.current && !savingSuggestionRef.current) {
      setCurrentId(''); setRequests([]);
    }
  };
  const chooseAgent = (id: string) => {
    if (agentRunning || id === selectedAgent) return;
    if (conversationIdRef.current && !window.confirm('切换 Agent 会开始新会话，确定继续吗？')) return;
    setSelectedAgent(id); setCurrentId(''); setRequests([]);
  };
  const runAgent = async (quickTask?: string) => {
    const task = (quickTask ?? prompt).trim();
    if (!root || !task || agentRunning || activeRun.current || deletingConversations.current || savingSuggestionRef.current) return;
    let attachedContext: AgentContext | null;
    try { attachedContext = (taskContext.current || articleContext.current)?.() || null; }
    catch (e) { fail(e); return; }
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let conversation = conversationsRef.current.find(c => c.id === conversationIdRef.current);
    if (!conversation) {
      conversation = { id: runId, agent: selectedAgent, sessionId: '', output: '', title: task.slice(0, 40), messages: [] };
      conversationsRef.current = [conversation, ...conversationsRef.current];
      setConversations(conversationsRef.current); setCurrentId(conversation.id);
    }
    const current = conversation;
    activeRun.current = runId; stopRequested.current = false;
    activeArticleTarget.current = attachedContext?.article || null;
    followTranscript.current = true;
    const referenceText = references.length ? references.map(item => `${item.kind === 'article' ? '文章' : '素材'} ID ${item.id}：${JSON.stringify(item.title)}`).join('\n') : '';
    updateConversation(current.id, c => ({ ...c, messages: appendMessage(c.messages || [], 'user', task + (referenceText ? `\n\n引用：\n${referenceText}` : '')) }));
    setPrompt(''); setTaskSuggestion(''); taskContext.current = null; setSelectedText(''); setReferences([]); setReferencePickerOpen(false); setReferenceSearch('');
    setAgentRunning(true);
    try { const context = `\n\nSeabird 可执行文件：${JSON.stringify(executablePath)}；工作目录：${JSON.stringify(root)}。如需读取或保存 Seabird 素材和文章，请先运行该程序的 --help，使用 content 命令。读取完整内容后再修改，更新时提供读取到的原始对象作为 expected，保留未要求修改的字段。保存后报告内容 ID；若有备份警告请告知用户。素材默认保留链接和文字，不下载图片或视频；只有用户明确要求下载或完成任务确实需要本地文件时才下载。\n\n${attachedContext?.article ? `当前任务指向正在编辑的文章，不要将该文章建议保存为新文章。需要修改文章时，在正常回复后附加以下代码块，让用户确认应用：\n\`\`\`seabird-edit\n{"body":"${attachedContext.article.selection ? '仅选中文字的完整替换内容' : '修改后的完整正文'}"${attachedContext.article.selection ? '' : ',"title":"当前版本的完整标题"'}}\n\`\`\`\n正文必须使用 JSON 字符串编码。只在用户需要修改时返回此代码块。${attachedContext.article.selection ? '不要修改选区之外的内容。' : '保留未要求修改的正文和附件引用。'}` : `如果本次对话产生了值得作为新素材或新文章保存的具体内容，且尚未保存，请在正常回复之后附加一个代码块，供用户选择是否保存。不要为了凑代码块而建议保存普通问答、执行过程或空泛建议；不要把已保存的内容再次建议保存。代码块格式必须严格为：\n\`\`\`seabird-save\n[{"kind":"material","title":"标题","body":"完整素材内容","source":"准确来源或空字符串","url":"原始链接或空字符串","tags":"逗号分隔的标签或空字符串"}]\n\`\`\`\nkind 只能是 material 或 article；文章的 body 是完整原稿。可放多个独立建议，最多 5 个。内容必须足以直接保存，不要虚构来源或链接。用户明确要求直接保存或修改时，仍按用户要求执行。`}`; await invoke('start_interactive', { root, id: current.agent, prompt: task + (referenceText ? `\n\n用户引用了以下内容，请读取后结合用户要求处理：\n${referenceText}` : '') + (attachedContext ? `\n\n${attachedContext.text}` : '') + context, runId, sessionId: current.sessionId || null }); }
    catch (e) { if (activeRun.current === runId) { activeRun.current = ''; activeArticleTarget.current = null; setAgentRunning(false); } updateConversation(current.id, c => ({ ...c, messages: appendMessage(c.messages || [], 'system', `启动失败：${errorText(e)}`) })); fail(e); }
  };
  const saveSuggestion = async (messageIndex: number, suggestionIndex: number, suggestion: SaveSuggestion) => {
    if (!desktop || !root || agentRunning || savingSuggestionRef.current || !currentConversation) return;
    const conversation = currentConversation;
    const original = conversation.messages?.[messageIndex];
    if (!original || original.savedSuggestions?.[suggestionIndex]) return;
    savingSuggestionRef.current = true;
    setSavingSuggestion(`${messageIndex}:${suggestionIndex}`); setSuggestionError('');
    try {
      const identity = JSON.stringify([conversation.id, original.text, suggestionIndex]);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      const suggestionKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const item = suggestion.kind === 'material'
        ? { id: 0, title: suggestion.title, note: suggestion.body, source: suggestion.source, url: suggestion.url, tags: suggestion.tags, media: [], updated_at: '' }
        : { id: 0, title: suggestion.title, body: suggestion.body, tags: suggestion.tags, versions: {}, material_ids: [], updated_at: '' };
      const result = await invoke<{ id: number; backup_warning: string | null }>(suggestion.kind === 'material' ? 'content_save_material' : 'content_save_article', { root, item, expected: null, suggestionKey });
      updateConversation(conversation.id, c => ({ ...c, messages: (c.messages || []).map((message, index) => index === messageIndex && message.text === original.text ? { ...message, savedSuggestions: { ...message.savedSuggestions, [suggestionIndex]: { id: result.id, warning: result.backup_warning } } } : message) }));
      window.dispatchEvent(new CustomEvent('seabird-content-saved', { detail: { root } }));
    } catch (e) { setSuggestionError(`保存失败：${errorText(e)}`); }
    finally { savingSuggestionRef.current = false; setSavingSuggestion(''); }
  };
  const applySuggestedEdit = (messageIndex: number, message: ChatMessage, edit: ArticleEdit) => {
    if (!message.articleTarget || !currentConversation || agentRunning || message.editApplied) return;
    const conversationId = currentConversation.id;
    const onUndo = () => updateConversation(conversationId, c => ({ ...c, messages: (c.messages || []).map((item, index) => index === messageIndex && item.text === message.text ? { ...item, editApplied: false } : item) }));
    const error = articleApply.current?.(message.articleTarget, edit, onUndo) || (articleApply.current ? null : '请先打开原文章。');
    if (error) { setSuggestionError(error); return; }
    setSuggestionError('');
    updateConversation(currentConversation.id, c => ({ ...c, messages: (c.messages || []).map((item, index) => index === messageIndex && item.text === message.text ? { ...item, editApplied: true } : item) }));
  };
  const deleteHistory = async (id?: string) => {
    if (agentRunning || deletingConversations.current || savingSuggestionRef.current) return;
    const target = id ? conversationsRef.current.find(c => c.id === id) : undefined;
    if (id && !target) return;
    if (!window.confirm(id ? `删除“${target!.title}”？` : '删除所有会话记录？')) return;
    if ((!id || id === conversationIdRef.current) && (prompt.trim() || references.length > 0) && !window.confirm('输入框有未发送的内容，删除后将清空。继续吗？')) return;
    deletingConversations.current = true; setDeletingHistory(true);
    try {
      if (saving.current) await saving.current;
      await invoke('delete_conversations', { root, id: id || null });
      conversationsRef.current = id ? conversationsRef.current.filter(c => c.id !== id) : [];
      setConversations(conversationsRef.current);
      if (!id || id === conversationIdRef.current) { setCurrentId(''); setPrompt(''); setTaskSuggestion(''); taskContext.current = null; setSelectedText(''); clearReferences(); setRequests([]); }
      if (!id && historyRef.current) historyRef.current.open = false;
    } catch (error) { fail(error); }
    finally { deletingConversations.current = false; setDeletingHistory(false); }
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
  const inspectAgents = async () => {
    if (!root || checkingAgents) return;
    setCheckingAgents(true); setNotice('');
    try { const report = await invoke<SetupReport>('inspect_agents', { root }); setSetupReport(report); await detect(); }
    catch (error) { fail(error); } finally { setCheckingAgents(false); }
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
        <nav><button className={`nav-item ${view === 'settings' || view === 'files' || view === 'database' ? 'active' : ''}`} onClick={() => setView('settings')}><Folder size={17}/> 设置与文件</button></nav>
        {view === 'files' && <><div className="side-label files-label">文件浏览器 <button onClick={() => root && loadFolder(root, root).catch(fail)} title="刷新文件"><RefreshCw size={13}/></button></div>{root ? <div className="file-tree"><button className="tree-root" aria-expanded={rootExpanded} onClick={() => setRootExpanded(open => !open)}>{rootExpanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<span>{basename(root)}</span></button>{rootExpanded && tree(root)}</div> : <p className="side-empty">打开文件夹后，文件会显示在这里。</p>}</>}
      </div><div className="sidebar-bottom"><div className="status-dot"/><span>本地工作台</span><span className="sidebar-version">v0.1</span></div>
    </aside>
    <main className="main"><header className="topbar" data-tauri-drag-region><div className="breadcrumbs"><span>内容工作台</span><ChevronRight size={14}/><strong>{({ home: '工作台', materials: '素材', articles: '文章', discover: '热点发现', files: '文件', database: '数据库', settings: '设置与文件' } as const)[view]}</strong></div><div className="top-actions"><button className="agent-toggle" aria-expanded={agentPanelOpen} aria-controls="agent-dock" onClick={() => { if (!agentPanelOpen) resetStaleConversation(); setAgentPanelOpen(open => !open); }}><Bot size={15}/>{agentRunning ? 'Agent 正在工作' : 'Agent 对话'}{request && <span className="agent-attention">需要回复</span>}</button><span className="local-badge"><span/> 本地运行</span><button className="icon-button" title="刷新工具状态" onClick={detect}><RefreshCw size={16}/></button></div></header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={15}/></button></div>}
      <div className="work-area"><div className="work-view">
      <ContentWorkspace view={view} root={root} desktop={desktop} agentRunning={agentRunning} agentSetupNeeded={desktop && agentsDetected && !(agentChecked && agents.some(a => a.path)) && !setupReport?.agents.some(a => a.path && a.auth === 'configured' && agents.some(found => found.id === a.id && found.path))} onAgentSettings={() => setView('settings')} onNavigate={setView} onDirty={setContentDirty} onBusy={setContentBusy} onArticleContext={setArticleContext} onArticleApply={setArticleApply} onAgent={(task, context, selection) => { if (agentRunning) { setNotice('Agent 正在执行任务，请结束后再发送新任务。'); return; } if (prompt.trim() && !window.confirm('Agent 输入框已有未发送的内容，确定替换吗？')) return; if (!agentPanelOpen) resetStaleConversation(); setPrompt(''); setSelectedText(selection || ''); setTaskSuggestion(selection ? '' : task.replace(/\n\n我的要求：$/, '').trim()); taskContext.current = context || null; setAgentPanelOpen(true); requestAnimationFrame(() => promptRef.current?.focus()); }}/>
      {view === 'settings' && <div className="page tool-page"><div className="tool-heading"><div><span className="section-kicker">SETTINGS</span><h1>设置与文件</h1><p>管理本地内容位置与高级工具。</p></div></div><section className="settings-agents" id="agent-settings"><div className="section-head"><div><span className="section-kicker">LOCAL AGENTS</span><h2>本地 Agent</h2><p>检查安装与登录状态。应用内对话不需要配置 MCP。</p></div><button className="secondary-button" disabled={!desktop || !root || checkingAgents || connecting} onClick={inspectAgents}><RefreshCw size={14}/>{checkingAgents ? '检查中…' : '检查状态与连接'}</button></div>{!setupReport && <div className="agent-status-empty">{agentsDetected ? (agents.some(a => a.path) ? '已检测到本机 Agent，点击检查查看登录和连接状态。' : '尚未检测到 Codex 或 Claude Code，请先安装并登录。') : '正在检测本机 Agent…'}</div>}        {setupReport && <div className="setup-results"><div className="panel-title"><span>最近检查结果</span><small>工作目录：{setupReport.workspace}</small></div>{setupReport.agents.map(agent => <div className="setup-result" key={agent.id}><span><b>{agentInfo[agent.id]?.name || agent.id}</b><small>{agent.version || '未检测到'}{agent.path ? ` · ${agent.path}` : ''}</small></span><div><strong className={agent.bridge === 'connected' ? 'setup-success' : 'setup-warning'}>{agent.bridge === 'connected' ? 'MCP 已配置' : agent.bridge === 'not_installed' ? '未安装' : agent.bridge === 'conflict' ? 'MCP 配置冲突' : agent.bridge === 'not_connected' ? 'MCP 未配置' : 'MCP 状态待检查'}</strong><small>{agent.auth === 'configured' ? '登录已配置，实际请求时验证' : agent.auth === 'not_logged_in' ? '未登录' : '登录状态未知'} · {agent.detail}</small></div></div>)}</div>}
<details className="agent-advanced"><summary>外部 Agent 连接（MCP）</summary>        <div className="bridge-section"><div className="section-head"><div><span className="section-kicker">CONNECT TO SEABIRD</span><h2>让外部 Agent 使用 Seabird</h2></div><button className="primary-button" disabled={!setupCommand || !root} onClick={copyAgentTask}>复制配置任务</button></div><p>将配置任务粘贴给本机 Codex 或 Claude Code，让它检查并配置自己的连接。MCP 允许它读取、创建和覆盖当前工作目录中的文本文件。</p><p>也可以直接连接全部已安装的 Agent：</p><div className="setup-command-row">{setupCommand && <pre className="setup-command" tabIndex={0}>{setupCommand}</pre>}<button className="secondary-button" disabled={!setupCommand} onClick={copySetupCommand}>复制命令</button><button className="secondary-button" disabled={!desktop || !root || connecting || agentRunning} onClick={connectAgents}>{connecting ? '正在连接…' : '一键连接'}</button></div><div className="bridge-list">{Object.entries(agentInfo).map(([id, info]) => <div key={id}><span><b>{info.name}</b><small>{agents.find(a => a.id === id)?.path ? '已安装' : '未检测到'}</small></span><div className="bridge-buttons"><button className="text-button" disabled={!desktop || !!registering || connecting || !agents.find(a => a.id === id)?.path} onClick={() => unregisterBridge(id)}>{registering === id ? '处理中…' : '移除 MCP 连接'}</button></div></div>)}</div><small className="bridge-help">连接绑定当前目录；切换目录后，需要先移除 Agent 中原有的 seabird 连接，再重新注册。配置后请在新会话中验证。</small></div></details></section><div className="workspace-card"><div className="folder-art"><FolderOpen size={24}/></div><div className="workspace-card-copy"><div className="card-title">本地素材目录</div><p>{root || '尚未选择目录'}</p></div><button className="secondary-button" onClick={chooseFolder}>切换目录</button></div><p className="settings-note">图片和视频保存在此目录。切换目录会显示该目录对应的素材和文章；数据库与连接配置保存在系统应用数据目录。</p><div className="settings-storage"><b>数据库与配置备份</b><span>{backupPath || '桌面应用中显示备份位置'}</span><small>素材与文章保存后会更新本地数据库备份；连接配置也会保留备份。备份不包含图片和视频文件，请另行备份素材目录。</small></div><div className="quick-grid settings-tools"><button onClick={() => setView('files')}><span className="quick-icon blue"><FileText size={18}/></span><span><b>浏览本地文件</b><small>查看当前目录的文件</small></span><ArrowUpRight size={16}/></button><button onClick={() => setView('database')}><span className="quick-icon purple"><Database size={18}/></span><span><b>数据库工具</b><small>查看本地数据与数据库位置</small></span><ArrowUpRight size={16}/></button></div></div>}
      {view === 'files' && <div className="page tool-page"><div className="tool-heading"><div><span className="section-kicker">YOUR FILES</span><h1>文件</h1><p>浏览和编辑工作目录中的文本文件。</p></div><button className="secondary-button" onClick={chooseFolder}><FolderOpen size={16}/> {root ? '切换目录' : '选择文件夹'}</button></div>{file ? <div className="editor-panel"><div className="editor-header"><div><FileCode2 size={16}/><b>{basename(file)}</b>{dirty && <span className="unsaved">未保存</span>}</div><button className="primary-button" onClick={save} disabled={!dirty}><Save size={15}/> 保存</button></div><div className="file-path">{file}</div><textarea className="editor" aria-label="文件内容" spellCheck={false} value={content} onChange={e => setContent(e.target.value)}/><div className="editor-footer">纯文本编辑器 <span>{content.split('\n').length} 行 · ⌘ / Ctrl + S 保存</span></div></div> : <div className="empty-state"><div className="empty-icon"><FileText size={25}/></div><h3>选择一个文件</h3><p>{root ? '从左侧文件浏览器打开文本文件。' : '先选择一个工作目录，然后从左侧打开文件。'}</p>{!root && <button className="primary-button" onClick={chooseFolder}>选择工作目录</button>}</div>}</div>}
      {view === 'database' && <div className="page tool-page"><div className="tool-heading"><div><span className="section-kicker">LOCAL DATABASE</span><h1>数据库</h1><p>用 SQL 查询和管理你的本地数据。</p></div><span className="database-badge"><span className="status-dot"/> SQLite 3</span></div><div className="db-location"><HardDrive size={16}/><span><b>应用数据库</b><small>{dbPath || '在桌面应用中可用'}</small></span></div><div className="sql-panel"><div className="panel-title"><span><Braces size={16}/> SQL 查询</span><small>每次执行一条语句</small></div><textarea spellCheck={false} aria-label="SQL 查询" value={sql} onChange={e => setSql(e.target.value)}/><div className="sql-actions"><span>内置 notes 表，可自由创建其他表。</span><button className="primary-button" onClick={executeSql} disabled={!desktop || busy || !sql.trim()}><Play size={14} fill="currentColor"/> 执行查询</button></div></div><div className="result-panel"><div className="panel-title"><span><Database size={16}/> 查询结果</span><small>{result?.message || '等待执行'}</small></div>{result?.columns.length ? <div className="table-wrap"><table><thead><tr>{result.columns.map((col, i) => <th key={i}>{col}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>{result.rows.length === 0 && <div className="result-empty">没有匹配的数据</div>}</div> : <div className="result-empty">{result ? result.message : '执行查询后，结果将显示在这里。'}</div>}</div></div>}
      </div>
      {agentPanelOpen && <aside id="agent-dock" className="agent-dock" aria-label="Agent 对话"><div className="agent-dock-header"><h2><Bot size={18}/> Agent 对话</h2><div className="agent-header-actions"><button className="text-button" disabled={agentRunning || deletingHistory} onClick={() => { if ((prompt.trim() || references.length > 0) && !window.confirm('输入框已有未发送的内容，确定新建对话吗？')) return; setPrompt(''); setTaskSuggestion(''); taskContext.current = null; setSelectedText(''); clearReferences(); setCurrentId(''); setRequests([]); followTranscript.current = true; if (historyRef.current) historyRef.current.open = false; promptRef.current?.focus(); }}><Plus size={14}/>新建会话</button><details className="history-menu" ref={historyRef}><summary><History size={14}/>历史会话</summary><div className="history-popover"><div className="history-menu-head"><b>历史会话</b>{conversations.length > 0 && <button className="text-button" disabled={agentRunning || deletingHistory} onClick={() => void deleteHistory()}>清空</button>}</div><div className="history-menu-list">{conversations.length ? conversations.map(c => <div className={conversationId === c.id ? 'history-row selected' : 'history-row'} key={c.id}><button className="history-open" disabled={agentRunning || deletingHistory} onClick={() => { if ((prompt.trim() || references.length > 0) && !window.confirm('输入框已有未发送的内容，确定切换对话吗？')) return; setPrompt(''); setTaskSuggestion(''); taskContext.current = null; setSelectedText(''); clearReferences(); setCurrentId(c.id); setSelectedAgent(c.agent); setRequests([]); if (historyRef.current) historyRef.current.open = false; }}><b>{c.title}</b><small>{agentInfo[c.agent]?.name || c.agent}</small></button><button className="history-delete" disabled={agentRunning || deletingHistory} aria-label={`删除会话 ${c.title}`} title="删除" onClick={() => void deleteHistory(c.id)}><Trash2 size={14}/></button></div>) : <div className="history-empty">暂无会话</div>}</div></div></details><button className="icon-button" aria-label="收起 Agent 对话" onClick={() => setAgentPanelOpen(false)}><X size={17}/></button></div></div>
        <div className="agent-transcript" ref={transcriptRef} onScroll={e => { const el = e.currentTarget; followTranscript.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-label="对话记录">
          {!agentOutput && messages.length === 0 && <div className="chat-empty"><Bot size={22}/><strong>开始对话</strong></div>}
          {agentOutput && <div className="chat-message chat-legacy"><pre>{agentOutput}</pre></div>}
          {messages.map((message, index) => {
            if (message.role === 'activity') return <details className="chat-activity" key={index}><summary>执行过程</summary><pre>{message.text}</pre></details>;
            const articleEdit = message.role === 'assistant' && message.articleTarget ? parseArticleEdit(message.text) : { text: message.text, edit: null };
            const parsed = message.role === 'assistant' && !message.articleTarget ? parseSaveSuggestions(articleEdit.text) : { text: articleEdit.text, suggestions: [] };
            return <div className={`chat-message chat-${message.role}`} key={index}><div className="chat-label">{message.role === 'user' ? '你' : message.role === 'assistant' ? (agentInfo[currentConversation?.agent || '']?.name || 'Agent') : '状态'}</div>{parsed.text && <pre>{parsed.text}</pre>}{parsed.suggestions.map((suggestion, suggestionIndex) => {
              const saved = message.savedSuggestions?.[suggestionIndex];
              return <div className="chat-save-suggestion" key={suggestionIndex}><div><small>{suggestion.kind === 'material' ? '建议保存为素材' : '建议保存为文章'}</small><strong>{suggestion.title}</strong></div><button type="button" className="content-soft" disabled={!!saved || agentRunning || !!savingSuggestion || !desktop} onClick={() => void saveSuggestion(index, suggestionIndex, suggestion)}>{saved ? '已保存' : savingSuggestion === `${index}:${suggestionIndex}` ? '保存中…' : suggestion.kind === 'material' ? '保存素材' : '保存文章'}</button><details><summary>查看保存内容</summary><pre>{suggestion.body}{suggestion.source && `\n\n来源：${suggestion.source}`}{suggestion.url && `\n链接：${suggestion.url}`}{suggestion.tags && `\n标签：${suggestion.tags}`}</pre></details>{saved?.warning && <p role="status">已保存，但备份失败：{saved.warning}</p>}</div>;
            })}{articleEdit.edit && message.articleTarget && <div className="chat-save-suggestion"><div><small>{message.articleTarget.selection ? '选中内容的修改' : '当前文章的修改'}</small><strong>{articleEdit.edit.title || (message.articleTarget.selection ? '替换选中的内容' : '更新当前版本')}</strong></div><button type="button" className="content-soft" disabled={message.editApplied || agentRunning} onClick={() => applySuggestedEdit(index, message, articleEdit.edit!)}>{message.editApplied ? '已应用' : message.articleTarget.selection ? '替换选中内容' : '应用到文章'}</button><details open={!!message.articleTarget.selection}><summary>查看修改内容</summary>{message.articleTarget.selection && <><small>原文</small><pre>{message.articleTarget.selection.text}</pre></>}<small>修改后</small><pre>{articleEdit.edit.body}</pre></details></div>}</div>;
          })}
          {suggestionError && <div className="chat-save-error" role="alert">{suggestionError}</div>}
          {agentRunning && <div className="chat-working" role="status"><span/> 正在处理…</div>}
        </div>
        <div className="agent-composer">
        {request && <div className="request-panel" role="region" aria-label="Agent 请求" ref={requestPanelRef} tabIndex={-1}><div className="panel-title"><span>{!supportedRequest ? '暂不支持此类请求' : requestQuestions(request).length ? 'Agent 需要你的回答' : 'Agent 请求操作权限'}</span><small>{request.method}</small></div>{requestQuestions(request).length ? requestQuestions(request).map(q => <div className="request-question" key={q.id}><label htmlFor={`answer-${q.id}`}>{q.label}{q.multiple ? '（多项可用逗号分隔）' : ''}</label>{q.options.length > 0 && <div className="answer-options">{q.options.map(option => <button key={option} type="button" className="secondary-button" onClick={() => setAnswers(previous => ({ ...previous, [q.id]: q.multiple && previous[q.id] ? `${previous[q.id]}, ${option}` : option }))}>{option}</button>)}</div>}<input id={`answer-${q.id}`} type={q.secret ? "password" : "text"} value={answers[q.id] || ''} onChange={event => setAnswers(previous => ({ ...previous, [q.id]: event.target.value }))} placeholder="输入或选择回答" /></div>) : <pre>{JSON.stringify(request.params, null, 2)}</pre>}{approvalPrefix && <div className="request-rule">允许后会记住以下命令前缀，今后匹配此规则的命令无需再次确认：<code>{JSON.stringify(approvalPrefix)}</code></div>}{!approvalPrefix && sessionApproval && <div className="request-rule">允许后，本次会话中的同类操作无需再次确认。</div>}<div className="request-actions"><button className="secondary-button" disabled={responding || !supportedRequest || (Array.isArray(request.params.availableDecisions) && !request.params.availableDecisions.includes('decline') && !request.params.availableDecisions.includes('cancel'))} onClick={() => respondToAgent('deny')}>拒绝</button><button className="primary-button" disabled={responding || !supportedRequest || !canApprove} onClick={() => respondToAgent('allow')}>{requestQuestions(request).length ? '提交回答' : approvalPrefix ? '允许并记住' : sessionApproval ? '本次会话允许' : '允许'}</button></div></div>}
        <div className="task-panel">
          <textarea ref={promptRef} aria-label="消息内容" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !agentRunning && desktop && root && agentEventsReady && !historyLoading && agents.find(a => a.id === selectedAgent)?.path) { e.preventDefault(); void runAgent(); } }} placeholder={agentRunning ? '输入下一条消息…' : selectedText ? '说说你想怎么修改…' : '输入消息…'}/>{(taskContext.current || articleContextAvailable || (!agentRunning && taskSuggestion && !prompt.trim())) && <div className="task-tools">{taskContext.current ? <span className="task-context" title={selectedText || undefined}>{selectedText ? `选中：${selectedText.replace(/\s+/g, ' ').slice(0, 32)}${selectedText.length > 32 ? '…' : ''}` : '已关联当前内容'}<button type="button" aria-label="取消关联内容" onClick={() => { taskContext.current = null; setSelectedText(''); setTaskSuggestion(''); }}>×</button></span> : articleContextAvailable && <span>当前文章</span>}{!agentRunning && taskSuggestion && !prompt.trim() && <button type="button" className="task-suggestion" onClick={() => { setPrompt(taskSuggestion); promptRef.current?.focus(); }}>{taskSuggestion}</button>}</div>}{selectedText && !prompt.trim() && !agentRunning && <div className="article-quick-actions" aria-label="修改选中文字">{[['润色', '请润色选中的文字，让表达更清楚自然，保留原意。'], ['精简', '请精简选中的文字，保留关键意思。'], ['扩写', '请适当扩写选中的文字，保持原有语气，不编造事实。'], ['更自然', '请让选中的文字更自然，更像人说话，保留原意。']].map(([label, task]) => <button type="button" key={label} disabled={!desktop || !root || !agentEventsReady || historyLoading || deletingHistory || !agents.find(a => a.id === selectedAgent)?.path} onClick={() => void runAgent(task)}>{label}</button>)}</div>}{references.length > 0 && <div className="reference-chips" aria-label="已引用内容">{references.map(item => <span className="reference-chip" key={`${item.kind}-${item.id}`}>{item.kind === 'article' ? <FileText size={13}/> : <Bookmark size={13}/>}<span title={item.title}>{item.title}</span><button type="button" aria-label={`移除引用 ${item.title}`} onClick={() => setReferences(current => current.filter(ref => ref.kind !== item.kind || ref.id !== item.id))}><X size={13}/></button></span>)}</div>}
          {referencePickerOpen && <div className="reference-picker"><div className="reference-picker-head"><b>引用文章或素材</b><button type="button" aria-label="关闭引用选择" onClick={() => setReferencePickerOpen(false)}><X size={14}/></button></div><input autoFocus aria-label="搜索文章或素材" placeholder="搜索文章或素材" value={referenceSearch} onChange={e => setReferenceSearch(e.target.value)}/><div className="reference-list">{referenceLoading ? <p>正在读取…</p> : referenceError ? <p role="alert">{referenceError}</p> : referenceItems.filter(item => item.title.toLocaleLowerCase().includes(referenceSearch.trim().toLocaleLowerCase())).length ? referenceItems.filter(item => item.title.toLocaleLowerCase().includes(referenceSearch.trim().toLocaleLowerCase())).map(item => { const selected = references.some(ref => ref.kind === item.kind && ref.id === item.id); return <button type="button" key={`${item.kind}-${item.id}`} aria-pressed={selected} onClick={() => setReferences(current => selected ? current.filter(ref => ref.kind !== item.kind || ref.id !== item.id) : [...current, item])}>{item.kind === 'article' ? <FileText size={14}/> : <Bookmark size={14}/>}<span>{item.title}</span><small>{selected ? '已选择' : item.kind === 'article' ? '文章' : '素材'}</small></button>; }) : <p>{referenceSearch ? '没有找到匹配的内容' : '还没有文章或素材'}</p>}</div></div>}
          <div className="task-actions"><button type="button" className="reference-add" disabled={!root} aria-expanded={referencePickerOpen} onClick={() => setReferencePickerOpen(open => !open)}><Plus size={14}/> 引用</button><div className="agent-select"><label htmlFor="agent-select" className="sr-only">选择 Agent</label><select id="agent-select" aria-label="选择 Agent" value={selectedAgent} disabled={agentRunning || deletingHistory} onChange={e => chooseAgent(e.target.value)}>{Object.entries(agentInfo).map(([id, info]) => <option key={id} value={id}>{info.name}{agents.find(a => a.id === id)?.path ? '' : '（未检测到）'}</option>)}</select></div>{!agents.find(a => a.id === selectedAgent)?.path && <button className="text-button agent-setup-link" onClick={() => setView('settings')}>前往设置</button>}{agentRunning ? <button className="secondary-button" disabled={stoppingAgent} onClick={stopAgent}><Square size={12} fill="currentColor"/>{stoppingAgent ? '停止中' : '停止'}</button> : <button className="primary-button" disabled={!desktop || !root || !agentEventsReady || historyLoading || deletingHistory || !prompt.trim() || !agents.find(a => a.id === selectedAgent)?.path} onClick={() => void runAgent()}><Send size={14}/><span>发送</span></button>}</div></div>

</div></aside>}
      </div>
      <div className="bottom-bar"><span><span className="status-dot"/> {desktop ? '本地模式' : '浏览器预览'}</span><span>{root ? basename(root) : '未选择工作目录'} <span className="bottom-separator">/</span> Seabird</span></div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
