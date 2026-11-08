import { useI18n } from './i18n';
import React, { useEffect, useMemo, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowLeft, ArrowRight, Bookmark, CalendarDays, ExternalLink, Eye, FileText, ImagePlus, Link2, Pencil, Play, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import './content.css';
import ArticleEditor from './ArticleEditor';
import PublicationCalendar from './PublicationCalendar';
import SocialPlatforms from './SocialPlatforms';
import { canAutoSaveArticle, isSavedArticle, mergeSavedArticle, startArticleAutoSave, type Article } from './articleAutoSave';
import { applyArticleEdit, findArticleForSuggestion, resolveArticleSelection, undoArticleEdit, type AgentContext, type ArticleEdit, type ArticleTarget } from './articleAgent';

export type ContentView = 'home' | 'materials' | 'articles' | 'calendar' | 'discover';
type MediaFile = { path: string; name: string; kind: 'image' | 'video' };
type Material = { id: number; title: string; source: string; url: string; image_url: string; video_url: string; note: string; tags: string; media: MediaFile[]; updated_at: string };
type ArticleUndo = { root: string; editor: string; before: Article; after: Article; onUndo: () => void };
type ContentTag = { kind: 'article' | 'material'; name: string; count: number };
type ContentData = { materials: Material[]; articles: Article[]; tags: ContentTag[] };
type SaveResult = { id: number; backup_warning: string | null };
type Props = { view: string; root: string; desktop: boolean; agentRunning: boolean; agentSetupNeeded: boolean; onAgentSettings: () => void; onReferenceMaterials: (materials: { id: number; title: string }[]) => boolean; onNavigate: (view: ContentView) => void; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void; onAgent: (prompt: string, context?: () => AgentContext, selectedText?: string, prefill?: boolean, newSession?: boolean) => boolean; onArticleContext: (context: (() => AgentContext) | null) => void; onArticleApply: (apply: ((target: ArticleTarget, edit: ArticleEdit, onUndo: () => void) => string | null) | null) => void; onDraftSaved: (root: string, editor: string, id: number) => void };
const emptyMaterial = (): Material => ({ id: 0, title: '', source: '', url: '', image_url: '', video_url: '', note: '', tags: '', media: [], updated_at: '' });
const emptyArticle = (material_ids: number[] = []): Article => ({ id: 0, title: '', body: '', tags: '', versions: {}, material_ids, cover: null, updated_at: '' });
const parseTags = (value: string = '') => [...new Map(value.split(/[,，\r\n]/).map(tag => tag.trim()).filter(Boolean).map(tag => [tag.toLowerCase(), tag])).values()];
const snippet = (text: string) => text.replace(/\s+/g, ' ').trim();

function TagFilters({ tags, selected, onSelect, onShowAll }: { tags: string[]; selected: string; onSelect: (tag: string) => void; onShowAll: () => void }) {
  const { t } = useI18n();
  const filters = React.useRef<HTMLDivElement>(null);
  const [hiddenTags, setHiddenTags] = useState<number[]>([]);
  React.useLayoutEffect(() => {
    const element = filters.current;
    if (!element) return;
    const measure = () => {
      const bottom = element.getBoundingClientRect().bottom;
      const hidden = Array.from(element.children).flatMap((child, index) => child.getBoundingClientRect().bottom > bottom + 1 ? [index] : []);
      setHiddenTags(previous => previous.length === hidden.length && previous.every((value, index) => value === hidden[index]) ? previous : hidden);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tags, selected]);
  if (!tags.length) return null;
  const ordered = selected ? [...tags.filter(tag => tag.toLowerCase() === selected.toLowerCase()), ...tags.filter(tag => tag.toLowerCase() !== selected.toLowerCase())] : tags;
  return <div className="content-tag-filter-area"><div ref={filters} className="content-tag-filters" role="group" aria-label={t("按标签筛选")}><button type="button" className={!selected ? 'active' : ''} aria-pressed={!selected} onClick={() => onSelect('')}>{t("全部")}</button>{ordered.map((tag, index) => <button type="button" key={tag} className={selected.toLowerCase() === tag.toLowerCase() ? 'active' : ''} aria-pressed={selected.toLowerCase() === tag.toLowerCase()} aria-hidden={hiddenTags.includes(index + 1) || undefined} tabIndex={hiddenTags.includes(index + 1) ? -1 : undefined} onClick={() => onSelect(tag)} title={tag}>{tag}</button>)}</div>{hiddenTags.length > 0 && <button type="button" className="content-link content-all-tags" onClick={onShowAll}>{t("查看全部标签")} <ArrowRight size={14}/></button>}</div>;
}

const mediaSource = (media: MediaFile) => /^https?:\/\//i.test(media.path) ? media.path : convertFileSrc(media.path);
const materialMedia = (material: Material): MediaFile[] => [
  ...(material.media || []),
  ...(material.image_url?.trim() ? [{ path: material.image_url.trim(), name: material.title, kind: 'image' as const }] : []),
  ...(material.video_url?.trim() ? [{ path: material.video_url.trim(), name: material.title, kind: 'video' as const }] : []),
];

function MediaPreview({ media }: { media: MediaFile }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [media.path]);
  return <div className="content-media-preview">{failed ? <div className="content-media-missing">{t("无法预览此文件，请检查文件是否存在或格式是否受支持。")}</div> : media.kind === 'image' ? <img src={mediaSource(media)} alt={media.name} onError={() => setFailed(true)}/> : <video src={mediaSource(media)} controls preload="metadata" onError={() => setFailed(true)}/>}<span title={media.path}>{media.name}</span></div>;
}

function MaterialThumbnail({ media }: { media: MediaFile }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [media.path]);
  if (failed) return <span className="content-row-icon material-icon"><Bookmark size={15}/></span>;
  return <span className="content-material-thumb">{media.kind === 'image' ? <img src={mediaSource(media)} alt="" onError={() => setFailed(true)}/> : <><video src={mediaSource(media)} muted preload="metadata" onError={() => setFailed(true)}/><Play size={13} fill="currentColor"/></>}</span>;
}

// Browser preview has no database, so derive its tag summary from local content.
function previewTags(data: Pick<ContentData, 'materials' | 'articles'>): ContentTag[] {
  const tags = new Map<string, ContentTag>();
  for (const [kind, items] of [['material', data.materials], ['article', data.articles]] as const) {
    items.forEach(item => parseTags(item.tags).forEach(name => {
      const key = `${kind}:${name.toLowerCase()}`;
      const tag = tags.get(key) || { kind, name, count: 0 };
      tag.count++;
      tags.set(key, tag);
    }));
  }
  return [...tags.values()];
}

// The browser preview is isolated from the desktop database.
const previewKey = (root: string) => `seabird-content-preview:${root}`;
function previewLoad(root: string): ContentData {
  try { const data = JSON.parse(localStorage.getItem(previewKey(root)) || '{"materials":[],"articles":[]}') as ContentData; return { ...data, materials: data.materials.map(material => ({ ...material, image_url: material.image_url || '', video_url: material.video_url || '' })), articles: data.articles.map(article => ({ ...article, tags: article.tags || '', cover: article.cover || null })), tags: previewTags(data) }; }
  catch { return { materials: [], articles: [], tags: [] }; }
}

export default function ContentWorkspace({ view, root, desktop, agentRunning, agentSetupNeeded, onAgentSettings, onReferenceMaterials, onNavigate, onDirty, onBusy, onAgent, onArticleContext, onArticleApply, onDraftSaved }: Props) {
  const { t, tError, language } = useI18n();
  const stamp = (date: string) => date ? `${date.slice(0, 16).replace('T', ' ')} UTC` : t('刚刚创建');
  const [data, setData] = useState<ContentData>({ materials: [], articles: [], tags: [] });
  const [loading, setLoading] = useState(false);
  const loadingRef = React.useRef(loading);
  loadingRef.current = loading;
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [showTagList, setShowTagList] = useState(false);
  const [tagSort, setTagSort] = useState<'alphabetical' | 'count'>('alphabetical');
  const [tagListKind, setTagListKind] = useState<'article' | 'material'>('article');
  const pendingTag = React.useRef('');
  const [material, setMaterial] = useState<Material | null>(null);
  const [viewedMaterial, setViewedMaterial] = useState<Material | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [articleEditing, setArticleEditing] = useState(false);
  const [calendarArticleId, setCalendarArticleId] = useState<number | null>(null);
  const [articleUndo, setArticleUndo] = useState<ArticleUndo | null>(null);
  const materialSnapshot = React.useRef('');
  const articleSnapshot = React.useRef('');
  const platform = 'original';
  const editorEpoch = React.useRef(0);
  const editorSession = React.useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const articleEditor = React.useRef('');
  const parkedArticles = React.useRef(new Map<string, Article>());
  const latestData = React.useRef(data);
  latestData.current = data;
  const liveEditor = React.useRef({ article, material, platform, view, root });
  liveEditor.current = { article, material, platform, view, root };
  const [saving, setSaving] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const autoSavingRef = React.useRef(false);
  const autoSavePaused = React.useRef(false);
  const savingRef = React.useRef(saving);
  savingRef.current = saving;
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const loadGeneration = React.useRef(0);
  const activeRoot = React.useRef(root);
  activeRoot.current = root;
  const editorGeneration = editorEpoch.current;
  const editorIdentity = articleEditor.current;
  const visible = ['home', 'materials', 'articles', 'calendar', 'discover'].includes(view);
  const edit = view === 'materials' ? material : view === 'articles' ? article : null;
  const dirty = !!edit && JSON.stringify(edit) !== (view === 'materials' ? materialSnapshot.current : articleSnapshot.current);
  const anyDirty = !!(material && JSON.stringify(material) !== materialSnapshot.current) || !!(article && JSON.stringify(article) !== articleSnapshot.current);
  const articleContext = (selection?: ArticleTarget['selection'], expectedBody?: string): AgentContext => {
    const current = liveEditor.current;
    if (current.view !== 'articles' || !current.article || current.root !== root || articleEditor.current !== editorIdentity || current.platform !== platform) throw new Error(t("文章或版本已切换，请重新选择。"));
    const title = current.article.title;
    const body = current.article.body;
    const resolved = selection && expectedBody !== undefined ? resolveArticleSelection(expectedBody, body, selection) : null;
    if (selection && !resolved) throw new Error(t("选中的内容已变化或出现多次，请重新选择。"));
    const target: ArticleTarget = { root, id: current.article.id, editor: editorIdentity, platform, title, body, ...(!current.article.id ? { draft: structuredClone(current.article) } : {}), ...(resolved ? { selection: resolved } : {}) };
    parkedArticles.current.set(editorIdentity, structuredClone(current.article));
    return { article: target, text: `当前正在编辑这篇文章。以下是页面上的最新内容（可能尚未保存），所有修改默认针对这篇文章，不要创建新文章或直接写入数据库，除非用户明确要求。${selection ? '用户选中了一段文字，只修改选中部分；不要包含其他内容。' : '用户要求修改时，只修改有要求的部分，并保留其他正文、图片和视频。'}\n标题：${JSON.stringify(title)}\n正文：${JSON.stringify(body)}\n关联素材 ID：${current.article.material_ids.join('、') || '无'}。需要使用这些素材时请读取完整内容。${selection ? `\n选中文字：${JSON.stringify(selection.text)}` : ''}` };
  };
  useEffect(() => {
    onArticleContext(view === 'articles' && article ? () => articleContext() : null);
    return () => onArticleContext(null);
  }, [view, article, platform, root, editorIdentity, onArticleContext]);
  useEffect(() => {
    onArticleApply((target, edit, onUndo) => {
      const current = liveEditor.current;
      if (savingRef.current || autoSavingRef.current) return t('正在保存文章，请完成后再应用修改。');
      if (current.root !== target.root || current.platform !== target.platform) return t('请先切换到生成建议时的工作目录。');
      const original = findArticleForSuggestion(target, current.article, articleEditor.current, latestData.current.articles, parkedArticles.current.get(target.editor));
      if (!original) return loadingRef.current ? t('正在读取文章，请稍后再试。') : t('找不到原文章，可能已被删除。');
      const updated = applyArticleEdit(target, { title: original.title, body: original.body }, edit);
      if (!updated) return target.selection ? t('选中文字已变化或出现多次，请重新选中并请求修改。') : t('文章内容已变化，请重新请求修改。');
      if (original !== current.article) {
        if (current.article && JSON.stringify(current.article) !== articleSnapshot.current && !window.confirm(t('当前文章有未保存的修改，切换文章将丢失这些修改，确定继续吗？'))) return t('已取消切换文章。');
        if (current.article && articleEditor.current && parkedArticles.current.has(articleEditor.current)) parkedArticles.current.set(articleEditor.current, JSON.parse(articleSnapshot.current));
        editorEpoch.current++;
        articleEditor.current = target.editor;
        articleSnapshot.current = JSON.stringify(original);
        autoSavePaused.current = false;
        setAutoSaved(false);
        setArticleEditing(original.id === 0);
      }
      const next = { ...original, title: updated.title, body: updated.body };
      setArticleUndo({ root: current.root, editor: articleEditor.current, before: original, after: next, onUndo });
      liveEditor.current.article = next;
      setArticle(next); setError(''); setMessage(t("修改已应用，请保存文章"));
      onNavigate('articles');
      return null;
    });
    return () => onArticleApply(null);
  }, [onArticleApply, onNavigate]);
  const closeState = React.useRef({ anyDirty, saving: saving || autoSaving });
  closeState.current = { anyDirty, saving: saving || autoSaving };
  useEffect(() => { onDirty(anyDirty); }, [anyDirty, onDirty]);
  useEffect(() => { onBusy(saving || autoSaving); }, [saving, autoSaving, onBusy]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(event => {
      if (closeState.current.saving) { event.preventDefault(); setError(t("正在保存内容或导入文件，请完成后再关闭。")); return; }
      if (closeState.current.anyDirty && !window.confirm(t("素材或文章有未保存的修改，确定关闭吗？"))) event.preventDefault();
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => setError(t("无法启用关闭提示：{0}", tError(error))));
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);
  const load = async (silent = false) => {
    if (!root || activeRoot.current !== root) return;
    const generation = ++loadGeneration.current;
    if (!silent) { setLoading(true); setError(''); }
    try { const result = desktop ? await invoke<ContentData>('content_load', { root }) : previewLoad(root); if (generation === loadGeneration.current) setData(result); return result; }
    catch (e) { if (!silent && generation === loadGeneration.current) setError(t("无法读取内容：{0}", tError(e))); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  };
  useEffect(() => { parkedArticles.current.clear(); articleEditor.current = ''; autoSavePaused.current = false; setAutoSaved(false); setData({ materials: [], articles: [], tags: [] }); setMaterial(null); setViewedMaterial(null); setArticle(null); setArticleUndo(null); setCalendarArticleId(null); setSelected([]); setDiscoverQuery(''); void load(); return () => { loadGeneration.current++; }; }, [root, desktop]);
  useEffect(() => {
    const refresh = (event: Event) => { if ((event as CustomEvent<{ root: string }>).detail?.root === root) void load(); };
    window.addEventListener('seabird-content-saved', refresh);
    return () => window.removeEventListener('seabird-content-saved', refresh);
  }, [root, desktop]);
  useEffect(() => { setSearch(''); setSelectedTag(pendingTag.current); pendingTag.current = ''; setShowTagList(false); }, [view, root]);
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
    if (!root) throw new Error(t("请先选择工作目录"));
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
    const name = item?.title || (kind === 'material' ? t('这条素材') : t('这篇文章'));
    const deletingEdit = kind === 'material' ? material?.id === id && JSON.stringify(material) !== materialSnapshot.current : article?.id === id && JSON.stringify(article) !== articleSnapshot.current;
    const hasVersions = kind === 'article' && Object.keys(data.articles.find(article => article.id === id)?.versions || {}).length > 0;
    const detail = (kind === 'material' ? t('已关联的文章将移除这条引用，附件文件会保留。') : t('相关发布记录也会删除。{0}', hasVersions ? t('以前保存的平台版本也会一并删除。') : '')) + (deletingEdit ? ` ${t('未保存的修改也会丢失。')}` : '');
    if (!window.confirm(t("删除“{0}”？{1}", name, detail))) return;
    setSaving(true); setError('');
    try {
      let backupWarning: string | null = null;
      if (desktop) backupWarning = await invoke<string | null>('content_delete', { root, kind, id });
      else { const previous = previewLoad(root); if (kind === 'material') { previous.materials = previous.materials.filter(x => x.id !== id); previous.articles = previous.articles.map(a => ({ ...a, material_ids: a.material_ids.filter(x => x !== id) })); } else { previous.articles = previous.articles.filter(x => x.id !== id); const key = `seabird-publications-preview:${root}`; const records = JSON.parse(localStorage.getItem(key) || '[]') as { article_id: number }[]; localStorage.setItem(key, JSON.stringify(records.filter(record => record.article_id !== id))); } localStorage.setItem(previewKey(root), JSON.stringify(previous)); }
      if (kind === 'material') { if (material?.id === id) { setMaterial(null); materialSnapshot.current = ''; } setViewedMaterial(current => current?.id === id ? null : current); setSelected(s => s.filter(x => x !== id)); }
      else if (article?.id === id) { setArticle(null); articleSnapshot.current = ''; }
      await load(); if (backupWarning) setError(t("已删除，但备份更新失败：{0}", tError(backupWarning))); else setMessage(t("已删除"));
    } catch (e) { setError(t("删除失败：{0}", tError(e))); } finally { setSaving(false); }
  };
  const editMaterial = (item: Material) => { if (material && JSON.stringify(material) !== materialSnapshot.current && !window.confirm(t("素材有未保存的修改，确定放弃吗？"))) return; editorEpoch.current++; setViewedMaterial(null); materialSnapshot.current = JSON.stringify(item); setMaterial({ ...item }); setError(''); onNavigate('materials'); };
  const openSource = async (rawUrl: string) => {
    let url: URL;
    try { url = new URL(rawUrl.trim()); }
    catch { setError(t("链接格式不正确，请编辑素材")); return; }
    if (!['http:', 'https:'].includes(url.protocol)) { setError(t("请使用 http 或 https 链接")); return; }
    setError('');
    if (!desktop) { window.open(url.href, '_blank', 'noopener,noreferrer'); return; }
    try { await invoke('content_open_url', { url: url.href }); }
    catch (e) { setError(t("无法打开链接：{0}", tError(e))); }
  };
  const viewMaterial = (item: Material) => {
    if (item.url.trim()) { void openSource(item.url); return; }
    if (material && JSON.stringify(material) !== materialSnapshot.current && !window.confirm(t("素材有未保存的修改，确定放弃吗？"))) return;
    setMaterial(null); materialSnapshot.current = ''; setViewedMaterial(item); setError(''); onNavigate('materials');
  };
  const editArticle = (item: Article, startEditing = item.id === 0, beforeOpen?: () => boolean) => { if (article && JSON.stringify(article) !== articleSnapshot.current && !window.confirm(t("文章有未保存的修改，确定放弃吗？"))) return false; if (beforeOpen && !beforeOpen()) return false; if (article && articleEditor.current && parkedArticles.current.has(articleEditor.current)) parkedArticles.current.set(articleEditor.current, JSON.parse(articleSnapshot.current)); editorEpoch.current++; articleEditor.current = `${editorSession.current}:${editorEpoch.current}`; autoSavePaused.current = false; setAutoSaved(false); setArticleUndo(null); setArticleEditing(startEditing); articleSnapshot.current = JSON.stringify(item); setArticle(structuredClone(item)); setError(''); onNavigate('articles'); return true; };
  const writeFromMaterials = (items: Material[]) => {
    editArticle(emptyArticle(items.map(item => item.id)), true, () => onReferenceMaterials(items));
  };
  const undoAgentEdit = () => {
    const current = liveEditor.current;
    if (!articleUndo || !current.article || current.view !== 'articles' || current.root !== articleUndo.root || articleUndo.editor !== articleEditor.current) return;
    const restored = undoArticleEdit(articleUndo.before, articleUndo.after, current.article);
    if (!restored) { setMessage(''); setError(t("文章在应用后又有修改，无法直接撤销。请手动调整，或先复制当前内容。")); return; }
    liveEditor.current.article = restored; setArticle(restored); setArticleUndo(null); articleUndo.onUndo(); setError(''); setMessage(t("已撤销 Agent 修改，请保存文章"));
  };
  const closeEditor = () => {
    if (dirty && !window.confirm(t("有未保存的修改，确定放弃吗？"))) return;
    if (view === 'articles' && article && articleEditor.current && parkedArticles.current.has(articleEditor.current)) parkedArticles.current.set(articleEditor.current, JSON.parse(articleSnapshot.current));
    editorEpoch.current++;
    if (view === 'articles') articleEditor.current = '';
    if (view === 'materials') { setMaterial(null); materialSnapshot.current = ''; }
    else { setArticle(null); setArticleUndo(null); articleSnapshot.current = ''; }
  };
  const saveCurrent = async () => {
    if (!edit || saving || savingRef.current || autoSavingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    const savedEditor = articleEditor.current;
    try {
      const kind = view === 'materials' ? 'material' : 'article';
      const result = await saveItem(kind, edit);
      if (kind === 'article' && edit.id === 0) onDraftSaved(root, savedEditor, result.id);
      const fresh = await load();
      const updated = (kind === 'material' ? fresh?.materials.find(x => x.id === result.id) : fresh?.articles.find(x => x.id === result.id)) || { ...edit, id: result.id };
      if (kind === 'material') { materialSnapshot.current = JSON.stringify(updated); setMaterial(updated as Material); }
      else { articleSnapshot.current = JSON.stringify(updated); setArticle(updated as Article); autoSavePaused.current = false; setAutoSaved(false); }
       if (result.backup_warning) setError(t("内容已保存，但备份失败：{0}", tError(result.backup_warning))); else setMessage(t("已保存"));
    } catch (e) {
      const detail = String(e);
      if (view === 'articles') autoSavePaused.current = true;
      if (detail.includes('已被修改')) { await load(); setError(t("{0}。手动编辑仍保留在这里；可先复制内容，再返回列表打开最新版本。", tError(detail))); }
      else setError(t("保存失败：{0}", tError(detail)));
    } finally { savingRef.current = false; setSaving(false); }
  };
  const autoSave = async () => {
    const item = article;
    if (!root || !canAutoSaveArticle(item, articleSnapshot.current, autoSavePaused.current || savingRef.current || autoSavingRef.current)) return;
    const generation = editorEpoch.current;
    const isCurrent = () => activeRoot.current === root && editorEpoch.current === generation && liveEditor.current.article?.id === item.id;
    autoSavingRef.current = true; setAutoSaving(true);
    try {
      const result = await saveItem('article', item);
      const fresh = await load(true);
      if (!isCurrent()) return;
      const saved = fresh?.articles.find(entry => entry.id === result.id);
      if (!saved || !isSavedArticle(item, saved, desktop)) {
        autoSavePaused.current = true;
        setError(t("自动保存后无法确认最新文章，已暂停自动保存。请先复制当前内容，再返回列表查看最新版本。{0}", result.backup_warning ? t('备份也失败：{0}', tError(result.backup_warning)) : ''));
        return;
      }
      articleSnapshot.current = JSON.stringify(saved);
      setArticle(current => current && current.id === item.id ? mergeSavedArticle(current, item, saved) : current);
      setAutoSaved(true);
      if (result.backup_warning) setError(t("文章已自动保存，但备份失败：{0}", tError(result.backup_warning)));
    } catch (e) {
      if (!isCurrent()) return;
      autoSavePaused.current = true;
      const detail = String(e);
      if (detail.includes('已被修改')) {
        await load(true);
        if (isCurrent()) setError(t("自动保存失败：{0}。请先复制当前内容，再返回列表打开最新版本。", tError(detail)));
      } else setError(t("自动保存失败：{0}。请检查后手动保存。", tError(detail)));
    } finally { autoSavingRef.current = false; setAutoSaving(false); }
  };
  const autoSaveRef = React.useRef(autoSave);
  autoSaveRef.current = autoSave;
  useEffect(() => {
    if (!root || !article?.id) return;
    return startArticleAutoSave(() => void autoSaveRef.current());
  }, [root, desktop, article?.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || !edit) return;
      event.preventDefault();
      if (!edit.title.trim()) { setError(t("请输入标题后保存")); return; }
      void saveCurrent();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const importMedia = async () => {
    if (!desktop) { setError(t("请在桌面应用中导入图片和视频。")); return; }
    try {
      const paths = await open({ multiple: true, filters: [{ name: t("图片和视频"), extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'mp4', 'mov', 'm4v', 'webm'] }] });
      if (!paths) return;
      setSaving(true); setError('');
      for (const path of Array.isArray(paths) ? paths : [paths]) {
        const media = await invoke<MediaFile>('content_import_media', { root, path });
        setMaterial(previous => previous ? { ...previous, media: [...previous.media, media] } : previous);
      }
      setMessage(t("文件已复制到本地素材目录，请保存素材"));
    } catch (e) { setError(t("导入失败：{0}", tError(e))); }
    finally { setSaving(false); }
  };
  const importCover = async () => {
    if (!desktop) { setError(t("请在桌面应用中添加封面。")); return; }
    const epoch = editorEpoch.current;
    try {
      const path = await open({ multiple: false, filters: [{ name: t("图片"), extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'] }] });
      if (typeof path !== 'string' || epoch !== editorEpoch.current || activeRoot.current !== root) return;
      setSaving(true); setError('');
      const cover = await invoke<MediaFile>('content_import_media', { root, path });
      if (epoch !== editorEpoch.current || activeRoot.current !== root) { setError(t("图片已导入，但文章已切换，请重新添加封面。")); return; }
      setArticle(current => current ? { ...current, cover } : current);
      setMessage(t("封面已添加，请保存文章"));
    } catch (e) { setError(t("添加封面失败：{0}", tError(e))); }
    finally { setSaving(false); }
  };
  const generateCover = () => {
    if (!article) return;
    if (!article.id || dirty || autoSaving) { setError(t("请先保存文章，再生成封面。")); return; }
    const id = article.id;
    onAgent('请根据这篇文章生成一张适合作为封面的图片。', () => ({ text: `用户明确要求为工作目录 ${JSON.stringify(root)} 中 ID 为 ${id} 的文章生成并绑定封面。请先运行 Seabird CLI 的 --help 并读取文章完整内容，优先使用内置图片生成工具，然后使用 content import-media 将生成文件导入当前工作目录。如果内置图片生成工具不可用，使用 content generate-image 和包含 prompt 的 JSON 文件生成并导入图片；该命令会使用本机 Codex 已配置的服务及凭据，不要读取、输出或传递密钥。重新读取文章并以读取到的完整对象为 expected，仅将文章的 cover 字段设为导入返回的图片对象，再调用 content save-article 保存。保留正文、标签、版本和关联素材。如果无法生成图片，请说明原因，不要假装完成。` }), undefined, true);
  };
  const filter = (text: string) => text.toLowerCase().includes(search.trim().toLowerCase());
  const tagsFor = (value: string) => !selectedTag || parseTags(value).some(tag => tag.toLowerCase() === selectedTag.toLowerCase());
  const materials = useMemo(() => data.materials.filter(m => filter([m.title, m.source, m.tags, m.note].join(' ')) && tagsFor(m.tags)), [data.materials, search, selectedTag]);
  const articles = useMemo(() => data.articles.filter(a => filter([a.title, a.body, a.tags].join(' ')) && tagsFor(a.tags)), [data.articles, search, selectedTag]);
  const availableTags = useMemo(() => data.tags.filter(tag => tag.kind === (view === 'materials' ? 'material' : 'article')).map(tag => tag.name).sort((a, b) => a.localeCompare(b, language === 'zh' ? 'zh-CN' : 'en')), [data.tags, view, language]);
  const sortedTags = useMemo(() => data.tags.filter(tag => tag.kind === tagListKind).sort((a, b) => {
    const byCount = tagSort === 'count' ? b.count - a.count : 0;
    return byCount || a.name.localeCompare(b.name, language === 'zh' ? 'zh-CN' : 'en');
  }), [data.tags, tagListKind, tagSort, language]);
  const tagFilters = <TagFilters tags={availableTags} selected={selectedTag} onSelect={setSelectedTag} onShowAll={() => { setTagListKind(view === 'materials' ? 'material' : 'article'); setShowTagList(true); }}/>;
  const askAgent = () => {
    if (!article) return;
    onAgent('请帮我修改这篇文章。\n\n我的要求：', () => articleContext());
  };
  const startWithAgent = (kind: 'articles' | 'materials') => {
    const current = kind === 'articles' ? article : material;
    const snapshot = kind === 'articles' ? articleSnapshot.current : materialSnapshot.current;
    if (current && JSON.stringify(current) !== snapshot && !window.confirm(kind === 'articles' ? t('文章有未保存的修改，确定放弃吗？') : t('素材有未保存的修改，确定放弃吗？'))) return;
    if (!onAgent(kind === 'articles' ? t('写一篇文章，参考：') : t('添加一个素材，参考：'), undefined, undefined, true, true)) return;
    editorEpoch.current++;
    if (kind === 'articles') { if (article && articleEditor.current && parkedArticles.current.has(articleEditor.current)) parkedArticles.current.set(articleEditor.current, JSON.parse(articleSnapshot.current)); articleEditor.current = ''; setArticle(null); setArticleUndo(null); articleSnapshot.current = ''; }
    else { setMaterial(null); setViewedMaterial(null); materialSnapshot.current = ''; }
    onNavigate(kind);
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
      if (!current.id || unsaved) return { text: `${current.id ? `这条素材已保存的记录 ID 为 ${current.id}，但以下是页面上尚未保存的修改；` : ''}请先讨论和整理，不要写入或覆盖任何记录，直到用户明确要求。请保留准确来源和附件。\n\n当前内容：\n${JSON.stringify(current)}` };
      return { text: `请读取并整理 Seabird 中 ID 为 ${current.id} 的素材，保留原有附件和准确来源，按用户要求修改并保存。` };
    });
  };
  return <div className="content-workspace" hidden={!visible}>
      <fieldset className="content-page content-fieldset" disabled={saving}>
      {(error || message) && <div className={`content-feedback ${error ? 'is-error' : ''}`} role="status"><span>{error || message}</span><button aria-label={t("关闭提示")} onClick={() => { setError(''); setMessage(''); }}><X size={15}/></button></div>}
      {!root && <div className="content-empty content-empty-standalone"><strong>{t("先选择工作目录")}</strong><p>{t("素材和文章会保存在当前工作目录对应的本地工作台中。")}</p></div>}
      {root && view === 'home' && <>
        {agentSetupNeeded && <div className="agent-onboarding"><div className="agent-onboarding-icon"><Sparkles size={18}/></div><div><b>{t("先准备你的本地 Agent")}</b><p>{t("检查 Codex 或 Claude Code 的安装与登录状态，就可以在创作时直接与它对话。")}</p></div><button className="content-soft" onClick={onAgentSettings}>{t("检查 Agent")} <ArrowRight size={14}/></button></div>}
        <div className="content-home-head"><div><span className="content-kicker">YOUR CONTENT SPACE</span><h1>{t("让想法，")}<em>{t("慢慢成形。")}</em></h1><p>{t("从收集素材到完成文章，让想法慢慢成形。")}</p></div><div className="content-orbit" aria-hidden="true"><span>✳</span><small>COLLECT<br/>CREATE<br/>SHARE</small></div></div>
        <div className="content-quick-actions"><button className="content-primary" onClick={() => onNavigate('articles')}><FileText size={16}/> {t("文章")}</button><button className="content-soft" onClick={() => onNavigate('materials')}><Bookmark size={15}/> {t("素材")}</button><button className="content-link" onClick={() => onNavigate('discover')}>{t("看看热点")} <ArrowRight size={15}/></button></div>
        <div className="content-home-grid"><section className="content-panel"><div className="content-panel-head"><div><span className="content-kicker">KEEP WRITING</span><h2>{t("继续创作")} <span>{data.articles.length}</span></h2></div><div className="content-panel-actions"><button type="button" aria-label={t("新建文章")} onClick={() => startWithAgent('articles')}><Plus size={14}/> {t("添加")}</button><button onClick={() => onNavigate('articles')}>{t("查看全部")} <ArrowRight size={14}/></button></div></div>{data.articles.length ? <div className="content-list">{data.articles.slice(0, 4).map(a => <button className="content-list-row" key={a.id} onClick={() => editArticle(a)}><span className="content-row-icon article-icon"><FileText size={16}/></span><span className="content-row-copy"><b>{a.title}</b><small>{snippet(a.body) || t("还没有正文，继续写下你的想法。")}</small></span><span className="content-row-arrow"><ArrowRight size={15}/></span></button>)}</div> : <div className="content-panel-empty"><FileText size={20}/><p>{t("还没有文章，记录你的第一个想法。")}</p></div>}</section>
        <section className="content-panel"><div className="content-panel-head"><div><span className="content-kicker">YOUR COLLECTION</span><h2>{t("最近素材")} <span>{data.materials.length}</span></h2></div><div className="content-panel-actions"><button type="button" aria-label={t("添加素材")} onClick={() => startWithAgent('materials')}><Plus size={14}/> {t("添加")}</button><button onClick={() => onNavigate('materials')}>{t("查看全部")} <ArrowRight size={14}/></button></div></div>{data.materials.length ? <div className="content-list">{data.materials.slice(0, 4).map(m => <div className="content-material-row" key={m.id}><button className="content-list-row" onClick={() => viewMaterial(m)}>{materialMedia(m)[0] ? <MaterialThumbnail media={materialMedia(m)[0]}/> : <span className="content-row-icon material-icon"><Bookmark size={15}/></span>}<span className="content-row-copy"><b>{m.title}</b><small>{m.source || t("个人素材")}{m.tags ? ` · ${m.tags}` : ''}</small></span><span className="content-row-arrow">{m.url.trim() ? <ExternalLink size={15}/> : <ArrowRight size={15}/>}</span></button><button type="button" className="content-material-write" aria-label={t("用素材 {0} 写文章", m.title)} onClick={() => writeFromMaterials([m])}>{t("写文章")} <ArrowRight size={13}/></button></div>)}</div> : <div className="content-panel-empty"><Bookmark size={20}/><p>{t("把值得保留的链接、热点和想法收集起来。")}</p></div>}</section></div>
        <div className="content-home-note"><span className="content-note-dot"/> {t("素材和文章保存在本机 · 当前工作目录")}</div>
      </>}
      {root && showTagList && (view === 'materials' || view === 'articles') && <><div className="content-editor-heading"><button type="button" className="content-back" onClick={() => setShowTagList(false)}><ArrowLeft size={16}/> {view === 'materials' ? t("返回素材") : t("返回文章")}</button></div><div className="content-page-heading content-tags-heading"><h1>{t("全部标签")}</h1><label>{t("排序")} <select value={tagSort} onChange={event => setTagSort(event.target.value as typeof tagSort)}><option value="alphabetical">{t("字母顺序")}</option><option value="count">{tagListKind === 'article' ? t("文章数量") : t("素材数量")}</option></select></label></div><div className="content-tag-types" role="group" aria-label={t("标签类型")}><button type="button" className={tagListKind === 'article' ? 'active' : ''} aria-pressed={tagListKind === 'article'} onClick={() => setTagListKind('article')}>{t("文章标签")}</button><button type="button" className={tagListKind === 'material' ? 'active' : ''} aria-pressed={tagListKind === 'material'} onClick={() => setTagListKind('material')}>{t("素材标签")}</button></div><div className="content-all-tag-list">{sortedTags.map(tag => <button type="button" key={tag.name} className={tagListKind === (view === 'materials' ? 'material' : 'article') && selectedTag.toLowerCase() === tag.name.toLowerCase() ? 'active' : ''} onClick={() => { const target = tagListKind === 'material' ? 'materials' : 'articles'; if (view === target) { setSelectedTag(tag.name); setShowTagList(false); } else { pendingTag.current = tag.name; onNavigate(target); } }}><span>{tag.name}</span><small>{tagListKind === 'article' ? t("{0} 篇文章", tag.count) : t("{0} 条素材", tag.count)}</small></button>)}</div>{!sortedTags.length && <p className="content-tags-empty">{t("暂无标签")}</p>}</>}
      {root && view === 'materials' && !material && !viewedMaterial && !showTagList && <><div className="content-page-heading content-list-heading"><div><span className="content-kicker">COLLECTION</span><h1>{t("素材")}</h1><p>{t("整理值得保留的链接、内容和想法。")}</p></div><button className="content-primary" onClick={() => editMaterial(emptyMaterial())}><Plus size={15}/> {t("添加素材")}</button></div><div className="content-toolbar"><label className="content-search"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("搜索标题、标签或备注")} /></label><span>{materials.length} {t("条素材")}</span>{selected.length > 0 && <button className="content-soft" onClick={() => writeFromMaterials(data.materials.filter(item => selected.includes(item.id)))}>{t("用")} {selected.length} {t("条素材写文章")} <ArrowRight size={14}/></button>}</div>{tagFilters}{loading ? <div className="content-empty">{t("正在读取素材…")}</div> : materials.length ? <div className="content-cards">{materials.map(m => <article className="content-card" key={m.id}><div className="content-card-top"><label className="content-select"><input type="checkbox" checked={selected.includes(m.id)} onChange={e => setSelected(s => e.target.checked ? [...s, m.id] : s.filter(id => id !== m.id))} aria-label={t("选择素材 {0}", m.title)}/><span>{m.source || t("个人素材")}</span></label><span>{stamp(m.updated_at)}</span></div><button className="content-card-main" onClick={() => viewMaterial(m)}><h3>{m.title}{m.url.trim() && <ExternalLink size={13}/>}</h3><p>{snippet(m.note) || (m.url ? t("查看原链接") : t("查看素材"))}</p></button>{materialMedia(m).length > 0 && <div className="content-card-media">{materialMedia(m).map((media, index) => <MediaPreview key={`${media.path}-${index}`} media={media}/>)}</div>}<div className="content-card-foot"><span className="content-card-tags">{parseTags(m.tags).length ? parseTags(m.tags).map(tag => <span className="content-tag" key={tag}>{tag}</span>) : t("未添加标签")}{m.media?.length ? t(" · {0} 个文件", m.media.length) : ''}</span><span className="content-card-actions"><button className="content-list-delete" aria-label={t("删除素材 {0}", m.title)} title={t("删除素材")} onClick={() => void removeItem('material', m.id)}><Trash2 size={14}/></button><button onClick={() => editMaterial(m)} aria-label={t("编辑素材 {0}", m.title)}>{t("编辑")}</button><button onClick={() => writeFromMaterials([m])}>{t("写文章")} <ArrowRight size={13}/></button></span></div></article>)}</div> : <div className="content-empty"><Bookmark size={24}/><strong>{search || selectedTag ? t("没有找到匹配的素材") : t("这里还没有素材")}</strong><p>{search || selectedTag ? t("试试其他关键词或标签。") : t("添加热点、链接或想法，留给下一次创作。")}</p></div>}</>}
      {root && view === 'materials' && viewedMaterial && !material && <><div className="content-editor-heading"><button className="content-back" onClick={() => setViewedMaterial(null)}><ArrowLeft size={16}/> {t("返回素材")}</button><button className="content-soft" onClick={() => editMaterial(viewedMaterial)}><Pencil size={14}/> {t("编辑")}</button></div><div className="content-form content-material-detail"><span className="content-kicker">MATERIAL</span><h1>{viewedMaterial.title}</h1>{viewedMaterial.source && <div className="content-detail-meta">{viewedMaterial.source}</div>}{viewedMaterial.tags && <div className="content-row-tags">{parseTags(viewedMaterial.tags).map(tag => <span className="content-tag" key={tag}>{tag}</span>)}</div>}{viewedMaterial.note && <p className="content-detail-note">{viewedMaterial.note}</p>}{viewedMaterial.image_url && <button type="button" className="content-link" onClick={() => void openSource(viewedMaterial.image_url)}><ExternalLink size={13}/> {t("打开图片链接")}</button>}{viewedMaterial.video_url && <button type="button" className="content-link" onClick={() => void openSource(viewedMaterial.video_url)}><ExternalLink size={13}/> {t("打开视频链接")}</button>}{viewedMaterial.media.length > 0 && <div className="content-media-grid">{viewedMaterial.media.map(media => <div key={media.path} className="content-media-item"><MediaPreview media={media}/></div>)}</div>}</div></>}
      {root && view === 'materials' && material && <><div className="content-editor-heading"><button className="content-back" onClick={closeEditor}><ArrowLeft size={16}/> {t("返回素材")}</button><div><button className="content-soft" onClick={askMaterialAgent}><Sparkles size={15}/> {t("协助整理")}</button><button className="content-primary" disabled={saving || !material.title.trim()} onClick={saveCurrent}>{saving ? t("保存中…") : t("保存")}</button></div></div><div className="content-form"><span className="content-kicker">MATERIAL</span><h1>{material.id ? t("素材详情") : t("添加素材")}</h1><label>{t("标题")}<input value={material.title} onChange={e => setMaterial({ ...material, title: e.target.value })} placeholder={t("给素材一个容易记住的名字")} /></label><div className="content-form-row"><label>{t("来源")}<input value={material.source} onChange={e => setMaterial({ ...material, source: e.target.value })} placeholder={t("例如：X、公众号、个人想法")} /></label><label>{t("标签")}<input value={material.tags} onChange={e => setMaterial({ ...material, tags: e.target.value })} placeholder={t("多个标签用逗号分隔")} /></label></div><label>{t("链接")}<input value={material.url} onChange={e => setMaterial({ ...material, url: e.target.value })} placeholder="https://" /></label>{material.url && <><button className="content-link content-copy-source" onClick={() => void openSource(material.url)}><ExternalLink size={13}/> {t("打开链接")}</button><button className="content-link content-copy-source" onClick={async () => { try { await navigator.clipboard.writeText(material.url); setMessage(t("已复制链接")); } catch { setError(t("复制失败，请手动选择链接复制")); } }}><Link2 size={13}/> {t("复制链接")}</button></>}<div className="content-form-row"><label>{t("图片链接")}<input type="url" value={material.image_url} onChange={e => setMaterial({ ...material, image_url: e.target.value })} placeholder="https://"/>{material.image_url && <button type="button" className="content-link" onClick={() => void openSource(material.image_url)}><ExternalLink size={13}/> {t("打开图片链接")}</button>}</label><label>{t("视频链接")}<input type="url" value={material.video_url} onChange={e => setMaterial({ ...material, video_url: e.target.value })} placeholder="https://"/>{material.video_url && <button type="button" className="content-link" onClick={() => void openSource(material.video_url)}><ExternalLink size={13}/> {t("打开视频链接")}</button>}</label></div><label>{t("备注")}<textarea value={material.note} onChange={e => setMaterial({ ...material, note: e.target.value })} placeholder={t("记录内容要点，或写下为什么想收藏它。")} /></label><div className="content-media-heading"><b>{t("图片和视频")}</b><button className="content-soft" disabled={saving} onClick={importMedia}><Plus size={14}/> {t("导入文件")}</button></div><p className="content-media-note">{t("文件会复制到本地素材目录；移除附件或删除素材不会删除文件。支持常见图片和视频格式，单个文件不超过 1 GB。")}</p>{material.media.length > 0 && <div className="content-media-grid">{material.media.map(media => <div key={media.path} className="content-media-item"><MediaPreview media={media}/><button aria-label={t("移除附件 {0}", media.name)} onClick={() => setMaterial({ ...material, media: material.media.filter(m => m.path !== media.path) })}><X size={14}/></button></div>)}</div>}<div className="content-form-bottom"><span>{material.id === 0 ? t("新素材尚未保存") : dirty ? t("有未保存的修改") : t("所有修改已保存")}</span>{material.id > 0 && <button className="content-delete" disabled={saving} onClick={() => void removeItem('material', material.id)}><Trash2 size={14}/> {t("删除素材")}</button>}</div></div></>}
      {root && view === 'articles' && !article && !showTagList && <><div className="content-page-heading content-list-heading"><div><span className="content-kicker">YOUR WRITING</span><h1>{t("文章")}</h1><p>{t("整理想法，写下你的文章。")}</p></div><button className="content-primary" onClick={() => editArticle(emptyArticle())}><Plus size={15}/> {t("新建文章")}</button></div><div className="content-toolbar"><label className="content-search"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("搜索文章或标签")} /></label><span>{articles.length} {t("篇文章")}</span></div>{tagFilters}{loading ? <div className="content-empty">{t("正在读取文章…")}</div> : articles.length ? <div className="content-article-list">{articles.map(a => <div className="content-article-item" key={a.id}><button className="content-article-row" onClick={() => editArticle(a)}>{a.cover ? <span className="article-cover-thumb"><MediaPreview media={{ ...a.cover, kind: 'image' }}/></span> : <span className="content-row-icon article-icon"><FileText size={18}/></span>}<span className="content-row-copy"><b>{a.title}</b><small>{snippet(a.body) || t("还没有正文")}</small>{parseTags(a.tags).length > 0 && <span className="content-row-tags">{parseTags(a.tags).map(tag => <span className="content-tag" key={tag}>{tag}</span>)}</span>}</span><span className="content-article-meta">{a.material_ids.length} {t("条素材")}<br/>{stamp(a.updated_at)}</span></button><button className="content-article-edit" aria-label={t("编辑文章 {0}", a.title)} onClick={() => editArticle(a, true)}><Pencil size={14}/> {t("编辑")}</button><button className="content-article-list-delete" aria-label={t("删除文章 {0}", a.title)} title={t("删除文章")} onClick={() => void removeItem('article', a.id)}><Trash2 size={14}/></button><button className="content-article-open" aria-label={t("打开文章 {0}", a.title)} title={t("打开文章")} onClick={() => editArticle(a)}><ArrowRight size={15}/></button></div>)}</div> : <div className="content-empty"><FileText size={24}/><strong>{search || selectedTag ? t("没有找到匹配的文章") : t("你的第一篇文章，从这里开始")}</strong><p>{search || selectedTag ? t("试试其他关键词或标签。") : t("从一个想法或一条素材开始。")}</p></div>}</>}
      {root && view === 'articles' && article && <><div className="content-editor-heading"><button className="content-back" disabled={autoSaving} onClick={closeEditor}><ArrowLeft size={16}/> {t("返回文章")}</button><div><span className="content-save-state">{article.id === 0 ? t("新文章尚未保存") : autoSaving ? t("自动保存中…") : dirty ? t("未保存") : autoSaved ? t("已自动保存") : t("已保存")}</span><button className="content-soft" onClick={() => setArticleEditing(value => !value)}>{articleEditing ? <Eye size={15}/> : <Pencil size={15}/>} {articleEditing ? t("预览") : t("编辑")}</button><button className="content-soft" onClick={askAgent}><Sparkles size={15}/> {t("协助写作")}</button>{articleUndo && <button className="content-soft" onClick={undoAgentEdit}>{t("撤销 Agent 修改")}</button>}<button className="content-primary" disabled={saving || autoSaving || !article.title.trim()} onClick={saveCurrent}>{saving ? t("保存中…") : t("保存")}</button></div></div><div className="content-writing-layout"><div className={`content-writing-main${articleEditing ? ' is-editing' : ''}`}><ArticleEditor key={editorGeneration} root={root} desktop={desktop} title={article.title} body={article.body} preview={!articleEditing} onOpenLink={url => void openSource(url)} onTitle={value => setArticle(current => current ? { ...current, title: value } : current)} onBody={value => setArticle(current => current ? { ...current, body: value } : current)} onEditSelection={(selection, body) => onAgent('请帮我修改选中的内容。\n\n我的要求：', () => articleContext(selection, body), selection.text)} onBusy={setSaving} onMessage={value => { setError(''); setMessage(value); }} onError={value => { setMessage(''); setError(value); }} isCurrent={() => editorEpoch.current === editorGeneration && activeRoot.current === root}/></div><aside className="content-writing-aside"><section className="article-cover"><div className="content-aside-title"><ImagePlus size={15}/><b>{t("文章封面")}</b></div>{article.cover ? <div className="article-cover-image"><MediaPreview media={{ ...article.cover, kind: 'image' }}/></div> : <div className="article-cover-empty"><ImagePlus size={20}/><span>{t("还没有封面")}</span></div>}<div className="article-cover-actions"><button type="button" className="content-soft" onClick={() => void importCover()}>{article.cover ? t("更换图片") : t("选择图片")}</button><button type="button" className="content-soft" disabled={agentRunning} onClick={generateCover}><Sparkles size={14}/> {t("生成封面")}</button>{article.cover && <button type="button" className="content-link" onClick={() => setArticle(current => current ? { ...current, cover: null } : current)}>{t("移除")}</button>}</div></section><div className="content-aside-divider"/><SocialPlatforms desktop={desktop} mode="article" onSettings={onAgentSettings}/><div className="content-aside-divider"/><label className="content-article-tags">{t("标签")}<textarea aria-label={t("文章标签")} rows={3} value={article.tags || ''} onChange={e => setArticle({ ...article, tags: e.target.value })} placeholder={t("多个标签用逗号或换行分隔")} /></label>{article.id > 0 && <div className="content-article-actions"><button className="content-delete" disabled={saving || autoSaving} onClick={() => void removeItem('article', article.id)}><Trash2 size={14}/> {t("删除文章")}</button><button className="content-record-publication" onClick={() => { setCalendarArticleId(article.id); onNavigate('calendar'); }}><CalendarDays size={14}/> {t("记录发布时间")}</button></div>}</aside></div></>}
      {root && view === 'calendar' && <PublicationCalendar root={root} desktop={desktop} articles={data.articles} initialArticleId={calendarArticleId} onConsumed={() => setCalendarArticleId(null)} onOpenArticle={id => { if (article?.id === id) { onNavigate('articles'); return; } const item = data.articles.find(entry => entry.id === id); if (item) editArticle(item); else setError(t("文章不存在，请刷新后重试。")); }} onBusy={setSaving}/>}
      {root && view === 'discover' && <><div className="content-page-heading"><div><span className="content-kicker">DISCOVER</span><h1>{t("热点发现")}</h1><p>{t("让 Agent 帮你查找值得关注的话题。")}</p></div></div><div className="content-form"><label>{t("关注方向")}<input value={discoverQuery} onChange={e => setDiscoverQuery(e.target.value)} placeholder={t("例如：AI 视频、科技新闻或某个平台")} /></label><button className="content-primary" type="button" onClick={() => onAgent(`请帮我查找${discoverQuery.trim() ? `与“${discoverQuery.trim()}”有关的` : ''}近期值得关注的话题。请标明来源和时间，提供可访问的来源链接；无法验证的信息请明确说明。`, undefined, undefined, true)}><Sparkles size={15}/> {t("让 Agent 查找")}</button></div></>}
    </fieldset>
  </div>;
}
