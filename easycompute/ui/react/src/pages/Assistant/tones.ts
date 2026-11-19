/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import type { Tone } from '@/components/app';

/** Soft tinted circle / square per tone (theme tokens, same pair the soft badges use). */
export const SOFT: Record<Tone, string> = {
  good: 'bg-[var(--c3-style-basic-bg-success)] text-[var(--c3-style-basic-fg-success)]',
  warn: 'bg-[var(--c3-style-basic-bg-warning)] text-[var(--c3-style-basic-fg-warning)]',
  bad: 'bg-[var(--c3-style-basic-bg-danger)] text-[var(--c3-style-basic-fg-danger)]',
  info: 'bg-[var(--c3-style-basic-bg-info)] text-[var(--c3-style-basic-fg-info)]',
  accent: 'bg-[var(--c3-style-basic-bg-accent)] text-[var(--c3-style-basic-fg-accent)]',
  neutral: 'bg-[var(--c3-style-basic-bg-secondary)] text-[var(--c3-style-basic-fg-secondary)]',
  pink: 'bg-[var(--ec-pink-bg,var(--c3-style-basic-bg-secondary))] text-[var(--ec-pink)]',
};
