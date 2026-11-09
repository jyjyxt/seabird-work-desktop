export type Article = { id: number; title: string; body: string; tags: string; versions: Record<string, { title: string; body: string }>; material_ids: number[]; cover: { path: string; name: string; kind: string } | null; updated_at: string };

export function canAutoSaveArticle(article: Article | null, snapshot: string, blocked: boolean): article is Article {
  return !blocked && !!article && article.id > 0 && !!article.title.trim() && JSON.stringify(article) !== snapshot;
}

export function startArticleAutoSave(tick: () => void): () => void {
  const timer = globalThis.setInterval(tick, 15_000);
  return () => globalThis.clearInterval(timer);
}

const normalizedVersions = (article: Article) => Object.keys(article.versions).sort().map(key => [key, article.versions[key].title, article.versions[key].body]);

// A later external write must not become the expected version for the next save.
export function isSavedArticle(submitted: Article, saved: Article, desktop: boolean): boolean {
  return saved.id === submitted.id && saved.title === (desktop ? submitted.title.trim() : submitted.title) && saved.body === submitted.body && saved.tags === submitted.tags
    && JSON.stringify(saved.cover || null) === JSON.stringify(submitted.cover || null)
    && JSON.stringify(normalizedVersions(saved)) === JSON.stringify(normalizedVersions(submitted))
    && JSON.stringify([...saved.material_ids].sort((a, b) => a - b)) === JSON.stringify([...submitted.material_ids].sort((a, b) => a - b));
}

export function mergeSavedArticle(current: Article, submitted: Article, saved: Article): Article {
  return JSON.stringify(current) === JSON.stringify(submitted) ? saved : { ...current, updated_at: saved.updated_at };
}

// Merge an externally generated cover only if neither side changed the other's fields.
export function mergeExternalCover(current: Article, previous: Article, latest: Article): Article | null {
  if (current.id !== previous.id || latest.id !== previous.id) return null;
  if (JSON.stringify(current.cover) !== JSON.stringify(previous.cover)) return null;
  const withoutCover = (article: Article) => ({ ...article, cover: null, updated_at: '' });
  if (JSON.stringify(withoutCover(previous)) !== JSON.stringify(withoutCover(latest))) return null;
  return { ...current, cover: latest.cover, updated_at: latest.updated_at };
}
