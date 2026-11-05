import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Heading2, Heading3, ImagePlus, Sparkles, Video } from 'lucide-react';
import { articleHtml, articleMarkdown, mediaFileUrl } from './articleFormat';

type MediaFile = { path: string; name: string; kind: 'image' | 'video' };
type Props = { root: string; desktop: boolean; title: string; body: string; preview: boolean; onTitle: (value: string) => void; onBody: (value: string) => void; onBusy: (busy: boolean) => void; onMessage: (value: string) => void; onError: (value: string) => void; onOpenLink: (url: string) => void; isCurrent: () => boolean; onEditSelection: (selection: { start: number; end: number; text: string }, body: string) => void };

export default function ArticleEditor({ root, desktop, title, body, preview, onTitle, onBody, onBusy, onMessage, onError, onOpenLink, isCurrent, onEditSelection }: Props) {
  const { t, tError } = useI18n();
  const input = useRef<HTMLTextAreaElement>(null);
  const currentBody = useRef(body);
  currentBody.current = body;
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => { if (preview) setHasSelection(false); }, [preview]);
  const selection = () => ({ start: input.current?.selectionStart ?? currentBody.current.length, end: input.current?.selectionEnd ?? currentBody.current.length });
  const insert = (text: string, range = selection(), block = false) => {
    const value = currentBody.current;
    const before = value.slice(0, range.start), after = value.slice(range.end);
    const prefix = block && before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    const suffix = block && after && !after.startsWith('\n\n') ? (after.startsWith('\n') ? '\n' : '\n\n') : '';
    const updated = before + prefix + text + suffix + after;
    currentBody.current = updated;
    onBody(updated);
    requestAnimationFrame(() => { if (input.current) { input.current.focus(); const pos = before.length + prefix.length + text.length; input.current.setSelectionRange(pos, pos); } });
  };
  const heading = (level: number) => {
    const range = selection(), value = currentBody.current;
    const start = range.start === 0 ? 0 : value.lastIndexOf('\n', range.start - 1) + 1;
    const lineEnd = value.indexOf('\n', range.start);
    const end = lineEnd === -1 ? value.length : lineEnd;
    const line = value.slice(start, end).replace(/^#{1,6}\s+/, '');
    insert(`${'#'.repeat(level)} ${line}`, { start, end });
  };
  const importFile = async (kind: 'image' | 'video') => {
    if (!desktop) { onError(t("请在桌面应用中添加图片和视频。")); return; }
    const range = selection();
    onBusy(true);
    try {
      const path = await open({ multiple: false, filters: [{ name: kind === 'image' ? t("图片") : t("视频"), extensions: kind === 'image' ? ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'] : ['mp4', 'mov', 'm4v', 'webm'] }] });
      if (typeof path !== 'string' || !isCurrent()) return;
      const media = await invoke<MediaFile>('content_import_media', { root, path });
      if (!isCurrent()) { onError(t("文件已导入，但文章已切换，请重新插入。")); return; }
      const url = mediaFileUrl(media.path);
      const label = media.name.replace(/[\r\n]+/g, ' ').replace(/[\[\]\\]/g, '\\$&');
      insert(media.kind === 'image' ? `![${label}](<${url}>)` : `<video controls src="${url}"></video>`, range, true);
      onMessage(t("文件已添加，请保存文章"));
    } catch (error) { onError(t("添加文件失败：{0}", tError(error))); }
    finally { onBusy(false); }
  };
  const copy = async (format: 'markdown' | 'html') => {
    try {
      await navigator.clipboard.writeText(format === 'markdown' ? articleMarkdown(title, body) : articleHtml(title, body));
      onMessage(t("已复制 {0}{1}", format === 'markdown' ? 'Markdown' : 'HTML', /file:\/\//i.test(body) ? t('；本地文件需另行上传') : ''));
    } catch { onError(t("复制失败，请检查剪贴板权限。")); }
  };
  const previewFile = (url: string) => {
    if (!desktop) return url;
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/(\w:)/, '$1');
    return convertFileSrc(path);
  };
  return <>
    {preview ? <h1 className="article-reader-title">{title || t("未命名文章")}</h1> : <input className="content-title-input" aria-label={t("文章标题")} placeholder={t("文章标题")} value={title} onChange={e => onTitle(e.target.value)}/>}
    <div className="article-editor-toolbar" role="toolbar" aria-label={t("文章编辑工具")}>
      {!preview && <><button type="button" onMouseDown={e => e.preventDefault()} onClick={() => heading(2)} title={t("二级标题")}><Heading2 size={16}/> {t("标题")}</button>
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => heading(3)} title={t("三级标题")}><Heading3 size={16}/> {t("小标题")}</button>
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => void importFile('image')}><ImagePlus size={16}/> {t("图片")}</button>
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => void importFile('video')}><Video size={16}/> {t("视频")}</button>
      <button type="button" onMouseDown={e => e.preventDefault()} disabled={!hasSelection} onClick={() => { const range = selection(); const text = currentBody.current.slice(range.start, range.end); if (text) onEditSelection({ ...range, text }, currentBody.current); }}><Sparkles size={16}/> {t("修改选中内容")}</button></>}
      <span className="article-editor-spacer"/>
      <button type="button" onClick={() => void copy('markdown')}>{t("复制 Markdown")}</button>
      <button type="button" onClick={() => void copy('html')}>{t("复制 HTML")}</button>
    </div>
    {preview ? <div className="article-preview" onClick={e => { const link = (e.target as HTMLElement).closest('a'); if (!link) return; e.preventDefault(); const href = link.getAttribute('href') || ''; if (/^https?:\/\//i.test(href)) onOpenLink(href); }} dangerouslySetInnerHTML={{ __html: articleHtml('', body, previewFile) }}/> : <textarea ref={input} className="content-body-input" aria-label={t("文章正文")} placeholder={t("写下你的想法……")} value={body} onSelect={e => setHasSelection(e.currentTarget.selectionStart !== e.currentTarget.selectionEnd)} onChange={e => onBody(e.target.value)}/>}
  </>;
}
