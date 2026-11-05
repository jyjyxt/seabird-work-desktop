export type SaveSuggestion = {
  kind: 'material' | 'article';
  title: string;
  body: string;
  source: string;
  url: string;
  tags: string;
};

// Only hide the block when every suggestion can be saved without guessing.
export function parseSaveSuggestions(text: string): { text: string; suggestions: SaveSuggestion[] } {
  const match = text.match(/(?:^|\n)```seabird-save\s*\n([\s\S]*?)\n```[ \t]*(?=\n|$)/);
  if (!match || match.index === undefined) return { text, suggestions: [] };
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 5) return { text, suggestions: [] };
    const suggestions: SaveSuggestion[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || !['material', 'article'].includes(item.kind) || typeof item.title !== 'string' || !item.title.trim() || typeof item.body !== 'string' || !item.body.trim()) return { text, suggestions: [] };
      if (['source', 'url', 'tags'].some(key => item[key] !== undefined && typeof item[key] !== 'string')) return { text, suggestions: [] };
      suggestions.push({ kind: item.kind, title: item.title.trim(), body: item.body, source: item.source || '', url: item.url || '', tags: item.tags || '' });
    }
    return { text: (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim(), suggestions };
  } catch { return { text, suggestions: [] }; }
}
