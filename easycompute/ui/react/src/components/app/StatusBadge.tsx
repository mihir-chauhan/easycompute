/*
 * EasyCompute design system — status and severity badges. One soft badge style for every enum.
 */

import React from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { TONE_APPEARANCE, TONE_BG, type Tone } from './tone';

/** Enum value -> [tone, label] per SPEC enum. Unknown values render neutral with a humanised label. */
export const STATUS_MAPS = {
  jobState: {
    PENDING: ['info', 'Pending'],
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
    BLOCK: ['bad', 'Block'],
    WARN: ['warn', 'Warn'],
    INFO: ['info', 'Info'],
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
    ADMIN: ['info', 'Admin'],
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

interface StatusBadgeProps {
  kind: StatusKind;
  value?: string | null;
  /** Show a leading dot (default true for job/cluster states, false otherwise). */
  dot?: boolean;
  className?: string;
}

/** Soft badge for any SPEC enum value: `<StatusBadge kind="jobState" value={job.state} />`. */
export function StatusBadge({ kind, value, dot, className }: StatusBadgeProps) {
  if (!value) return <span className="text-[var(--c3-style-basic-fg-secondary)]">—</span>;
  const { tone, label } = statusOf(kind, value);
  const showDot = dot ?? (kind === 'jobState' || kind === 'clusterStatus');
  return (
    <Badge
      variant="soft"
      appearance={TONE_APPEARANCE[tone]}
      size="sm"
      shape="rounded"
      className={cn('whitespace-nowrap', className)}
      leadingIcon={showDot ? <span className={cn('inline-block size-1.5 rounded-full', TONE_BG[tone])} /> : undefined}
    >
      {label}
    </Badge>
  );
}

/** Severity badge for alerts (CRITICAL/WARNING/INFO) and rules (BLOCK/WARN/INFO). */
export function SeverityBadge({ value, className }: { value?: string | null; className?: string }) {
  const kind: StatusKind = value === 'BLOCK' || value === 'WARN' ? 'ruleSeverity' : 'alertSeverity';
  return <StatusBadge kind={kind} value={value} className={className} />;
}

/** A plain tone badge with arbitrary text (e.g. "3 alerts", "Over budget"). */
export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="soft" appearance={TONE_APPEARANCE[tone]} size="sm" shape="rounded" className={cn('whitespace-nowrap', className)}>
      {children}
    </Badge>
  );
}

/** Small coloured dot + label, for legends and inline status text. */
export function ToneDot({ tone, label, className }: { tone: Tone; label?: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', TONE_BG[tone])} />
      {label}
    </span>
  );
}
