import { useI18n } from './i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import './calendar.css';
import { calendarDateKey as dateKey, calendarLocalInput as localInput, calendarMonthDays, parseCalendarLocalInput } from './calendarDate';
import { useTransientMessage } from './useTransientMessage';

type Article = { id: number; title: string };
type Publication = { id: number; article_id: number; article_title: string; published_at: number };
type SaveResult = { id: number; backup_warning: string | null };
type Props = { root: string; desktop: boolean; articles: Article[]; initialArticleId: number | null; onConsumed: () => void; onOpenArticle: (id: number) => void; onBusy: (busy: boolean) => void };
type Form = { articleId: string; dateTime: string; original: Publication | null };
const previewKey = (root: string) => `seabird-publications-preview:${root}`;
function previewLoad(root: string, articles: Article[]): Publication[] {
  const value = JSON.parse(localStorage.getItem(previewKey(root)) || '[]') as Publication[];
  return value.filter(item => articles.some(article => article.id === item.article_id)).map(item => ({ ...item, article_title: articles.find(article => article.id === item.article_id)!.title }));
}

export default function PublicationCalendar({ root, desktop, articles, initialArticleId, onConsumed, onOpenArticle, onBusy }: Props) {
  const { t, tError, language } = useI18n();
  const locale = language === 'zh' ? 'zh-CN' : 'en';
  const timeLabel = (timestamp: number) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp);
  const dateLabel = (key: string) => { const [year, month, day] = key.split('-').map(Number); return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(year, month - 1, day)); };
  const now = new Date();
  const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [selected, setSelected] = useState(() => dateKey(now));
  const [records, setRecords] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useTransientMessage();
  const [notice, setNotice] = useTransientMessage();
  const [form, setForm] = useState<Form | null>(() => initialArticleId ? { articleId: String(initialArticleId), dateTime: localInput(now), original: null } : null);
  useEffect(() => { if (initialArticleId) onConsumed(); }, []);
  const load = async () => desktop ? await invoke<Publication[]>('publication_list', { root }) : previewLoad(root, articles);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    load().then(items => { if (!cancelled) setRecords(items); }).catch(e => { if (!cancelled) setError(t("无法读取发布记录：{0}", tError(e))); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [root, desktop, articles]);
  const days = useMemo(() => calendarMonthDays(month), [month]);
  const byDay = useMemo(() => {
    const map = new Map<string, Publication[]>();
    for (const record of records) { const key = dateKey(new Date(record.published_at)); map.set(key, [...(map.get(key) || []), record]); }
    for (const items of map.values()) items.sort((a, b) => a.published_at - b.published_at || a.id - b.id);
    return map;
  }, [records]);
  const dayRecords = byDay.get(selected) || [];
  const monthCount = records.filter(record => { const date = new Date(record.published_at); return date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth(); }).length;
  const selectDay = (date: Date) => { setSelected(dateKey(date)); if (date.getMonth() !== month.getMonth() || date.getFullYear() !== month.getFullYear()) setMonth(new Date(date.getFullYear(), date.getMonth(), 1)); };
  const changeMonth = (delta: number) => { const next = new Date(month.getFullYear(), month.getMonth() + delta, 1); setMonth(next); setSelected(dateKey(next)); };
  const goToday = () => { const date = new Date(); setMonth(new Date(date.getFullYear(), date.getMonth(), 1)); setSelected(dateKey(date)); };
  const startNew = () => { const time = localInput(new Date()).slice(11); setError(''); setNotice(''); setForm({ articleId: '', dateTime: `${selected}T${time}`, original: null }); };
  const beginEdit = (item: Publication) => { setError(''); setNotice(''); setForm({ articleId: String(item.article_id), dateTime: localInput(new Date(item.published_at)), original: item }); };
  const save = async () => {
    if (!form || busyRef.current) return;
    const timestamp = parseCalendarLocalInput(form.dateTime);
    if (timestamp === null) { setError(t("请选择有效的日期和时间。")); return; }
    const date = new Date(timestamp);
    const articleId = Number(form.articleId);
    if (!articleId) { setError(t("请选择文章。")); return; }
    const article = articles.find(item => item.id === articleId);
    if (articleId && !article) { setError(t("文章不存在，请重新选择。")); return; }
    const item: Publication = { id: form.original?.id || 0, article_id: articleId, article_title: article?.title || form.original?.article_title || '', published_at: date.getTime() };
    busyRef.current = true; setWorking(true); onBusy(true); setError(''); setNotice('');
    try {
      let result: SaveResult;
      if (desktop) result = await invoke<SaveResult>('publication_save', { root, item, expected: form.original });
      else { const previous = previewLoad(root, articles); const id = item.id || Date.now(); localStorage.setItem(previewKey(root), JSON.stringify([...previous.filter(row => row.id !== id), { ...item, id }])); result = { id, backup_warning: null }; }
      setForm(null); setSelected(dateKey(date)); setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
      try { setRecords(await load()); } catch (e) { setError(t("记录已保存，但刷新失败：{0}", tError(e))); return; }
      if (result.backup_warning) setError(t("记录已保存，但备份失败：{0}", tError(result.backup_warning))); else setNotice(t("发布记录已保存"));
    } catch (e) { setError(t("保存失败：{0}", tError(e))); }
    finally { busyRef.current = false; setWorking(false); onBusy(false); }
  };
  const remove = async (item: Publication) => {
    if (busyRef.current || !window.confirm(t("删除“{0}”的这条发布记录？", item.article_title))) return;
    busyRef.current = true; setWorking(true); onBusy(true); setError(''); setNotice('');
    try {
      let warning: string | null;
      if (desktop) warning = await invoke<string | null>('publication_delete', { root, id: item.id });
      else { localStorage.setItem(previewKey(root), JSON.stringify(previewLoad(root, articles).filter(row => row.id !== item.id))); warning = null; }
      if (form?.original?.id === item.id) setForm(null);
      try { setRecords(await load()); } catch (e) { setError(t("记录已删除，但刷新失败：{0}", tError(e))); return; }
      if (warning) setError(t("记录已删除，但备份失败：{0}", tError(warning))); else setNotice(t("发布记录已删除"));
    } catch (e) { setError(t("删除失败：{0}", tError(e))); }
    finally { busyRef.current = false; setWorking(false); onBusy(false); }
  };
  return <section className="publication-calendar">
    <div className="content-page-heading publication-heading"><div><span className="content-kicker">PUBLISHING CALENDAR</span><h1>{t("发布日历")}</h1><p>{t("记录文章的发布时间。")}</p></div><button type="button" className="content-primary" disabled={working || !articles.length || !!form} onClick={startNew}><Plus size={15}/> {t("记录发布")}</button></div>
    {(error || notice) && <div className={`content-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button type="button" aria-label={t("关闭提示")} onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
    <div className="publication-layout"><div className="publication-month"><div className="publication-month-head"><div><h2>{new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(month)}</h2><span>{t(language === 'en' && monthCount === 1 ? '{0} 条发布记录（单数）' : '{0} 条发布记录', monthCount)}</span></div><div className="publication-month-actions"><button type="button" aria-label={t("上个月")} onClick={() => changeMonth(-1)}><ChevronLeft size={17}/></button><button type="button" onClick={goToday}>{t("今天")}</button><button type="button" aria-label={t("下个月")} onClick={() => changeMonth(1)}><ChevronRight size={17}/></button></div></div>
      <div className="publication-weekdays" aria-hidden="true">{[t("一"),t("二"),t("三"),t("四"),t("五"),t("六"),t("日")].map(day => <span key={day}>{day}</span>)}</div>
      <div className="publication-grid" aria-label={t("选择日期")}>{days.map(date => { const key = dateKey(date), items = byDay.get(key) || [], inMonth = date.getMonth() === month.getMonth(); return <button type="button" key={key} className={`publication-day${inMonth ? '' : ' outside'}${key === selected ? ' selected' : ''}${key === dateKey(new Date()) ? ' today' : ''}`} aria-pressed={key === selected} aria-label={t(language === 'en' && items.length === 1 ? '{0}，{1}条发布记录（单数）' : '{0}，{1}条发布记录', dateLabel(key), items.length)} onClick={() => selectDay(date)}><span className="publication-day-number">{date.getDate()}</span>{items.length > 0 && <><span className="publication-day-count">{items.length}</span><span className="publication-day-items">{items.slice(0, 2).map(item => <span key={item.id}><time>{timeLabel(item.published_at)}</time> {item.article_title}</span>)}{items.length > 2 && <span>{t("还有")} {items.length - 2} {t("条")}</span>}</span></>}</button>; })}</div>
    </div><aside className="publication-detail"><div className="publication-detail-head"><div><span>{t("已选日期")}</span><h2>{dateLabel(selected)}</h2></div><CalendarDays size={18}/></div>{loading ? <p className="publication-empty">{t("正在读取…")}</p> : dayRecords.length ? <div className="publication-list">{dayRecords.map(item => <div className="publication-record" key={item.id}><time>{timeLabel(item.published_at)}</time><div><button type="button" className="publication-title" onClick={() => onOpenArticle(item.article_id)}>{item.article_title}</button></div><div className="publication-record-actions"><button type="button" disabled={!!form} onClick={() => beginEdit(item)} aria-label={t("编辑 {0} 的发布记录", item.article_title)}>{t("编辑")}</button><button type="button" aria-label={t("删除 {0} 的发布记录", item.article_title)} onClick={() => void remove(item)}><Trash2 size={14}/></button></div></div>)}</div> : <p className="publication-empty">{t("这一天还没有发布记录。")}</p>}
      {!articles.length && !loading && <p className="publication-empty">{t("保存文章后，可以在这里记录发布时间。")}</p>}
      {form && <div className="publication-form"><h3>{form.original ? t("编辑发布记录") : t("记录发布")}</h3><label>{language === 'zh' ? '文章' : t("文章类型")}<select value={form.articleId} onChange={e => setForm({ ...form, articleId: e.target.value })}><option value="">{t("选择文章")}</option>{articles.map(article => <option key={article.id} value={article.id}>{article.title}</option>)}</select></label><label>{t("发布时间")}<input type="datetime-local" value={form.dateTime} onChange={e => setForm({ ...form, dateTime: e.target.value })}/></label><div className="publication-form-actions"><button type="button" className="content-soft" onClick={() => setForm(null)}>{t("取消")}</button><button type="button" className="content-primary" disabled={working || !form.articleId || !form.dateTime} onClick={() => void save()}>{working ? t("保存中…") : t("保存")}</button></div></div>}
    </aside></div>
  </section>;
}
