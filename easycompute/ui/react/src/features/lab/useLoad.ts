/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import { useCallback, useEffect, useState, type DependencyList } from 'react';

import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { errorMessage } from '@/components/PageFrame/PageFrame';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Like `useC3Data` (components/app) but the loader may return `null` while a prerequisite (the current lab) is not
 * known yet: the view stays in its loading state without calling the backend. `pollMs` (>= 5 s) refreshes in the
 * background without flipping `loading`.
 */
export function useLoad<T>(loader: () => Promise<T> | null, deps: DependencyList, pollMs?: number): Loaded<T> {
  const { reportError } = useErrorBoundary();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const run = (background: boolean) => {
      const p = loader();
      if (!p) return;
      if (!background) {
        setLoading(true);
        setError(null);
      }
      p.then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
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
  }, [...deps, key, pollMs, reportError]);

  const reload = useCallback(() => setKey((k) => k + 1), []);
  return { data, error, loading, reload };
}
