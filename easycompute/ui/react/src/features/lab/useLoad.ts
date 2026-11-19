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
  /** Epoch ms of the last successful read (drives "updated Ns ago" and client-side ticking). */
  updatedAt: number | null;
}

/**
 * Like `useC3Data` (components/app) but the loader may return `null` while a prerequisite (the current lab) is not
 * known yet: the view stays in its loading state without calling the backend. `pollMs` (>= 5 s) refreshes in the
 * background without flipping `loading`, pauses while the tab is hidden and refreshes at once when it comes back.
 */
export function useLoad<T>(loader: () => Promise<T> | null, deps: DependencyList, pollMs?: number): Loaded<T> {
  const { reportError } = useErrorBoundary();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;
    const schedule = () => {
      if (pollMs && !cancelled) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => run(true), Math.max(5000, pollMs));
      }
    };
    const run = (background: boolean) => {
      if (background && document.hidden) {
        schedule();
        return;
      }
      const p = loader();
      if (!p || inFlight) return;
      inFlight = true;
      if (!background) {
        setLoading(true);
        setError(null);
      }
      p.then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
        setUpdatedAt(Date.now());
      })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(errorMessage(err));
          reportError(err);
        })
        .finally(() => {
          inFlight = false;
          if (cancelled) return;
          setLoading(false);
          schedule();
        });
    };
    const onVisible = () => {
      if (pollMs && !document.hidden) run(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    run(false);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key, pollMs, reportError]);

  const reload = useCallback(() => setKey((k) => k + 1), []);
  return { data, error, loading, reload, updatedAt };
}
