/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import { useEffect, useState } from 'react';

import { useAppShell } from '@/components/app';

import { fetchLabs } from './api';
import type { Lab } from './types';

/**
 * The demo "logged-in" lab. The global header's lab switcher writes `localStorage['easycompute.labId']` and
 * dispatches `easycompute:lab-changed` (see {@link setCurrentLabId}); every lab page re-reads on that event.
 */
export const LAB_STORAGE_KEY = 'easycompute.labId';
export const LAB_CHANGED_EVENT = 'easycompute:lab-changed';

const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(LAB_STORAGE_KEY);
  } catch {
    return null;
  }
};

export function setCurrentLabId(labId: string) {
  try {
    window.localStorage.setItem(LAB_STORAGE_KEY, labId);
  } catch {
    /* storage unavailable (private mode): the event still switches the open pages */
  }
  window.dispatchEvent(new CustomEvent(LAB_CHANGED_EVENT, { detail: labId }));
}

let labsCache: Promise<Lab[]> | null = null;

/** Resolves the current lab: the stored id when it exists, otherwise the first lab by name. */
export function useCurrentLab(): { lab: Lab | null; labId: string | null; error: string | null } {
  const shellLabId = useAppShell().labId;
  const [storedId, setLabId] = useState<string | null>(readStored);
  const labId = shellLabId ?? storedId;
  const [labs, setLabs] = useState<Lab[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onChange = (e: Event) => setLabId((e as CustomEvent<string>).detail ?? readStored());
    const onStorage = (e: StorageEvent) => {
      if (e.key === LAB_STORAGE_KEY) setLabId(e.newValue);
    };
    window.addEventListener(LAB_CHANGED_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(LAB_CHANGED_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    labsCache ??= fetchLabs();
    labsCache
      .then((rows) => {
        if (!cancelled) setLabs(rows);
      })
      .catch((err: unknown) => {
        labsCache = null;
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load labs');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const lab = labs ? (labs.find((l) => l.id === labId) ?? labs[0] ?? null) : null;
  return { lab, labId: lab?.id ?? null, error: labs && labs.length === 0 ? 'No labs found.' : error };
}
