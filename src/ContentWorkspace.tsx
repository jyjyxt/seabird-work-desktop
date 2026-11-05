import React, { useEffect, useMemo, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowLeft, ArrowRight, Bookmark, ExternalLink, FileText, Link2, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react';
import './content.css';

export type ContentView = 'home' | 'materials' | 'articles' | 'discover';
type MediaFile = { path: string; name: string; kind: 'image' | 'video' };
type Material = { id: number; title: string; source: string; url: string; note: string; tags: string; media: MediaFile[]; updated_at: string };
type Version = { title: string; body: string };
type Article = { id: number; title: string; body: string; tags: string; versions: Record<string, Version>; material_ids: number[]; updated_at: string };
type Trend = { title: string; source: string; url: string; note: string };
type ContentData = { materials: Material[]; articles: Article[] };
type SaveResult = { id: number; backup_warning: string | null };
type Props = { view: string; root: string; desktop: boolean; agentRunning: boolean; agentSetupNeeded: boolean; onAgentSettings: () => void; onNavigate: (view: ContentView) => void; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void; onAgent: (prompt: string, context?: () => string) => void };
const emptyMaterial = (): Material => ({ id: 0, title: '', source: '', url: '', note: '', tags: '', media: [], updated_at: '' });
const emptyArticle = (material_ids: number[] = []): Article => ({ id: 0, title: '', body: '', tags: '', versions: {}, material_ids, updated_at: '' });
const platforms = [{ id: 'original', label: '原稿' }, { id: 'x', label: 'X' }, { id: 'wechat', label: '公众号' }, { id: 'xiaohongshu', label: '小红书' }];
const parseTags = (value: string = '') => [...new Map(value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean).map(tag => [tag.toLocaleLowerCase(), tag])).values()];
const snippet = (text: string) => text.replace(/\s+/g, ' ').trim();
const stamp = (date: string) => date ? `${date.slice(0, 16).replace('T', ' ')} UTC` : '刚刚创建';

function MediaPreview({ media }: { media: MediaFile }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [media.path]);
  return <div className="content-media-preview">{failed ? <div className="content-media-missing">无法预览此文件，请检查文件是否存在或格式是否受支持。</div> : media.kind === 'image' ? <img src={convertFileSrc(media.path)} alt={media.name} onError={() => setFailed(true)}/> : <video src={convertFileSrc(media.path)} controls preload="metadata" onError={() => setFailed(true)}/>}<span title={media.path}>{media.name}</span></div>;
}

// The browser preview is isolated from the desktop database.
const previewKey = (root: string) => `seabird-content-preview:${root}`;
function previewLoad(root: string): ContentData {
  try { const data = JSON.parse(localStorage.getItem(previewKey(root)) || '{"materials":[],"articles":[]}') as ContentData; return { ...data, articles: data.articles.map(article => ({ ...article, tags: article.tags || '' })) }; }
  catch { return { materials: [], articles: [] }; }
}

export default function ContentWorkspace({ view, root, desktop, agentRunning, agentSetupNeeded, onAgentSettings, onNavigate, onDirty, onBusy, onAgent }: Props) {
  const [data, setData] = useState<ContentData>({ materials: [], articles: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [material, setMaterial] = useState<Material | null>(null);
  const [viewedMaterial, setViewedMaterial] = useState<Material | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const materialSnapshot = React.useRef('');
  const articleSnapshot = React.useRef('');
  const [platform, setPlatform] = useState('original');
  const editorEpoch = React.useRef(0);
  const liveEditor = React.useRef({ article, material, platform });
  liveEditor.current = { article, material, platform };
  const [saving, setSaving] = useState(false);
  const [trends, setTrends] = useState<Trend[]>([]);
  const [trendAccount, setTrendAccount] = useState('');
  const [loadingTrends, setLoadingTrends] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const loadGeneration = React.useRef(0);
  const activeRoot = React.useRef(root);
  activeRoot.current = root;
  const visible = ['home', 'materials', 'articles', 'discover'].includes(view);
  const edit = view === 'materials' ? material : view === 'articles' ? article : null;
  const dirty = !!edit && JSON.stringify(edit) !== (view === 'materials' ? materialSnapshot.current : articleSnapshot.current);
  const anyDirty = !!(material && JSON.stringify(material) !== materialSnapshot.current) || !!(article && JSON.stringify(article) !== articleSnapshot.current);
  const closeState = React.useRef({ anyDirty, saving });
  closeState.current = { anyDirty, saving };
  useEffect(() => { onDirty(anyDirty); }, [anyDirty, onDirty]);
  useEffect(() => { onBusy(saving); }, [saving, onBusy]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(event => {
      if (closeState.current.saving) { event.preventDefault(); setError('正在保存内容或导入文件，请完成后再关闭。'); return; }
      if (closeState.current.anyDirty && !window.confirm('素材或文章有未保存的修改，确定关闭吗？')) event.preventDefault();
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => setError(`无法启用关闭提示：${String(error)}`));
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);
  const load = async () => {
    if (!root || activeRoot.current !== root) return;
    const generation = ++loadGeneration.current;
    setLoading(true); setError('');
    try { const result = desktop ? await invoke<ContentData>('content_load', { root }) : previewLoad(root); if (generation === loadGeneration.current) setData(result); return result; }
    catch (e) { if (generation === loadGeneration.current) setError(`无法读取内容：${String(e)}`); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  };
  useEffect(() => { setData({ materials: [], articles: [] }); setMaterial(null); setViewedMaterial(null); setArticle(null); setSelected([]); setTrends([]); setTrendAccount(''); void load(); return () => { loadGeneration.current++; }; }, [root, desktop]);
  useEffect(() => { setSearch(''); setSelectedTag(''); }, [view, root]);
  const previousState = React.useRef({ view, agentRunning });
  useEffect(() => {
    const shouldRefresh = previousState.current.agentRunning && !agentRunning;
    previousState.current = { view, agentRunning };
    if (!shouldRefresh || !visible || !root) return;
    void load().then(fresh => {
      if (!fresh) return;
      setArticle(current => { if (!current || !current.id || JSON.stringify(current) !== articleSnapshot.current) return current; const latest = fresh.articles.find(a => a.id === current.id); if (!latest) return current; articleSnapshot.current = JSON.stringify(latest); return latest; });
      setMaterial(current => { if (!current || !current.id || JSON.stringify(current) !== materialSnapshot.current) return current; const latest = fresh.materials.find(m => m.id === current.id); if (!latest) return current; materialSnapshot.current = JSON.stringify(latest); return latest; });
    });
  }, [view, agentRunning]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (anyDirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);
  const saveItem = async (kind: 'material' | 'article', item: Material | Article): Promise<SaveResult> => {
    if (!root) throw new Error('请先选择工作目录');
    if (desktop) { const snapshot = kind === 'material' ? materialSnapshot.current : articleSnapshot.current; const expected = item.id && snapshot ? JSON.parse(snapshot) : null; return invoke<SaveResult>(kind === 'material' ? 'content_save_material' : 'content_save_article', { root, item, expected }); }
    const previous = previewLoad(root);
    const id = item.id || Date.now();
    const saved = { ...item, id, updated_at: new Date().toISOString() };
    if (kind === 'material') previous.materials = [saved as Material, ...previous.materials.filter(x => x.id !== id)];
    else previous.articles = [saved as Article, ...previous.articles.filter(x => x.id !== id)];
    localStorage.setItem(previewKey(root), JSON.stringify(previous));
    return { id, backup_warning: null };
  };
  const removeItem = async (kind: 'material' | 'article', id: number) => {
    const item = kind === 'material' ? data.materials.find(item => item.id === id) : data.articles.find(item => item.id === id);
    const name = item?.title || (kind === 'material' ? '这条素材' : '这篇文章');
    const deletingEdit = kind === 'material' ? material?.id === id && JSON.stringify(material) !== materialSnapshot.current : article?.id === id && JSON.stringify(article) !== articleSnapshot.current;
    const detail = (kind === 'material' ? '已关联的文章将移除这条引用，附件文件会保留。' : '平台版本也会一并删除。') + (deletingEdit ? '未保存的修改也会丢失。' : '');
    if (!window.confirm(`删除“${name}”？${detail}`)) return;
    setSaving(true); setError('');
    try {
      let backupWarning: string | null = null;
      if (desktop) backupWarning = await invoke<string | null>('content_delete', { root, kind, id });
      else { const previous = previewLoad(root); if (kind === 'material') { previous.materials = previous.materials.filter(x => x.id !== id); previous.articles = previous.articles.map(a => ({ ...a, material_ids: a.material_ids.filter(x => x !== id) })); } else previous.articles = previous.articles.filter(x => x.id !== id); localStorage.setItem(previewKey(root), JSON.stringify(previous)); }
      if (kind === 'material') { if (material?.id === id) { setMaterial(null); materialSnapshot.current = ''; } setViewedMaterial(current => current?.id === id ? null : current); setSelected(s => s.filter(x => x !== id)); }
      else if (article?.id === id) { setArticle(null); articleSnapshot.current = ''; }
      await load(); if (backupWarning) setError(`已删除，但备份更新失败：${backupWarning}`); else setMessage('已删除');
    } catch (e) { setError(`删除失败：${String(e)}`); } finally { setSaving(false); }
  };
  const editMaterial = (item: Material) => { if (material && JSON.stringify(material) !== materialSnapshot.current && !window.confirm('素材有未保存的修改，确定放弃吗？')) return; editorEpoch.current++; setViewedMaterial(null); materialSnapshot.current = JSON.stringify(item); setMaterial({ ...item }); setError(''); onNavigate('materials'); };
  const openSource = async (rawUrl: string) => {
    let url: URL;
    try { url = new URL(rawUrl.trim()); }
    catch { setError('链接格式不正确，请编辑素材'); return; }
    if (!['http:', 'https:'].includes(url.protocol)) { setError('请使用 http 或 https 链接'); return; }
    setError('');
    if (!desktop) { window.open(url.href, '_blank', 'noopener,noreferrer'); return; }
    try { await invoke('content_open_url', { url: url.href }); }
    catch (e) { setError(`无法打开链接：${String(e)}`); }
  };
  const viewMaterial = (item: Material) => {
    if (item.url.trim()) { void openSource(item.url); return; }
    if (material && JSON.stringify(material) !== materialSnapshot.current && !window.confirm('素材有未保存的修改，确定放弃吗？')) return;
    setMaterial(null); materialSnapshot.current = ''; setViewedMaterial(item); setError(''); onNavigate('materials');
  };
  const editArticle = (item: Article) => { if (article && JSON.stringify(article) !== articleSnapshot.current && !window.confirm('文章有未保存的修改，确定放弃吗？')) return; editorEpoch.current++; articleSnapshot.current = JSON.stringify(item); setArticle(structuredClone(item)); setPlatform('original'); setError(''); onNavigate('articles'); };
  const closeEditor = () => {
    if (dirty && !window.confirm('有未保存的修改，确定放弃吗？')) return;
    editorEpoch.current++;
    if (view === 'materials') { setMaterial(null); materialSnapshot.current = ''; }
    else { setArticle(null); articleSnapshot.current = ''; }
  };
  const saveCurrent = async () => {
    if (!edit || saving) return;
    setSaving(true); setError('');
    try {
      const kind = view === 'materials' ? 'material' : 'article';
      const result = await saveItem(kind, edit);
      const fresh = await load();
      const updated = (kind === 'material' ? fresh?.materials.find(x => x.id === result.id) : fresh?.articles.find(x => x.id === result.id)) || { ...edit, id: result.id };
      if (kind === 'material') { materialSnapshot.current = JSON.stringify(updated); setMaterial(updated as Material); }
      else { articleSnapshot.current = JSON.stringify(updated); setArticle(updated as Article); }
       if (result.backup_warning) setError(`内容已保存，但备份失败：${result.backup_warning}`); else setMessage('已保存');
    } catch (e) {
      const detail = String(e);
      if (detail.includes('已被修改')) { await load(); setError(`${detail}。手动编辑仍保留在这里；可先复制内容，再返回列表打开最新版本。`); }
      else setError(`保存失败：${detail}`);
    } finally { setSaving(false); }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || !edit) return;
      event.preventDefault();
      if (!edit.title.trim()) { setError('请输入标题后保存'); return; }
      void saveCurrent();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const importMedia = async () => {
    if (!desktop) { setError('请在桌面应用中导入图片和视频。'); return; }
    try {
      const paths = await open({ multiple: true, filters: [{ name: '图片和视频', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'mp4', 'mov', 'm4v', 'webm'] }] });
      if (!paths) return;
      setSaving(true); setError('');
      for (const path of Array.isArray(paths) ? paths : [paths]) {
        const media = await invoke<MediaFile>('content_import_media', { root, path });
        setMaterial(previous => previous ? { ...previous, media: [...previous.media, media] } : previous);
      }
      setMessage('文件已复制到本地素材目录，请保存素材');
    } catch (e) { setError(`导入失败：${String(e)}`); }
    finally { setSaving(false); }
  };
  const refreshTrends = async () => {
    if (!desktop) { setError('请在桌面应用中连接 cloudl 后查看热点。'); return; }
    setLoadingTrends(true); setError('');
    try { const result = await invoke<{ account: string; items: Trend[] }>('content_trends'); setTrends(result.items); setTrendAccount(result.account); }
    catch (e) { setError(String(e)); }
    finally { setLoadingTrends(false); }
  };
  const bookmarkTrend = async (trend: Trend) => {
    setSaving(true); setError('');
    try { const result = await saveItem('material', { ...emptyMaterial(), ...trend, url: trend.url || `https://x.com/search?q=${encodeURIComponent(trend.title)}`, note: [trend.note, '链接为 X 话题搜索结果'].filter(Boolean).join(' · ') }); await load(); if (result.backup_warning) setError(`素材已保存，但备份失败：${result.backup_warning}`); else setMessage('已保存到素材'); }
    catch (e) { setError(`收藏失败：${String(e)}`); } finally { setSaving(false); }
  };
  const filter = (text: string) => text.toLowerCase().includes(search.trim().toLowerCase());
  const tagsFor = (value: string) => !selectedTag || parseTags(value).some(tag => tag.toLocaleLowerCase() === selectedTag.toLocaleLowerCase());
  const materials = useMemo(() => data.materials.filter(m => filter([m.title, m.source, m.tags, m.note].join(' ')) && tagsFor(m.tags)), [data.materials, search, selectedTag]);
  const articles = useMemo(() => data.articles.filter(a => filter([a.title, a.body, a.tags].join(' ')) && tagsFor(a.tags)), [data.articles, search, selectedTag]);
  const availableTags = useMemo(() => {
    const items = view === 'materials' ? data.materials : data.articles;
    const unique = new Map<string, string>();
    items.forEach(item => parseTags(item.tags).forEach(tag => { if (!unique.has(tag.toLocaleLowerCase())) unique.set(tag.toLocaleLowerCase(), tag); }));
    return [...unique.values()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [data.materials, data.articles, view]);
  const tagFilters = availableTags.length > 0 && <div className="content-tag-filters" role="group" aria-label="按标签筛选"><button type="button" className={!selectedTag ? 'active' : ''} aria-pressed={!selectedTag} onClick={() => setSelectedTag('')}>全部</button>{availableTags.map(tag => <button type="button" key={tag} className={selectedTag.toLocaleLowerCase() === tag.toLocaleLowerCase() ? 'active' : ''} aria-pressed={selectedTag.toLocaleLowerCase() === tag.toLocaleLowerCase()} onClick={() => setSelectedTag(tag)}>{tag}</button>)}</div>;
  const askAgent = () => {
    if (!article) return;
    const initial = article;
    const initialDirty = dirty;
    const initialPlatform = platform;
    const epoch = editorEpoch.current;
    onAgent('请帮我修改这篇文章。\n\n我的要求：', () => {
      const sameEditor = editorEpoch.current === epoch && liveEditor.current.article;
      const current = sameEditor || initial;
      const unsaved = sameEditor ? JSON.stringify(current) !== articleSnapshot.current : initialDirty;
      const version = platforms.find(p => p.id === (sameEditor ? liveEditor.current.platform : initialPlatform))?.label;
      if (!current.id || unsaved) return `请先根据以下尚未保存的文章内容讨论和修改。当前版本：${version}。${current.id ? `这篇文章已保存的记录 ID 为 ${current.id}，但以下是页面上尚未保存的修改；` : ''}不要写入或覆盖任何记录，直到用户明确要求。相关素材 ID：${current.material_ids.join('、') || '无'}。\n\n当前内容：\n${JSON.stringify(current)}`;
      return `请读取 Seabird 中 ID 为 ${current.id} 的文章及其关联素材，按用户要求继续写作或修改，并将结果保存到这篇文章。当前查看的版本：${version}。保留没有要求修改的内容与其他版本。`;
    });
  };
  const askMaterialAgent = () => {
    if (!material) return;
    const initial = material;
    const initialDirty = dirty;
    const epoch = editorEpoch.current;
    onAgent('请帮我整理这条素材。\n\n我的要求：', () => {
      const sameEditor = editorEpoch.current === epoch && liveEditor.current.material;
      const current = sameEditor || initial;
      const unsaved = sameEditor ? JSON.stringify(current) !== materialSnapshot.current : initialDirty;
      if (!current.id || unsaved) return `${current.id ? `这条素材已保存的记录 ID 为 ${current.id}，但以下是页面上尚未保存的修改；` : ''}请先讨论和整理，不要写入或覆盖任何记录，直到用户明确要求。请保留准确来源和附件。\n\n当前内容：\n${JSON.stringify(current)}`;
      return `请读取并整理 Seabird 中 ID 为 ${current.id} 的素材，保留原有附件和准确来源，按用户要求修改并保存。`;
    });
  };
  return <div className="content-workspace" hidden={!visible}>
      <fieldset className="content-page content-fieldset" disabled={saving}>
      {(error || message) && <div className={`content-feedback ${error ? 'is-error' : ''}`} role="status"><span>{error || message}</span><button aria-label="关闭提示" onClick={() => { setError(''); setMessage(''); }}><X size={15}/></button></div>}
      {!root && <div className="content-empty content-empty-standalone"><strong>先选择工作目录</strong><p>素材和文章会保存在当前工作目录对应的本地工作台中。</p></div>}
      {root && view === 'home' && <>
        {agentSetupNeeded && <div className="agent-onboarding"><div className="agent-onboarding-icon"><Sparkles size={18}/></div><div><b>先准备你的本地 Agent</b><p>检查 Codex 或 Claude Code 的安装与登录状态，就可以在创作时直接与它对话。</p></div><button className="content-soft" onClick={onAgentSettings}>检查 Agent <ArrowRight size={14}/></button></div>}
        <div className="content-home-head"><div><span className="content-kicker">YOUR CONTENT SPACE</span><h1>让想法，<em>慢慢成形。</em></h1><p>从收集素材到完成文章，让想法慢慢成形。</p></div><div className="content-orbit" aria-hidden="true"><span>✳</span><small>COLLECT<br/>CREATE<br/>SHARE</small></div></div>
        <div className="content-quick-actions"><button className="content-primary" onClick={() => onNavigate('articles')}><FileText size={16}/> 文章</button><button className="content-soft" onClick={() => onNavigate('materials')}><Bookmark size={15}/> 素材</button><button className="content-link" onClick={() => onNavigate('discover')}>看看热点 <ArrowRight size={15}/></button></div>
        <div className="content-home-grid"><section className="content-panel"><div className="content-panel-head"><div><span className="content-kicker">KEEP WRITING</span><h2>继续创作 <span>{data.articles.length}</span></h2></div><button onClick={() => onNavigate('articles')}>查看全部 <ArrowRight size={14}/></button></div>{data.articles.length ? <div className="content-list">{data.articles.slice(0, 4).map(a => <button className="content-list-row" key={a.id} onClick={() => editArticle(a)}><span className="content-row-icon article-icon"><FileText size={16}/></span><span className="content-row-copy"><b>{a.title}</b><small>{snippet(a.body) || '还没有正文，继续写下你的想法。'}</small></span><span className="content-row-arrow"><ArrowRight size={15}/></span></button>)}</div> : <div className="content-panel-empty"><FileText size={20}/><p>还没有文章，记录你的第一个想法。</p></div>}</section>
        <section className="content-panel"><div className="content-panel-head"><div><span className="content-kicker">YOUR COLLECTION</span><h2>最近素材 <span>{data.materials.length}</span></h2></div><button onClick={() => onNavigate('materials')}>查看全部 <ArrowRight size={14}/></button></div>{data.materials.length ? <div className="content-list">{data.materials.slice(0, 4).map(m => <div className="content-material-row" key={m.id}><button className="content-list-row" onClick={() => viewMaterial(m)}><span className="content-row-icon material-icon"><Bookmark size={15}/></span><span className="content-row-copy"><b>{m.title}</b><small>{m.source || '个人素材'}{m.tags ? ` · ${m.tags}` : ''}</small></span><span className="content-row-arrow">{m.url.trim() ? <ExternalLink size={15}/> : <ArrowRight size={15}/>}</span></button><button className="content-material-edit" aria-label={`编辑素材 ${m.title}`} title="编辑" onClick={() => editMaterial(m)}><Pencil size={14}/></button></div>)}</div> : <div className="content-panel-empty"><Bookmark size={20}/><p>把值得保留的链接、热点和想法收集起来。</p></div>}</section></div>
        <div className="content-home-note"><span className="content-note-dot"/> 素材和文章保存在本机 · 当前工作目录</div>
      </>}
      {root && view === 'materials' && !material && !viewedMaterial && <><div className="content-page-heading"><div><span className="content-kicker">COLLECTION</span><h1>素材</h1><p>整理值得保留的链接、内容和想法。</p></div><button className="content-primary" onClick={() => editMaterial(emptyMaterial())}><Plus size={15}/> 添加素材</button></div><div className="content-toolbar"><label className="content-search"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索标题、标签或备注" /></label><span>{materials.length} 条素材</span>{selected.length > 0 && <button className="content-soft" onClick={() => editArticle(emptyArticle(selected))}>用 {selected.length} 条素材写文章 <ArrowRight size={14}/></button>}</div>{tagFilters}{loading ? <div className="content-empty">正在读取素材…</div> : materials.length ? <div className="content-cards">{materials.map(m => <article className="content-card" key={m.id}><div className="content-card-top"><label className="content-select"><input type="checkbox" checked={selected.includes(m.id)} onChange={e => setSelected(s => e.target.checked ? [...s, m.id] : s.filter(id => id !== m.id))} aria-label={`选择素材 ${m.title}`}/><span>{m.source || '个人素材'}</span></label><span>{stamp(m.updated_at)}</span></div><button className="content-card-main" onClick={() => viewMaterial(m)}><h3>{m.title}{m.url.trim() && <ExternalLink size={13}/>}</h3><p>{snippet(m.note) || (m.url ? '查看原链接' : '查看素材')}</p></button>{m.media?.[0] && <div className="content-card-media"><MediaPreview media={m.media[0]}/></div>}<div className="content-card-foot"><span className="content-card-tags">{parseTags(m.tags).length ? parseTags(m.tags).map(tag => <span className="content-tag" key={tag}>{tag}</span>) : '未添加标签'}{m.media?.length ? ` · ${m.media.length} 个文件` : ''}</span><span className="content-card-actions"><button onClick={() => editMaterial(m)} aria-label={`编辑素材 ${m.title}`}>编辑</button><button onClick={() => editArticle(emptyArticle([m.id]))}>写文章 <ArrowRight size={13}/></button><button className="content-list-delete" aria-label={`删除素材 ${m.title}`} onClick={() => void removeItem('material', m.id)}>删除</button></span></div></article>)}</div> : <div className="content-empty"><Bookmark size={24}/><strong>{search || selectedTag ? '没有找到匹配的素材' : '这里还没有素材'}</strong><p>{search || selectedTag ? '试试其他关键词或标签。' : '添加热点、链接或想法，留给下一次创作。'}</p></div>}</>}
      {root && view === 'materials' && viewedMaterial && !material && <><div className="content-editor-heading"><button className="content-back" onClick={() => setViewedMaterial(null)}><ArrowLeft size={16}/> 返回素材</button><button className="content-soft" onClick={() => editMaterial(viewedMaterial)}><Pencil size={14}/> 编辑</button></div><div className="content-form content-material-detail"><span className="content-kicker">MATERIAL</span><h1>{viewedMaterial.title}</h1>{viewedMaterial.source && <div className="content-detail-meta">{viewedMaterial.source}</div>}{viewedMaterial.tags && <div className="content-row-tags">{parseTags(viewedMaterial.tags).map(tag => <span className="content-tag" key={tag}>{tag}</span>)}</div>}{viewedMaterial.note && <p className="content-detail-note">{viewedMaterial.note}</p>}{viewedMaterial.media.length > 0 && <div className="content-media-grid">{viewedMaterial.media.map(media => <div key={media.path} className="content-media-item"><MediaPreview media={media}/></div>)}</div>}</div></>}
      {root && view === 'materials' && material && <><div className="content-editor-heading"><button className="content-back" onClick={closeEditor}><ArrowLeft size={16}/> 返回素材</button><div><button className="content-soft" onClick={askMaterialAgent}><Sparkles size={15}/> 协助整理</button><button className="content-primary" disabled={saving || !material.title.trim()} onClick={saveCurrent}>{saving ? '保存中…' : '保存'}</button></div></div><div className="content-form"><span className="content-kicker">MATERIAL</span><h1>{material.id ? '素材详情' : '添加素材'}</h1><label>标题<input value={material.title} onChange={e => setMaterial({ ...material, title: e.target.value })} placeholder="给素材一个容易记住的名字" /></label><div className="content-form-row"><label>来源<input value={material.source} onChange={e => setMaterial({ ...material, source: e.target.value })} placeholder="例如：X、公众号、个人想法" /></label><label>标签<input value={material.tags} onChange={e => setMaterial({ ...material, tags: e.target.value })} placeholder="多个标签用逗号分隔" /></label></div><label>链接<input value={material.url} onChange={e => setMaterial({ ...material, url: e.target.value })} placeholder="https://" /></label>{material.url && <><button className="content-link content-copy-source" onClick={() => void openSource(material.url)}><ExternalLink size={13}/> 打开链接</button><button className="content-link content-copy-source" onClick={async () => { try { await navigator.clipboard.writeText(material.url); setMessage('已复制链接'); } catch { setError('复制失败，请手动选择链接复制'); } }}><Link2 size={13}/> 复制链接</button></>}<label>备注<textarea value={material.note} onChange={e => setMaterial({ ...material, note: e.target.value })} placeholder="记录内容要点，或写下为什么想收藏它。" /></label><div className="content-media-heading"><b>图片和视频</b><button className="content-soft" disabled={saving} onClick={importMedia}><Plus size={14}/> 导入文件</button></div><p className="content-media-note">文件会复制到本地素材目录；移除附件或删除素材不会删除文件。支持常见图片和视频格式，单个文件不超过 1 GB。</p>{material.media.length > 0 && <div className="content-media-grid">{material.media.map(media => <div key={media.path} className="content-media-item"><MediaPreview media={media}/><button aria-label={`移除附件 ${media.name}`} onClick={() => setMaterial({ ...material, media: material.media.filter(m => m.path !== media.path) })}><X size={14}/></button></div>)}</div>}<div className="content-form-bottom"><span>{material.id === 0 ? '新素材尚未保存' : dirty ? '有未保存的修改' : '所有修改已保存'}</span>{material.id > 0 && <button className="content-delete" disabled={saving} onClick={() => void removeItem('material', material.id)}><Trash2 size={14}/> 删除素材</button>}</div></div></>}
      {root && view === 'articles' && !article && <><div className="content-page-heading"><div><span className="content-kicker">YOUR WRITING</span><h1>文章</h1><p>整理想法，写下你的文章。</p></div><button className="content-primary" onClick={() => editArticle(emptyArticle())}><Plus size={15}/> 新建文章</button></div><div className="content-toolbar"><label className="content-search"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索文章或标签" /></label><span>{articles.length} 篇文章</span></div>{tagFilters}{loading ? <div className="content-empty">正在读取文章…</div> : articles.length ? <div className="content-article-list">{articles.map(a => <div className="content-article-item" key={a.id}><button className="content-article-row" onClick={() => editArticle(a)}><span className="content-row-icon article-icon"><FileText size={18}/></span><span className="content-row-copy"><b>{a.title}</b><small>{snippet(a.body) || '还没有正文'}</small>{parseTags(a.tags).length > 0 && <span className="content-row-tags">{parseTags(a.tags).map(tag => <span className="content-tag" key={tag}>{tag}</span>)}</span>}</span><span className="content-article-meta">{a.material_ids.length} 条素材<br/>{stamp(a.updated_at)}</span><ArrowRight size={15}/></button><button className="content-article-list-delete" aria-label={`删除文章 ${a.title}`} onClick={() => void removeItem('article', a.id)}><Trash2 size={15}/><span>删除</span></button></div>)}</div> : <div className="content-empty"><FileText size={24}/><strong>{search || selectedTag ? '没有找到匹配的文章' : '你的第一篇文章，从这里开始'}</strong><p>{search || selectedTag ? '试试其他关键词或标签。' : '从一个想法或一条素材开始。'}</p></div>}</>}
      {root && view === 'articles' && article && <><div className="content-editor-heading"><button className="content-back" onClick={closeEditor}><ArrowLeft size={16}/> 返回文章</button><div><span className="content-save-state">{article.id === 0 ? '新文章尚未保存' : dirty ? '未保存' : '已保存'}</span><button className="content-soft" onClick={askAgent}><Sparkles size={15}/> 协助写作</button><button className="content-primary" disabled={saving || !article.title.trim()} onClick={saveCurrent}>{saving ? '保存中…' : '保存'}</button></div></div><div className="content-writing-layout"><div className="content-writing-main"><div className="content-tabs">{platforms.map(p => <button key={p.id} className={platform === p.id ? 'active' : ''} onClick={() => setPlatform(p.id)}>{p.label}{p.id !== 'original' && article.versions[p.id]?.body && <i/>}</button>)}</div>{platform === 'original' ? <><input className="content-title-input" aria-label="文章标题" placeholder="文章标题" value={article.title} onChange={e => setArticle({ ...article, title: e.target.value })}/><textarea className="content-body-input" aria-label="文章原稿" placeholder="写下你的想法……" value={article.body} onChange={e => setArticle({ ...article, body: e.target.value })}/></> : <><div className="content-platform-note">{platforms.find(p => p.id === platform)?.label}版本 · 独立编辑，不会修改原稿。当前仅保存草稿，发布尚未接入。</div><input className="content-title-input" aria-label="平台标题" placeholder="平台标题" value={article.versions[platform]?.title || ''} onChange={e => setArticle({ ...article, versions: { ...article.versions, [platform]: { ...article.versions[platform], title: e.target.value, body: article.versions[platform]?.body || '' } } })}/><textarea className="content-body-input" aria-label="平台正文" placeholder="在这里写下适合这个平台的版本……" value={article.versions[platform]?.body || ''} onChange={e => setArticle({ ...article, versions: { ...article.versions, [platform]: { ...article.versions[platform], title: article.versions[platform]?.title || '', body: e.target.value } } })}/><button className="content-link content-copy" onClick={async () => { try { await navigator.clipboard.writeText([article.versions[platform]?.title, article.versions[platform]?.body].filter(Boolean).join('\n\n')); setMessage('已复制平台版本'); } catch { setError('复制失败，请手动选择文字复制'); } }}>复制平台版本</button></>}</div><aside className="content-writing-aside"><label className="content-article-tags">标签<input aria-label="文章标签" value={article.tags || ''} onChange={e => setArticle({ ...article, tags: e.target.value })} placeholder="多个标签用逗号分隔" /></label><div className="content-aside-divider"/><div className="content-aside-title"><Link2 size={15}/><b>参考素材</b><span>{article.material_ids.length}</span></div><p>选中的素材会关联到这篇文章。</p><div className="content-source-list">{data.materials.length ? data.materials.map(m => <label key={m.id}><input type="checkbox" checked={article.material_ids.includes(m.id)} onChange={e => setArticle({ ...article, material_ids: e.target.checked ? [...article.material_ids, m.id] : article.material_ids.filter(id => id !== m.id) })}/><span>{m.title}</span></label>) : <small>还没有素材，可先去素材库添加。</small>}</div>{article.id > 0 && <button className="content-delete content-article-delete" disabled={saving} onClick={() => void removeItem('article', article.id)}><Trash2 size={14}/> 删除文章</button>}</aside></div></>}
      {root && view === 'discover' && <><div className="content-page-heading"><div><span className="content-kicker">DISCOVER</span><h1>热点发现</h1><p>找到值得关注的话题，收藏后用于创作。</p></div><button className="content-soft" disabled={loadingTrends} onClick={refreshTrends}><RefreshCw size={15} className={loadingTrends ? 'content-spinning' : ''}/>{loadingTrends ? '正在获取…' : '刷新热点'}</button></div><div className="content-source-strip"><span className="content-source-active">X 热点</span><small>{trendAccount ? `当前账号 @${trendAccount}` : '通过本机 cloudl 和已登录的 X 账号获取'}</small></div>{trends.length ? <div className="content-trends">{trends.map((t, i) => <div className="content-trend" key={`${t.title}-${i}`}><span className="content-trend-number">{String(i + 1).padStart(2, '0')}</span><div><h3>{t.title}</h3><p>{t.source}{t.note ? ` · ${t.note}` : ''}</p></div><button className="content-bookmark" disabled={saving || data.materials.some(m => m.source === t.source && m.title === t.title)} onClick={() => void bookmarkTrend(t)}>{data.materials.some(m => m.source === t.source && m.title === t.title) ? '已收藏' : '收藏'}</button></div>)}</div> : <div className="content-empty"><Search size={24}/><strong>{loadingTrends ? '正在获取热点' : '从今天的话题里寻找灵感'}</strong><p>{loadingTrends ? '请稍候，正在读取 X 热点。' : '点击刷新热点，通过 cloudl 读取已登录账号的 X 热门话题。'}</p>{!loadingTrends && <button className="content-soft" onClick={refreshTrends}>获取 X 热点</button>}</div>}<div className="content-discover-note">热点会随平台和账号变化。收藏后可在素材中补充链接、备注和标签。</div></>}
    </fieldset>
  </div>;
}
