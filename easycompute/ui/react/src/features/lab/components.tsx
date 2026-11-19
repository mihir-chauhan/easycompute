/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { type ReactNode } from 'react';
import { Inbox } from 'lucide-react';

import { EnumBadge } from '@/components/StatusBadges/StatusBadges';
import type { BadgeAppearance } from '@/components/ui/badge';
import { MetricCard, MetricCardCaption, MetricCardHeader, MetricCardLabel, MetricCardValue } from '@/components/ui/metric-card';
import { cn } from '@/lib/utils';

import {
  ACTOR_APPEARANCE,
  ALERT_SEVERITY_APPEARANCE,
  ALERT_TYPE_LABEL,
  CHECK_OUTCOME_APPEARANCE,
  JOB_STATE_APPEARANCE,
  JOB_STATE_LABEL,
  labelOf,
  titleCase,
  RULE_SEVERITY_APPEARANCE,
} from './format';
import type { Actor, AlertSeverity, AlertType, CheckOutcome, JobState, RuleSeverity } from './types';

/* ---------- Badges (one soft style; colours from the *_APPEARANCE maps) ---------- */

export const JobStateBadge = ({ value }: { value?: JobState }) => (
  <EnumBadge value={value ? JOB_STATE_LABEL[value] : undefined} appearance={value ? JOB_STATE_APPEARANCE[value] : undefined} />
);

export const AlertSeverityBadge = ({ value }: { value?: AlertSeverity }) => (
  <EnumBadge value={value ? titleCase(value) : undefined} appearance={value ? ALERT_SEVERITY_APPEARANCE[value] : undefined} />
);

export const AlertTypeBadge = ({ type, severity }: { type: AlertType; severity: AlertSeverity }) => (
  <EnumBadge value={labelOf(ALERT_TYPE_LABEL, type)} appearance={ALERT_SEVERITY_APPEARANCE[severity]} />
);

export const CheckOutcomeBadge = ({ value }: { value: CheckOutcome }) => (
  <EnumBadge value={value} appearance={CHECK_OUTCOME_APPEARANCE[value]} />
);

export const RuleSeverityBadge = ({ value }: { value?: RuleSeverity }) => (
  <EnumBadge value={value} appearance={value ? RULE_SEVERITY_APPEARANCE[value] : undefined} />
);

export const ActorBadge = ({ value }: { value: Actor }) => (
  <EnumBadge value={titleCase(value)} appearance={ACTOR_APPEARANCE[value]} />
);

/* ---------- KPI tile ---------- */

const TONE_TEXT: Record<'danger' | 'warning' | 'success', string> = {
  danger: 'text-[var(--c3-style-basic-fg-danger)]',
  warning: 'text-[var(--c3-style-basic-fg-warning)]',
  success: 'text-[var(--c3-style-basic-fg-success)]',
};

export function Kpi({
  label,
  value,
  caption,
  tone,
  onClick,
  children,
}: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  tone?: 'danger' | 'warning' | 'success';
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <MetricCard
      interactive={Boolean(onClick)}
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      role={onClick ? 'link' : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) onClick();
      }}
    >
      <MetricCardHeader>
        <MetricCardLabel>{label}</MetricCardLabel>
      </MetricCardHeader>
      <MetricCardValue className={tone ? TONE_TEXT[tone] : undefined}>{value}</MetricCardValue>
      {children}
      {caption && <MetricCardCaption>{caption}</MetricCardCaption>}
    </MetricCard>
  );
}

/* ---------- Small visual primitives ---------- */

const STROKE: Record<BadgeAppearance, string> = {
  primary: 'stroke-[var(--c3-style-chart-neutral)]',
  secondary: 'stroke-[var(--c3-style-chart-neutral)]',
  accent: 'stroke-[var(--c3-style-chart-accent)]',
  success: 'stroke-[var(--c3-style-chart-success)]',
  warning: 'stroke-[var(--c3-style-chart-warning)]',
  danger: 'stroke-[var(--c3-style-chart-danger)]',
  info: 'stroke-[var(--c3-style-chart-info)]',
};

/** Tiny SVG line for table cells (0-100 scale). */
export function Sparkline({
  values,
  appearance = 'accent',
  width = 96,
  height = 24,
  max = 100,
  label,
}: {
  values: number[];
  appearance?: BadgeAppearance;
  width?: number;
  height?: number;
  max?: number;
  label: string;
}) {
  if (values.length < 2) return <span className="text-[var(--c3-style-basic-fg-secondary)]">—</span>;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (Math.min(max, Math.max(0, v)) / max) * (height - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="block">
      <line x1={0} x2={width} y1={height - 2} y2={height - 2} className="stroke-[var(--c3-style-basic-border-primary)]" strokeWidth={1} />
      <polyline points={points} fill="none" strokeWidth={1.5} strokeLinejoin="round" className={STROKE[appearance]} />
    </svg>
  );
}

const FILL: Record<BadgeAppearance, string> = {
  primary: 'fill-[var(--c3-style-chart-neutral)]',
  secondary: 'fill-[var(--c3-style-chart-neutral)]',
  accent: 'fill-[var(--c3-style-chart-accent)]',
  success: 'fill-[var(--c3-style-chart-success)]',
  warning: 'fill-[var(--c3-style-chart-warning)]',
  danger: 'fill-[var(--c3-style-chart-danger)]',
  info: 'fill-[var(--c3-style-chart-info)]',
};

/** Thin horizontal meter; `value` and `marker` are fractions 0-1. */
export function Meter({
  value,
  appearance = 'accent',
  marker,
  label,
  className,
}: {
  value: number;
  appearance?: BadgeAppearance;
  marker?: number;
  label: string;
  className?: string;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--c3-style-basic-bg-secondary)]', className)}
    >
      <svg className="absolute inset-0 size-full" preserveAspectRatio="none" viewBox="0 0 100 1" aria-hidden>
        <rect x={0} y={0} width={pct} height={1} className={FILL[appearance]} />
        {marker != null && (
          <rect x={Math.min(99.5, Math.max(0, marker * 100))} y={0} width={0.6} height={1} className="fill-[var(--c3-style-basic-fg-primary)]" />
        )}
      </svg>
    </div>
  );
}

export const utilAppearance = (util?: number | null): BadgeAppearance =>
  util == null ? 'secondary' : util < 15 ? 'danger' : util < 40 ? 'warning' : 'success';

/** Muted empty block for cards (not table bodies). */
export function EmptyBlock({ label, action, icon }: { label: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-secondary)]">
      {icon ?? <Inbox className="size-6" aria-hidden />}
      <span>{label}</span>
      {action}
    </div>
  );
}

/** Label/value stat used inside cards (plan cards, run header). */
export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className="text-c3-regular-label-l3 text-[var(--c3-style-basic-fg-secondary)]">{label}</span>
      <span className="truncate text-c3-bold-body-p1 tabular-nums text-[var(--c3-style-basic-fg-primary)]">{value}</span>
      {sub && <span className="truncate text-xs text-[var(--c3-style-basic-fg-secondary)]">{sub}</span>}
    </div>
  );
}

export const muted = 'text-[var(--c3-style-basic-fg-secondary)]';
