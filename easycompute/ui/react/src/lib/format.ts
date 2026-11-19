/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import type { BadgeAppearance } from '@/components/ui/badge';
import { readColor } from '@/lib/echarts-theme';

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compactCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export const formatCurrency = (value?: number | null): string => (value == null ? '—' : currency.format(value));

export const formatCompactCurrency = (value?: number | null): string =>
  value == null ? '—' : compactCurrency.format(value);

export const formatNumber = (value?: number | null): string => (value == null ? '—' : number.format(value));

export const formatHours = (value?: number | null): string => (value == null ? '—' : `${value.toFixed(1)} h`);

export const formatDays = (value?: number | null): string => (value == null ? '—' : `${value.toFixed(1)} d`);

export const formatPercent = (value?: number | null): string =>
  value == null ? '—' : `${Math.round(value * 100)}%`;

export const formatDate = (iso?: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const formatDateTime = (iso?: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** Compact date for table cells: `Nov 26`, with the year only when it is not the current year. */
export const formatShortDate = (iso?: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Whole days from a past date to now (0 for today or a future date). */
export const daysSince = (iso?: string | null): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? '—' : String(Math.max(0, Math.floor((Date.now() - t) / 86400000)));
};

/** `2026-06` → `Jun 2026`. */
export const formatMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/** Formats a KPI value by its declared format. */
export const formatKpi = (value: number, kind: 'number' | 'currency' | 'percent' | 'hours' | 'days'): string => {
  if (kind === 'currency') return formatCompactCurrency(value);
  if (kind === 'percent') return formatPercent(value);
  if (kind === 'hours') return formatHours(value);
  if (kind === 'days') return formatDays(value);
  return formatNumber(value);
};

/** Semantic chart color for a badge appearance (token-driven, so it follows the theme). */
const APPEARANCE_CHART_TOKEN: Record<BadgeAppearance, string> = {
  primary: '--c3-style-chart-neutral',
  secondary: '--c3-style-chart-neutral',
  accent: '--c3-style-chart-accent',
  success: '--c3-style-chart-success',
  warning: '--c3-style-chart-warning',
  danger: '--c3-style-chart-danger',
  info: '--c3-style-chart-info',
};

export const chartColor = (appearance: BadgeAppearance): string => readColor(APPEARANCE_CHART_TOKEN[appearance]);

/** Escapes a user-typed value for use inside a single-quoted C3 filter string literal. */
export const filterLiteral = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Today's date as a filter literal (`dateTime('YYYY-MM-DD')`). */
export const todayLiteral = (): string => `dateTime(${filterLiteral(new Date().toISOString().substring(0, 10))})`;
