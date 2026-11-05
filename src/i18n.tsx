import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import en from './translations/en.json';
import backendEn from './translations/backend-en.json';
import { resolveLanguage, translateBackend, translateText, type Language, type LanguagePreference } from './i18nCore';
export type { LanguagePreference } from './i18nCore';

type Translation = (key: string, ...values: unknown[]) => string;
type I18n = { language: Language; preference: LanguagePreference; setPreference: (value: LanguagePreference) => void; t: Translation; tError: (value: unknown) => string };
const translations: Record<string, string> = en;
const storageKey = 'seabird-language';
const systemLanguage = (): Language => resolveLanguage('system', typeof navigator === 'undefined' ? 'en' : navigator.language);
const initialPreference = (): LanguagePreference => {
  try { const saved = localStorage.getItem(storageKey); return saved === 'zh' || saved === 'en' || saved === 'system' ? saved : 'system'; } catch { return 'system'; }
};
const Context = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setStoredPreference] = useState<LanguagePreference>(initialPreference);
  const [system, setSystem] = useState<Language>(systemLanguage);
  useEffect(() => { const update = () => setSystem(systemLanguage()); window.addEventListener('languagechange', update); return () => window.removeEventListener('languagechange', update); }, []);
  const language = preference === 'system' ? system : preference;
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; }, [language]);
  const setPreference = useCallback((value: LanguagePreference) => { setStoredPreference(value); try { localStorage.setItem(storageKey, value); } catch { /* The choice remains active for this session. */ } }, []);
  const t = useCallback<Translation>((key, ...values) => translateText(languageRef.current, key, values, translations), []);
  const tError = useCallback((value: unknown) => translateBackend(languageRef.current, value, backendEn), []);
  const context = useMemo(() => ({ language, preference, setPreference, t, tError }), [language, preference, setPreference, t, tError]);
  return <Context.Provider value={context}>{children}</Context.Provider>;
}
export function useI18n(): I18n {
  const context = useContext(Context);
  if (!context) throw new Error('I18nProvider is missing');
  return context;
}
