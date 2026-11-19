/*
 * EasyCompute design system — colour by MEANING.
 * Pages never pick hex colours: they pick a Tone (good / warn / bad / neutral / info / accent) or a cluster/billing
 * id, and these helpers resolve it to a badge appearance, a CSS var (for Tailwind arbitrary classes) or a resolved
 * colour string (for eCharts, which paints on canvas and cannot read CSS vars).
 */

import type { BadgeAppearance } from '@/components/ui/badge';
import { readColor } from '@/lib/echarts-theme';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info' | 'accent';

/** CSS custom property per tone (defined light + dark in styles/manual-tokens.css). */
export const TONE_VAR: Record<Tone, string> = {
  good: '--ec-good',
  warn: '--ec-warn',
  bad: '--ec-bad',
  neutral: '--ec-neutral',
  info: '--ec-cluster-anvil',
  accent: '--ec-accent',
};

/** Soft badge appearance per tone (one badge style everywhere). */
export const TONE_APPEARANCE: Record<Tone, BadgeAppearance> = {
  good: 'success',
  warn: 'warning',
  bad: 'danger',
  neutral: 'secondary',
  info: 'info',
  accent: 'accent',
};

/** Text colour class per tone, for inline numbers (e.g. a red "Overdue" or a green "+12%"). */
export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-[var(--c3-style-basic-fg-success)]',
  warn: 'text-[var(--c3-style-basic-fg-warning)]',
  bad: 'text-[var(--c3-style-basic-fg-danger)]',
  neutral: 'text-[var(--c3-style-basic-fg-secondary)]',
  info: 'text-[var(--c3-style-basic-fg-info)]',
  accent: 'text-[var(--c3-style-basic-fg-accent)]',
};

/** Fill/background classes per tone (dots, bars). Literal strings so Tailwind generates them. */
export const TONE_BG: Record<Tone, string> = {
  good: 'bg-[var(--ec-good)]',
  warn: 'bg-[var(--ec-warn)]',
  bad: 'bg-[var(--ec-bad)]',
  neutral: 'bg-[var(--ec-neutral)]',
  info: 'bg-[var(--ec-cluster-anvil)]',
  accent: 'bg-[var(--ec-accent)]',
};
export const TONE_FILL: Record<Tone, string> = {
  good: 'fill-[var(--ec-good)]',
  warn: 'fill-[var(--ec-warn)]',
  bad: 'fill-[var(--ec-bad)]',
  neutral: 'fill-[var(--ec-neutral)]',
  info: 'fill-[var(--ec-cluster-anvil)]',
  accent: 'fill-[var(--ec-accent)]',
};
export const TONE_STROKE: Record<Tone, string> = {
  good: 'stroke-[var(--ec-good)]',
  warn: 'stroke-[var(--ec-warn)]',
  bad: 'stroke-[var(--ec-bad)]',
  neutral: 'stroke-[var(--ec-neutral)]',
  info: 'stroke-[var(--ec-cluster-anvil)]',
  accent: 'stroke-[var(--ec-accent)]',
};

/** Resolved colour for a tone (eCharts). Call inside render/useMemo so it follows the theme. */
export const toneColor = (tone: Tone): string => readColor(TONE_VAR[tone]);

/** Resolved colour for any `--ec-*` var. */
export const ecColor = (cssVar: string): string => readColor(cssVar);

/* ---------------------------------------------- clusters & billing ---------------------------------------------- */

export const CLUSTER_IDS = ['anvil', 'gilbreth', 'gautschi', 'negishi', 'bell', 'aws-p4d'] as const;

/** CSS var for a cluster's identity colour; unknown clusters fall back to the neutral ink. */
export const clusterVar = (clusterId?: string | null): string =>
  clusterId && (CLUSTER_IDS as readonly string[]).includes(clusterId) ? `--ec-cluster-${clusterId}` : '--ec-ink';

/** Resolved cluster colour (eCharts). */
export const clusterColor = (clusterId?: string | null): string => readColor(clusterVar(clusterId));

/** Background class for a cluster dot (literal strings for Tailwind). */
export const CLUSTER_BG: Record<string, string> = {
  anvil: 'bg-[var(--ec-cluster-anvil)]',
  gilbreth: 'bg-[var(--ec-cluster-gilbreth)]',
  gautschi: 'bg-[var(--ec-cluster-gautschi)]',
  negishi: 'bg-[var(--ec-cluster-negishi)]',
  bell: 'bg-[var(--ec-cluster-bell)]',
  'aws-p4d': 'bg-[var(--ec-cluster-aws-p4d)]',
};

export type Billing = 'IN_HOUSE_NODE_SHARE' | 'ACCESS_SU' | 'THIRD_PARTY_HOURLY';

export const BILLING_LABEL: Record<Billing, string> = {
  IN_HOUSE_NODE_SHARE: 'In-house node shares',
  ACCESS_SU: 'NSF ACCESS SUs',
  THIRD_PARTY_HOURLY: 'Third-party cloud',
};
export const BILLING_SHORT: Record<Billing, string> = {
  IN_HOUSE_NODE_SHARE: 'In-house',
  ACCESS_SU: 'ACCESS',
  THIRD_PARTY_HOURLY: 'Third-party',
};
export const BILLING_VAR: Record<Billing, string> = {
  IN_HOUSE_NODE_SHARE: '--ec-billing-in-house',
  ACCESS_SU: '--ec-billing-access',
  THIRD_PARTY_HOURLY: '--ec-billing-third-party',
};
export const BILLING_BG: Record<Billing, string> = {
  IN_HOUSE_NODE_SHARE: 'bg-[var(--ec-billing-in-house)]',
  ACCESS_SU: 'bg-[var(--ec-billing-access)]',
  THIRD_PARTY_HOURLY: 'bg-[var(--ec-billing-third-party)]',
};
export const billingColor = (billing: Billing): string => readColor(BILLING_VAR[billing]);

/* ------------------------------------------------ thresholds ------------------------------------------------ */

/** GPU/CPU utilisation (0-100): >=70 good, 40-70 warn, <40 bad. */
export const utilTone = (pct?: number | null): Tone =>
  pct == null ? 'neutral' : pct >= 70 ? 'good' : pct >= 40 ? 'warn' : 'bad';

/** Efficiency fraction (0-1): same bands as utilisation. */
export const efficiencyTone = (frac?: number | null): Tone => utilTone(frac == null ? null : frac * 100);

/**
 * Allocation burn: compares the share of budget used with the share of the allocation period elapsed.
 * Burning faster than time (used > elapsed + 10pts) is warn, >25pts or >95% used is bad.
 */
export const burnTone = (usedFrac: number, elapsedFrac?: number | null): Tone => {
  if (usedFrac >= 0.95) return 'bad';
  if (elapsedFrac == null) return usedFrac >= 0.8 ? 'warn' : 'good';
  const ahead = usedFrac - elapsedFrac;
  if (ahead > 0.25) return 'bad';
  if (ahead > 0.1) return 'warn';
  return 'good';
};
