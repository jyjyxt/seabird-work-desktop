import { useCallback, useEffect, useRef, useState } from 'react';

export function useTransientMessage() {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const showMessage = useCallback((value: string) => {
    clearTimeout(timer.current);
    setMessage(value);
    if (value) timer.current = setTimeout(() => setMessage(''), 15_000);
  }, []);

  return [message, showMessage] as const;
}
