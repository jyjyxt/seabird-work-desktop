import { useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Eye, Heading2, Heading3, ImagePlus, Video } from 'lucide-react';
import { articleHtml, articleMarkdown, mediaFileUrl } from './articleFormat';

type MediaFile = { path: string; name: string; kind: 'image' | 'video' };
type Props = { root: string; desktop: boolean; title: string; body: string; original: boolean; onTitle: (value: string) => void; onBody: (value: string) => void; onBusy: (busy: boolean) => void; onMessage: (value: string) => void; onError: (value: string) => void; isCurrent: () => boolean };

export default function ArticleEditor({ root, desktop, title, body, original, onTitle, onBody, onBusy, onMessage, onError, isCurrent }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const currentBody = useRef(body);
  currentBody.current = body;
  const [preview, setPreview] = useState(false);
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
    if (!desktop) { onError('请在桌面应用中添加图片和视频。'); return; }
    const range = selection();
    onBusy(true);
    try {
      const path = await open({ multiple: false, filters: [{ name: kind === 'image' ? '图片' : '视频', extensions: kind === 'image' ? ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'] : ['mp4', 'mov', 'm4v', 'webm'] }] });
      if (typeof path !== 'string' || !isCurrent()) return;
      const media = await invoke<MediaFile>('content_import_media', { root, path });
      if (!isCurrent()) { onError('文件已导入，但文章已切换，请重新插入。'); return; }
      const url = mediaFileUrl(media.path);
      const label = media.name.replace(/[\r\n]+/g, ' ').replace(/[\[\]\\]/g, '\\$&');
      insert(media.kind === 'image' ? `![${label}](<${url}>)` : `<video controls src="${url}"></video>`, range, true);
      onMessage('文件已添加，请保存文章');
    } catch (error) { onError(`添加文件失败：${String(error)}`); }
    finally { onBusy(false); }
  };
  const copy = async (format: 'markdown' | 'html') => {
    try {
      await navigator.clipboard.writeText(format === 'markdown' ? articleMarkdown(title, body) : articleHtml(title, body));
      onMessage(`已复制 ${format === 'markdown' ? 'Markdown' : 'HTML'}${/file:\/\//i.test(body) ? '；本地文件需另行上传' : ''}`);
    } catch { onError('复制失败，请检查剪贴板权限。'); }
  };
  const previewFile = (url: string) => {
    if (!desktop) return url;
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/(\w:)/, '$1');
    return convertFileSrc(path);
  };
  return <>
    <input className="content-title-input" aria-label={original ? '文章标题' : '平台标题'} placeholder={original ? '文章标题' : '平台标题'} value={title} onChange={e => onTitle(e.target.value)}/>
    <div className="article-editor-toolbar" role="toolbar" aria-label="文章编辑工具">
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => heading(2)} disabled={preview} title="二级标题"><Heading2 size={16}/> 标题</button>
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => heading(3)} disabled={preview} title="三级标题"><Heading3 size={16}/> 小标题</button>
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => void importFile('image')} disabled={preview}><ImagePlus size={16}/> 图片</button>
      <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => void importFile('video')} disabled={preview}><Video size={16}/> 视频</button>
      <button type="button" className={preview ? 'active' : ''} onClick={() => setPreview(value => !value)} aria-pressed={preview}><Eye size={16}/> {preview ? '编辑' : '预览'}</button>
      <span className="article-editor-spacer"/>
      <button type="button" onClick={() => void copy('markdown')}>复制 Markdown</button>
      <button type="button" onClick={() => void copy('html')}>复制 HTML</button>
    </div>
    {preview ? <div className="article-preview" onClick={e => { if ((e.target as HTMLElement).closest('a')) e.preventDefault(); }} dangerouslySetInnerHTML={{ __html: articleHtml('', body, previewFile) }}/> : <textarea ref={input} className="content-body-input" aria-label={original ? '文章原稿' : '平台正文'} placeholder={original ? '写下你的想法……' : '在这里写下适合这个平台的版本……'} value={body} onChange={e => onBody(e.target.value)}/>}
  </>;
}
