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
 * Fetch-on-mount with StrictMode-safe cancellation, error reporting and a `reload()`. `loader` returning
 * `null` (e.g. no lab yet) leaves the view in its loading state without calling the backend.
 */
export function useLoad<T>(loader: () => Promise<T> | null, deps: DependencyList): Loaded<T> {
  const { reportError } = useErrorBoundary();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState(0);

  useEffect(() => {
    const p = loader();
    if (!p) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    p.then((res) => {
      if (!cancelled) setData(res);
    })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err));
        reportError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key, reportError]);

  const reload = useCallback(() => setKey((k) => k + 1), []);
  return { data, error, loading, reload };
}
