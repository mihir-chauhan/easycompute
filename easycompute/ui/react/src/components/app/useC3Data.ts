/*
 * EasyCompute design system — useC3Data: one async loader per view with loading / error / reload,
 * StrictMode-safe cancellation, optional polling (>= 5 s) and reportError wiring.
 */

import { useCallback, useEffect, useState, type DependencyList } from 'react';

import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { errorMessage } from '@/components/PageFrame/PageFrame';

export interface C3Data<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * `const { data, loading, error, reload } = useC3Data(() => c3Call('Insights', 'universityOverview', null, []), []);`
 * `pollMs` re-runs the loader in the background (minimum 5000 ms, per preview-safety rules).
 */
export function useC3Data<T>(loader: () => Promise<T>, deps: DependencyList, pollMs?: number): C3Data<T> {
  const { reportError } = useErrorBoundary();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const reload = useCallback(() => setKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const run = (background: boolean) => {
      if (!background) {
        setLoading(true);
        setError(null);
      }
      loader()
        .then((res) => {
          if (!cancelled) {
            setData(res);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(errorMessage(err));
          reportError(err);
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
          if (pollMs) timer = window.setTimeout(() => run(true), Math.max(5000, pollMs));
        });
    };
    run(false);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key, pollMs]);

  return { data, loading, error, reload };
}
