export function generatedCoverPath(text: string): string | null {
  const blocks = [...text.matchAll(/```seabird-cover\s*\n([\s\S]*?)\n```/g)];
  for (const block of blocks.reverse()) {
    try {
      const value: unknown = JSON.parse(block[1]);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const path = (value as Record<string, unknown>).path;
        if (typeof path === 'string' && (/^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path))) return path;
      }
    } catch { /* Ignore malformed output. */ }
  }
  return null;
}

export function hideGeneratedCoverBlock(text: string): string {
  return text.replace(/(?:^|\n)```seabird-cover\s*\n[\s\S]*?\n```[ \t]*(?=\n|$)/g, '').trim();
}
import type { Article } from './articleAutoSave';


type CoverTarget = { root: string; id: number; original: Article['cover']; canApply: () => boolean };
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export async function saveGeneratedCover(target: CoverTarget, path: string, invoke: Invoke): Promise<string | null> {
  if (!target.canApply()) throw new Error('封面已被修改，请检查后重新生成。');
  const media = await invoke<Article['cover']>('content_import_media', { root: target.root, path });
  if (!media || media.kind !== 'image') throw new Error('生成的文件不是图片，请重试。');
  const data = await invoke<{ articles: Article[] }>('content_load', { root: target.root });
  const article = data.articles.find(item => item.id === target.id);
  if (!article) throw new Error('文章不存在，请刷新后重试。');
  if (!target.canApply() || JSON.stringify(article.cover) !== JSON.stringify(target.original)) throw new Error('封面已被修改，请检查后重新生成。');
  const result = await invoke<{ backup_warning: string | null }>('content_save_article', { root: target.root, item: { ...article, cover: media }, expected: article });
  return result.backup_warning;
}
