import { useI18n } from './i18n';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { agentPickerKeyAction } from './agentPickerKeys';

type Option = { id: string; name: string; installed: boolean };
type Props = { value: string; options: Option[]; disabled: boolean; onChange: (id: string) => void };

export default function AgentPicker({ value, options, disabled, onChange }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listId = useId();
  const chosen = options.find(option => option.id === value);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  };
  const show = () => { if (!disabled) { setActive(value); setOpen(true); } };
  const select = (id: string) => { close(true); if (id !== value) onChange(id); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !menu.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const popup = menu.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - popup.width - 8));
      const above = anchor.top - popup.height - 6;
      const top = above >= 8 ? above : Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - popup.height - 8));
      setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const onMenuKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const action = agentPickerKeyAction(event.key, options.findIndex(option => option.id === active), options.length);
    if (!action) return;
    event.preventDefault();
    if (action.kind === 'close') close(true);
    else if (action.kind === 'select') select(options[action.index].id);
    else setActive(options[action.index].id);
  };
  return <div className="agent-select agent-picker">
    <button ref={trigger} type="button" className="agent-picker-trigger" role="combobox" aria-label={t("选择 Agent，当前为 {0}", chosen?.name || value)} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${active}` : undefined} disabled={disabled} onClick={() => open ? close() : show()} onKeyDown={event => { if (open && event.key === 'Tab') { close(); return; } if (open) onMenuKey(event); else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } }}><span>{chosen?.name || value}</span><ChevronDown size={14} aria-hidden="true"/></button>
    {open && createPortal(<div id={listId} ref={menu} className="agent-picker-menu" role="listbox" aria-label={t("选择 Agent")} style={position}>{options.map(option => <div key={option.id} id={`${listId}-${option.id}`} className={`agent-picker-option${option.id === active ? ' is-active' : ''}`} role="option" aria-selected={option.id === value} onMouseMove={() => setActive(option.id)} onMouseDown={event => event.preventDefault()} onClick={() => select(option.id)}><span>{option.name}</span>{!option.installed && <small>{t("未检测到")}</small>}{option.id === value && <Check size={15} aria-hidden="true"/>}</div>)}</div>, document.body)}
  </div>;
}
