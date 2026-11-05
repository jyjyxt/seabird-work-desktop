export type LanguagePreference = 'system' | 'zh' | 'en';
export type Language = 'zh' | 'en';
export type BackendCatalog = { exact: Record<string, string>; prefixes: Record<string, string> };

export function resolveLanguage(preference: LanguagePreference, systemLocale: string): Language {
  return preference === 'system' ? (systemLocale.toLowerCase().startsWith('zh') ? 'zh' : 'en') : preference;
}
export function translateText(language: Language, key: string, values: unknown[], catalog: Record<string, string>): string {
  const translated = language === 'en' && Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : key;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match);
}
export function translateBackend(language: Language, value: unknown, catalog: BackendCatalog): string {
  const text = String(value);
  if (language !== 'en') return text;
  if (text.startsWith('Error: ')) return `Error: ${translateBackend(language, text.slice(7), catalog)}`;
  if (Object.prototype.hasOwnProperty.call(catalog.exact, text)) return catalog.exact[text];
  if (text.includes('；')) return text.split('；').map(part => translateBackend(language, part, catalog)).join('; ');
  for (const [prefix, translated] of Object.entries(catalog.prefixes)) {
    if (text.startsWith(prefix)) return translated + translateBackend(language, text.slice(prefix.length), catalog);
  }
  return text;
}
