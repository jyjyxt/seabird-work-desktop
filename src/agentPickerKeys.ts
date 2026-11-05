type PickerKeyAction = { kind: 'highlight' | 'select'; index: number } | { kind: 'close' } | null;

export function agentPickerKeyAction(key: string, activeIndex: number, count: number): PickerKeyAction {
  if (key === 'Escape') return { kind: 'close' };
  if (count < 1) return null;
  const index = activeIndex >= 0 && activeIndex < count ? activeIndex : 0;
  if (key === 'ArrowDown') return { kind: 'highlight', index: (index + 1) % count };
  if (key === 'ArrowUp') return { kind: 'highlight', index: (index + count - 1) % count };
  if (key === 'Home') return { kind: 'highlight', index: 0 };
  if (key === 'End') return { kind: 'highlight', index: count - 1 };
  if (key === 'Enter' || key === ' ') return { kind: 'select', index };
  return null;
}
