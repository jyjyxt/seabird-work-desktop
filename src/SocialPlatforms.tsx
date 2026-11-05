import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, ExternalLink, Pencil, Plus, Settings2, Trash2, X } from 'lucide-react';
import wechatIcon from './assets/platforms/wechat.svg';
import zhihuIcon from './assets/platforms/zhihu.svg';
import xiaohongshuIcon from './assets/platforms/xiaohongshu.svg';
import toutiaoIcon from './assets/platforms/toutiao.svg';
import xIcon from './assets/platforms/x.svg';
import instagramIcon from './assets/platforms/instagram.svg';
import youtubeIcon from './assets/platforms/youtube.svg';
import redditIcon from './assets/platforms/reddit.svg';
import linkedinIcon from './assets/platforms/linkedin.svg';
import facebookIcon from './assets/platforms/facebook.svg';
import tiktokIcon from './assets/platforms/tiktok.svg';
import threadsIcon from './assets/platforms/threads.svg';
import sinaweiboIcon from './assets/platforms/sinaweibo.svg';
import bilibiliIcon from './assets/platforms/bilibili.svg';
import douyinIcon from './assets/platforms/douyin.svg';
import mediumIcon from './assets/platforms/medium.svg';
import telegramIcon from './assets/platforms/telegram.svg';

type Kind = 'article' | 'image' | 'video';
type Platform = { id: number; name: string; image_url: string; url: string; types: Kind[]; enabled?: boolean };
type Props = { desktop: boolean; mode: 'settings' | 'article'; onLookup?: (url: string) => Promise<{ name: string; image_url: string }>; onStopLookup?: () => void; onSettings?: () => void };
const kinds: { value: Kind; label: string }[] = [{ value: 'article', label: '文章' }, { value: 'image', label: '图片' }, { value: 'video', label: '视频' }];
const previewKey = 'seabird-social-platforms-preview';
const previewDefaults: Platform[] = [
  { id: 1, name: '微信公众号', image_url: 'https://mp.weixin.qq.com/favicon.ico', url: 'https://mp.weixin.qq.com/', types: ['article'] },
  { id: 2, name: '知乎', image_url: 'https://www.zhihu.com/favicon.ico', url: 'https://zhuanlan.zhihu.com/write', types: ['article'] },
  { id: 3, name: '小红书', image_url: 'https://www.xiaohongshu.com/favicon.ico', url: 'https://creator.xiaohongshu.com/', types: ['article', 'image', 'video'] },
  { id: 4, name: '今日头条', image_url: 'https://www.toutiao.com/favicon.ico', url: 'https://mp.toutiao.com/', types: ['article', 'image', 'video'] },
  { id: 5, name: 'X', image_url: 'https://x.com/favicon.ico', url: 'https://x.com/compose/post', types: ['article', 'image', 'video'] },
  { id: 6, name: 'Instagram', image_url: 'https://www.instagram.com/favicon.ico', url: 'https://www.instagram.com/', types: ['article', 'image', 'video'] },
  { id: 7, name: 'YouTube', image_url: 'https://www.youtube.com/favicon.ico', url: 'https://studio.youtube.com/', types: ['article', 'image', 'video'] },
  { id: 8, name: 'Reddit', image_url: 'https://www.reddit.com/favicon.ico', url: 'https://www.reddit.com/submit', types: ['article', 'image', 'video'] },
  { id: 9, name: 'LinkedIn', image_url: 'https://www.linkedin.com/favicon.ico', url: 'https://www.linkedin.com/feed/', types: ['article', 'image', 'video'] },
  { id: 10, name: 'Facebook', image_url: 'https://www.facebook.com/favicon.ico', url: 'https://www.facebook.com/', types: ['article', 'image', 'video'] },
  { id: 11, name: 'TikTok', image_url: 'https://www.tiktok.com/favicon.ico', url: 'https://www.tiktok.com/upload', types: ['article', 'image', 'video'] },
  { id: 12, name: 'Threads', image_url: 'https://www.threads.com/favicon.ico', url: 'https://www.threads.com/', types: ['article', 'image', 'video'] },
  { id: 13, name: '微博', image_url: 'https://weibo.com/favicon.ico', url: 'https://weibo.com/', types: ['article', 'image', 'video'] },
  { id: 14, name: '哔哩哔哩', image_url: 'https://www.bilibili.com/favicon.ico', url: 'https://member.bilibili.com/', types: ['article', 'image', 'video'] },
  { id: 15, name: '抖音', image_url: 'https://www.douyin.com/favicon.ico', url: 'https://creator.douyin.com/', types: ['article', 'image', 'video'] },
  { id: 16, name: 'Medium', image_url: 'https://medium.com/favicon.ico', url: 'https://medium.com/new-story', types: ['article', 'image', 'video'] },
  { id: 17, name: 'Telegram', image_url: 'https://telegram.org/favicon.ico', url: 'https://web.telegram.org/', types: ['article', 'image', 'video'] },
];
const defaultEnabled = new Set(['微信公众号', '知乎', '小红书', 'X', 'YouTube']);
const bundledIcons: Record<string, string> = {
  'https://mp.weixin.qq.com/favicon.ico': wechatIcon,
  'https://www.zhihu.com/favicon.ico': zhihuIcon,
  'https://www.xiaohongshu.com/favicon.ico': xiaohongshuIcon,
  'https://www.toutiao.com/favicon.ico': toutiaoIcon,
  'https://x.com/favicon.ico': xIcon,
  'https://www.instagram.com/favicon.ico': instagramIcon,
  'https://www.youtube.com/favicon.ico': youtubeIcon,
  'https://www.reddit.com/favicon.ico': redditIcon,
  'https://www.linkedin.com/favicon.ico': linkedinIcon,
  'https://www.facebook.com/favicon.ico': facebookIcon,
  'https://www.tiktok.com/favicon.ico': tiktokIcon,
  'https://www.threads.com/favicon.ico': threadsIcon,
  'https://weibo.com/favicon.ico': sinaweiboIcon,
  'https://www.bilibili.com/favicon.ico': bilibiliIcon,
  'https://www.douyin.com/favicon.ico': douyinIcon,
  'https://medium.com/favicon.ico': mediumIcon,
  'https://telegram.org/favicon.ico': telegramIcon,
};
const empty = (): Platform => ({ id: 0, name: '', image_url: '', url: '', types: ['article'], enabled: true });
const validUrl = (value: string) => { try { return ['http:', 'https:'].includes(new URL(value.trim()).protocol); } catch { return false; } };
function Icon({ platform }: { platform: Platform }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [platform.image_url]);
  return <span className="social-icon">{failed ? platform.name.slice(0, 1) : <img src={bundledIcons[platform.image_url] || platform.image_url} alt="" onError={() => setFailed(true)}/>}</span>;
}

export default function SocialPlatforms({ desktop, mode, onLookup, onStopLookup, onSettings }: Props) {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [form, setForm] = useState<Platform | null>(null);
  const [busy, setBusy] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const load = async () => {
    if (!desktop && localStorage.getItem(previewKey) === null) {
      localStorage.setItem(previewKey, JSON.stringify(previewDefaults));
      localStorage.setItem(`${previewKey}:defaults-v2`, '1');
    } else if (!desktop && localStorage.getItem(`${previewKey}:defaults-v2`) === null) {
      const saved = JSON.parse(localStorage.getItem(previewKey) || '[]') as Platform[];
      const additions = previewDefaults.slice(4).filter(item => !saved.some(existing => existing.name === item.name || existing.url === item.url));
      localStorage.setItem(previewKey, JSON.stringify([...saved, ...additions.map((item, index) => ({ ...item, id: Date.now() + index }))]));
      localStorage.setItem(`${previewKey}:defaults-v2`, '1');
    }
    if (!desktop && localStorage.getItem(`${previewKey}:selection-v1`) === null) {
      const saved = JSON.parse(localStorage.getItem(previewKey) || '[]') as Platform[];
      const updated = saved.map(item => {
        const preset = previewDefaults.find(p => p.name === item.name && p.url === item.url);
        return item.enabled === undefined && preset ? { ...item, enabled: defaultEnabled.has(item.name) } : item;
      });
      localStorage.setItem(previewKey, JSON.stringify(updated));
      localStorage.setItem(`${previewKey}:selection-v1`, '1');
    }
    const items = desktop ? await invoke<Platform[]>('social_platform_list') : JSON.parse(localStorage.getItem(previewKey) || '[]') as Platform[];
    setPlatforms(items);
    setSelected(current => current.filter(id => items.some(item => item.id === id && item.enabled !== false && item.types.includes('article'))));
  };
  useEffect(() => { const refresh = () => void load().catch(e => setError(`无法读取平台：${String(e)}`)); refresh(); window.addEventListener('seabird-platforms-changed', refresh); return () => window.removeEventListener('seabird-platforms-changed', refresh); }, [desktop]);
  const findDetails = async () => {
    if (!form || lookingUp) return;
    if (!validUrl(form.url)) { setError('请输入有效的 http 或 https 链接。'); return; }
    setLookingUp(true); setError(''); setFeedback('');
    try {
      if (!onLookup) throw new Error('无法启动 Agent');
      const result = await onLookup(form.url.trim());
      setForm(current => current ? { ...current, name: result.name || current.name, image_url: result.image_url || current.image_url } : current);
      setShowDetails(true);
      setFeedback(result.name && validUrl(result.image_url) ? '请检查获取到的信息。' : '部分信息未获取到，请补充后保存。');
    } catch (e) { setShowDetails(true); setError(`获取失败：${String(e)}。可重试或手动填写。`); }
    finally { setLookingUp(false); }
  };
  const save = async () => {
    if (!form || busy) return;
    if (!form.name.trim()) { setError('请输入平台名称。'); return; }
    if (!validUrl(form.image_url) || !validUrl(form.url)) { setError('图片地址和链接地址都需要使用 http 或 https 链接。'); return; }
    if (!form.types.length) { setError('请至少选择一种适用类型。'); return; }
    const item = { ...form, name: form.name.trim(), image_url: form.image_url.trim(), url: form.url.trim() };
    setBusy(true); setError(''); setFeedback('');
    try {
      let warning: string | null = null;
      if (desktop) warning = (await invoke<{ backup_warning: string | null }>('social_platform_save', { item })).backup_warning;
      else { const id = item.id || Date.now(); localStorage.setItem(previewKey, JSON.stringify([...platforms.filter(p => p.id !== id), { ...item, id }])); }
      await load(); window.dispatchEvent(new Event('seabird-platforms-changed')); setForm(null);
      if (warning) setError(`平台已保存，但备份失败：${warning}`); else setFeedback('平台已保存。');
    } catch (e) { setError(`保存平台失败：${String(e)}`); } finally { setBusy(false); }
  };
  const setEnabled = async (items: Platform[], enabled: boolean) => {
    if (busy || !items.length) return;
    const ids = items.map(item => item.id);
    setBusy(true); setError(''); setFeedback('');
    try {
      let warning: string | null = null;
      if (desktop) warning = await invoke<string | null>('social_platforms_set_enabled', { ids, enabled });
      else localStorage.setItem(previewKey, JSON.stringify(platforms.map(p => ids.includes(p.id) ? { ...p, enabled } : p)));
      await load(); window.dispatchEvent(new Event('seabird-platforms-changed'));
      if (warning) setError(`选择已保存，但备份失败：${warning}`);
    } catch (e) { setError(`保存选择失败：${String(e)}`); } finally { setBusy(false); }
  };
  const remove = async (item: Platform) => {
    if (busy || !window.confirm(`删除平台“${item.name}”？`)) return;
    setBusy(true); setError(''); setFeedback('');
    try {
      let warning: string | null = null;
      if (desktop) warning = await invoke<string | null>('social_platform_delete', { id: item.id });
      else localStorage.setItem(previewKey, JSON.stringify(platforms.filter(p => p.id !== item.id)));
      await load(); window.dispatchEvent(new Event('seabird-platforms-changed')); if (form?.id === item.id) setForm(null);
      if (warning) setError(`平台已删除，但备份失败：${warning}`); else setFeedback('平台已删除。');
    } catch (e) { setError(`删除平台失败：${String(e)}`); } finally { setBusy(false); }
  };
  const openSelected = async () => {
    const items = platforms.filter(item => selected.includes(item.id) && item.enabled !== false && item.types.includes('article'));
    setError(''); setFeedback('');
    if (!desktop) {
      const blocked = items.filter(item => !window.open(item.url, '_blank', 'noopener,noreferrer'));
      // Browsers may return null for noopener even when a tab opens.
      if (blocked.length) setFeedback('已请求打开所选平台；如果页面未打开，请允许弹出窗口。');
      else setFeedback('已打开平台页面，请在各平台完成发布。');
      return;
    }
    setBusy(true);
    const failed: string[] = [];
    for (const item of items) { try { await invoke('content_open_url', { url: item.url }); } catch { failed.push(item.name); } }
    if (failed.length) setError(`无法打开：${failed.join('、')}。请检查链接或浏览器设置。`);
    else setFeedback('已打开平台页面，请在各平台完成发布。');
    setBusy(false);
  };
  const articlePlatforms = platforms.filter(item => item.enabled !== false && item.types.includes('article'));
  const allArticleSelected = articlePlatforms.length > 0 && articlePlatforms.every(item => selected.includes(item.id));
  const allEnabled = platforms.length > 0 && platforms.every(item => item.enabled !== false);
  return <section className={`social-platforms${mode === 'settings' ? ' social-platforms-settings' : ''}`} aria-label="发布平台">
    {mode === 'article' ? <><div className="content-aside-title"><ExternalLink size={15}/><b>发布平台</b><button type="button" className="social-select-all" disabled={!articlePlatforms.length || busy} onClick={() => setSelected(allArticleSelected ? [] : articlePlatforms.map(item => item.id))}>{allArticleSelected ? '取消全选' : '全选'}</button><button type="button" className="social-manage" onClick={onSettings}><Settings2 size={13}/> 设置</button></div>
      {articlePlatforms.length ? <div className="social-options">{articlePlatforms.map(item => <label className="social-option" key={item.id} title={item.name}><input type="checkbox" aria-label={item.name} checked={selected.includes(item.id)} onChange={e => setSelected(current => e.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/><Icon platform={item}/>{selected.includes(item.id) && <span className="social-check" aria-hidden="true"><Check size={9} strokeWidth={3}/></span>}</label>)}</div> : <p>没有启用适用于文章的平台，请前往设置选择。</p>}
      <button type="button" className="content-primary social-publish" disabled={!selected.length || busy} onClick={() => void openSelected()}>前往发布{selected.length > 0 ? `（${selected.length}）` : ''}</button>
      <p>打开平台后，请复制文章并在平台完成发布。</p>
    </> : <>
      <div className="section-head"><div><h2>发布平台</h2><p>勾选需要显示在发布页面的平台。</p></div><button type="button" className="social-select-all" disabled={!platforms.length || busy || lookingUp || !!form} onClick={() => void setEnabled(platforms, !allEnabled)}>{allEnabled ? '取消全选' : '全选'}</button></div>
      <div className="social-admin-list">{platforms.map(item => <div className="social-admin-row" key={item.id}><label title={`${item.name}（${kinds.filter(k => item.types.includes(k.value)).map(k => k.label).join('、')}）`}><input type="checkbox" aria-label={`显示 ${item.name}`} checked={item.enabled !== false} disabled={busy || lookingUp || !!form} onChange={e => void setEnabled([item], e.target.checked)}/><Icon platform={item}/><b>{item.name}</b></label><button type="button" aria-label={`编辑平台 ${item.name}`} title="编辑" disabled={busy || lookingUp} onClick={() => { setShowDetails(true); setForm({ ...item, types: [...item.types] }); setError(''); setFeedback(''); }}><Pencil size={13}/></button></div>)}</div>
      {!form && <button type="button" className="content-link social-add" onClick={() => { setShowDetails(false); setForm(empty()); setError(''); setFeedback(''); }}><Plus size={14}/> 添加平台</button>}
      {form && <div className="social-form">
        <div className="social-form-heading"><b>{form.id ? '编辑平台' : '添加平台'}</b><button type="button" aria-label="关闭" disabled={lookingUp} onClick={() => setForm(null)}><X size={14}/></button></div>
        <label>链接地址<input type="url" placeholder="https://" value={form.url} disabled={lookingUp} onChange={e => { const url = e.target.value; if (!form.id) { setShowDetails(false); setFeedback(''); setError(''); setForm({ ...form, url, name: '', image_url: '' }); } else setForm({ ...form, url }); }}/></label>
        {!form.id && <><button type="button" className="content-soft social-lookup" disabled={lookingUp || !form.url.trim()} onClick={() => void findDetails()}>{lookingUp ? 'Agent 获取中…' : showDetails ? '重新获取名称和 Logo' : '获取名称和 Logo'}</button>{lookingUp ? <button type="button" className="content-link social-add" onClick={onStopLookup}>停止获取</button> : !showDetails && <button type="button" className="content-link social-add" onClick={() => setShowDetails(true)}>手动填写</button>}</>}
        {showDetails && <><label>名称<input value={form.name} maxLength={100} disabled={lookingUp} onChange={e => setForm({ ...form, name: e.target.value })}/></label><label>Logo 地址<input type="url" placeholder="https://" value={form.image_url} disabled={lookingUp} onChange={e => setForm({ ...form, image_url: e.target.value })}/></label>{validUrl(form.image_url) && <div className="social-logo-preview"><Icon platform={form}/><small>Logo 预览</small></div>}<div className="social-types"><span>适用类型</span><div>{kinds.map(kind => <label key={kind.value}><input type="checkbox" checked={form.types.includes(kind.value)} disabled={lookingUp} onChange={e => setForm({ ...form, types: e.target.checked ? [...form.types, kind.value] : form.types.filter(value => value !== kind.value) })}/>{kind.label}</label>)}</div></div><button type="button" className="content-primary social-publish" disabled={busy || lookingUp} onClick={() => void save()}>{busy ? '保存中…' : '保存平台'}</button>{form.id > 0 && <button type="button" className="social-delete-platform" disabled={busy || lookingUp} onClick={() => void remove(form)}><Trash2 size={13}/> 删除平台</button>}</>}
      </div>}
    </>}
    {error && <p className="social-error" role="alert">{error}</p>}{feedback && <p role="status">{feedback}</p>}
  </section>;
}
