/*
 * EasyCompute design system — status and severity pills (the mockups' ".st" badge). One style for every enum.
 */

import React from 'react';

import { cn } from '@/lib/utils';

import { TONE_BG, TONE_PILL, type Tone } from './tone';

/** Enum value -> [tone, label] per SPEC enum. Unknown values render neutral with a humanised label. */
export const STATUS_MAPS = {
  jobState: {
    PENDING: ['info', 'Queued'],
    RUNNING: ['accent', 'Running'],
    COMPLETED: ['good', 'Completed'],
    FAILED: ['bad', 'Failed'],
    TIMEOUT: ['bad', 'Timed out'],
    CANCELLED: ['neutral', 'Cancelled'],
    OUT_OF_MEMORY: ['bad', 'Out of memory'],
    PREEMPTED: ['warn', 'Preempted'],
  },
  alertSeverity: {
    CRITICAL: ['bad', 'Critical'],
    WARNING: ['warn', 'Warning'],
    INFO: ['info', 'Info'],
  },
  alertStatus: {
    OPEN: ['bad', 'Open'],
    ACKED: ['warn', 'Acknowledged'],
    RESOLVED: ['good', 'Resolved'],
    AUTO_RESOLVED: ['good', 'Auto-resolved'],
  },
  ruleSeverity: {
    BLOCK: ['bad', 'Hard block'],
    WARN: ['warn', 'Warn'],
    INFO: ['neutral', 'Advisory'],
  },
  ruleScope: {
    UNIVERSITY: ['accent', 'University'],
    CLUSTER: ['info', 'Cluster'],
    PARTITION: ['neutral', 'Partition'],
    LAB: ['neutral', 'Lab'],
  },
  checkOutcome: {
    PASS: ['good', 'Pass'],
    WARN: ['warn', 'Warning'],
    FAIL: ['bad', 'Fail'],
  },
  runRequestStatus: {
    DRAFT: ['neutral', 'Draft'],
    CHECKED: ['info', 'Checked'],
    PLANNED: ['accent', 'Planned'],
    SUBMITTED: ['good', 'Submitted'],
    REJECTED: ['bad', 'Rejected'],
  },
  clusterStatus: {
    ONLINE: ['good', 'Online'],
    DEGRADED: ['warn', 'Degraded'],
    MAINTENANCE: ['neutral', 'Maintenance'],
  },
  actionOutcome: {
    DONE: ['good', 'Done'],
    FAILED: ['bad', 'Failed'],
    PENDING_APPROVAL: ['warn', 'Needs approval'],
  },
  actor: {
    USER: ['neutral', 'User'],
    AUTOPILOT: ['accent', 'Autopilot'],
    ADMIN: ['pink', 'Admin'],
  },
} as const satisfies Record<string, Record<string, readonly [Tone, string]>>;

export type StatusKind = keyof typeof STATUS_MAPS;

/** "OUT_OF_MEMORY" -> "Out of memory". */
export const humanize = (value: string): string => {
  const s = value.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Tone + label for an enum value of a kind. */
export function statusOf(kind: StatusKind, value?: string | null): { tone: Tone; label: string } {
  if (!value) return { tone: 'neutral', label: '—' };
  const map = STATUS_MAPS[kind] as Record<string, readonly [Tone, string]>;
  const hit = map[value];
  return hit ? { tone: hit[0], label: hit[1] } : { tone: 'neutral', label: humanize(value) };
}

interface PillProps {
  tone: Tone;
  children: React.ReactNode;
  /** Leading dot (pulsing for live/running states when `pulse`). */
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  title?: string;
}

/** The mockups' pill badge (".st"): 12px/500, 20px tall, fully rounded, tinted background. */
export function Pill({ tone, children, dot, pulse, className, title }: PillProps) {
  return (
    <span
      title={title}
      className={cn('inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-xs leading-5 font-medium whitespace-nowrap', TONE_PILL[tone], className)}
    >
      {dot ? <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', TONE_BG[tone], pulse && 'ec-pulse')} /> : null}
      {children}
    </span>
  );
}

interface StatusBadgeProps {
  kind: StatusKind;
  value?: string | null;
  /** Show a leading dot (default: only for running jobs). */
  dot?: boolean;
  className?: string;
}

/** Pill for any SPEC enum value: `<StatusBadge kind="jobState" value={job.state} />`. */
export function StatusBadge({ kind, value, dot, className }: StatusBadgeProps) {
  if (!value) return <span className="text-[var(--ec-fg-3)]">—</span>;
  const { tone, label } = statusOf(kind, value);
  const running = kind === 'jobState' && value === 'RUNNING';
  return (
    <Pill tone={tone} dot={dot ?? (running || kind === 'clusterStatus')} pulse={running} className={className}>
      {label}
    </Pill>
  );
}

/** Severity pill for alerts (CRITICAL/WARNING/INFO) and rules (BLOCK/WARN/INFO -> Hard block/Warn/Advisory). */
export function SeverityBadge({ value, className }: { value?: string | null; className?: string }) {
  const kind: StatusKind = value === 'BLOCK' || value === 'WARN' ? 'ruleSeverity' : 'alertSeverity';
  return <StatusBadge kind={kind} value={value} className={className} />;
}

/** A tone pill with arbitrary text ("Auto-fixed", "Recommended", "3 open", "Budget risk"). */
export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Pill tone={tone} className={className}>
      {children}
    </Pill>
  );
}

/** Small coloured dot + label, for legends and inline status text. */
export function ToneDot({ tone, label, className, pulse }: { tone: Tone; label?: React.ReactNode; className?: string; pulse?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span aria-hidden className={cn('inline-block size-[7px] shrink-0 rounded-full', TONE_BG[tone], pulse && 'ec-pulse')} />
      {label}
    </span>
  );
}
