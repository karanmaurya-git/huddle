import { useCallback, useEffect, useRef, useState } from 'react';

let nextId = 1;

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (text, kind = 'info') => {
      const id = nextId++;
      setToasts((list) => [...list.slice(-3), { id, text, kind }]);
      timers.current.set(id, setTimeout(() => dismiss(id), 4500));
    },
    [dismiss]
  );

  useEffect(() => {
    const active = timers.current;
    return () => active.forEach((t) => clearTimeout(t));
  }, []);

  return { toasts, push, dismiss };
}
