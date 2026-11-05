export type ArticleTarget = {
  root: string;
  id: number;
  editor: string;
  platform: string;
  title: string;
  body: string;
  selection?: { start: number; end: number; text: string };
};
export type AgentContext = { text: string; article?: ArticleTarget };
export type ArticleEdit = { body: string; title?: string };

export function parseArticleEdit(text: string): { text: string; edit: ArticleEdit | null } {
  const match = text.match(/(?:^|\n)```seabird-edit\s*\n([\s\S]*?)\n```[ \t]*(?=\n|$)/);
  if (!match || match.index === undefined) return { text, edit: null };
  try {
    const item: unknown = JSON.parse(match[1]);
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { text, edit: null };
    const value = item as Record<string, unknown>;
    if (typeof value.body !== 'string' || (value.title !== undefined && typeof value.title !== 'string')) return { text, edit: null };
    return { text: (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim(), edit: { body: value.body, ...(typeof value.title === 'string' ? { title: value.title } : {}) } };
  } catch { return { text, edit: null }; }
}

export function resolveArticleSelection(original: string, current: string, selection: NonNullable<ArticleTarget['selection']>): NonNullable<ArticleTarget['selection']> | null {
  const { start, end, text } = selection;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > original.length || original.slice(start, end) !== text) return null;
  if (current === original) return selection;
  const oldPosition = original.indexOf(text);
  const newPosition = current.indexOf(text);
  if (oldPosition !== start || original.lastIndexOf(text) !== oldPosition || newPosition < 0 || current.lastIndexOf(text) !== newPosition) return null;
  return { start: newPosition, end: newPosition + text.length, text };
}

export function applyArticleEdit(target: ArticleTarget, current: { title: string; body: string }, edit: ArticleEdit): { title: string; body: string } | null {
  if (target.selection) {
    const selection = resolveArticleSelection(target.body, current.body, target.selection);
    if (!selection) return null;
    return { title: current.title, body: current.body.slice(0, selection.start) + edit.body + current.body.slice(selection.end) };
  }
  if (current.body !== target.body || current.title !== target.title) return null;
  return { title: edit.title ?? current.title, body: edit.body };
}

export function undoArticleEdit<T extends { id: number; updated_at: string }>(before: T, after: T, current: T): T | null {
  if (after.id !== 0 && current.id !== after.id) return null;
  const expected = { ...after, id: current.id, updated_at: current.updated_at };
  if (JSON.stringify(current) !== JSON.stringify(expected)) return null;
  return { ...before, id: current.id, updated_at: current.updated_at };
}
