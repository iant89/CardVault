import { useCallback, useEffect, useRef, useState } from 'react';

/** Minimal data loader: re-runs when deps change; exposes reload(). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => id === seq.current && (setData(d), setError(null)))
      .catch((e: Error) => id === seq.current && setError(e))
      .finally(() => id === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { data, error, loading, reload: run, setData };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
