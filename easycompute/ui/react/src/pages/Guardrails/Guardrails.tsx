/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Bot, ShieldCheck, User } from 'lucide-react';

import { EmptyState, ErrorState, KpiRow, KpiRowSkeleton, KpiTile, PageFrame, SectionCard, TableSkeleton, ToneBadge, errorMessage } from '@/components/app';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { fetchLabActions, getAutopilot, saveAutopilot } from '@/features/lab/api';
import { ActivityRow, HeadNote, Mono, muted } from '@/features/lab/components';
import { ACTION_LABEL, formatInt, formatShortDateTime } from '@/features/lab/format';
import type { AutopilotPolicy } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLoad } from '@/features/lab/useLoad';
import { cn } from '@/lib/utils';

type BoolField = 'autoExtendWalltime' | 'requeueToStandbyOnLowPriority' | 'notifyPiOnCritical';
type NumField = 'cancelIdleAfterMin' | 'checkpointBeforeTimeoutMin' | 'budgetAlertPct';

interface Rail {
  key: string;
  name: string;
  signal: string;
  trigger: (p: AutopilotPolicy, num: (f: NumField, unit: string, scale?: number) => React.ReactNode) => React.ReactNode;
  does: (p: AutopilotPolicy) => string;
  /** Autopilot field that switches the automatic part on/off; absent = detection always on. */
  toggle?: BoolField;
}

/** Health rules evaluated on every live run (API.md, Job.evaluateHealth) and what Autopilot does about each. */
const RAILS: Rail[] = [
  {
    key: 'idle',
    name: 'Idle GPU',
    signal: 'DCGM SM_ACTIVE · CPU busy',
    trigger: (_p, num) => <>util &lt; 5% for 30 min · cancel at {num('cancelIdleAfterMin', 'min')}</>,
    does: (p) => `Warn the owner. At ${p.cancelIdleAfterMin ?? 60} min idle, cancel the job and release the GPUs.`,
  },
  {
    key: 'low',
    name: 'Low GPU utilization',
    signal: 'Window mean SM_ACTIVE',
    trigger: () => 'mean util 5-35% over 45 min',
    does: (p) => `Suggest scaling down to fewer GPUs${p.requeueToStandbyOnLowPriority ? '; requeue priority-3 work to standby automatically' : ''}.`,
    toggle: 'requeueToStandbyOnLowPriority',
  },
  {
    key: 'wall',
    name: 'Walltime running out',
    signal: 'Slurm TimeLimit · predicted runtime',
    trigger: (_p, num) => <>ETA &gt; walltime left · checkpoint {num('checkpointBeforeTimeoutMin', 'min')} before</>,
    does: (p) => `Send USR1 to checkpoint before the limit${p.autoExtendWalltime ? ', then ask RCAC to extend the walltime' : ', then chain a continuation job'}.`,
    toggle: 'autoExtendWalltime',
  },
  { key: 'oom', name: 'Out of memory', signal: 'FB_USED · host RSS', trigger: () => 'GPU mem ≥ 95%, or ≥ 88% and rising', does: () => 'Checkpoint now and warn the owner before the crash.' },
  { key: 'hung', name: 'Hung job', signal: 'GPU, CPU, I/O, loss', trigger: () => 'util < 2%, no I/O, loss flat for 30 min', does: () => 'Raise a critical alert and offer to cancel.' },
  { key: 'node', name: 'Node failure', signal: 'Power draw · Slurm NODE_FAIL', trigger: () => '0 W and 0% after activity', does: () => 'Requeue from the last checkpoint on a healthy node.' },
  { key: 'preempt', name: 'Preemption risk', signal: 'QOS · checkpoint age', trigger: () => 'preemptible and checkpoint > 30 min', does: () => 'Send USR1 so a preemption loses under 10 minutes of work.' },
  { key: 'ckpt', name: 'Checkpoint health', signal: 'Checkpoint age', trigger: () => 'checkpoint age > 120 min', does: () => 'Checkpoint now; critical after 4 hours.' },
  {
    key: 'budget',
    name: 'Over budget',
    signal: 'Allocation used + job remaining cost',
    trigger: (_p, num) => <>projected use ≥ {num('budgetAlertPct', '%', 100)}</>,
    does: () => 'Notify the PI and offer a cheaper QOS.',
  },
  {
    key: 'escalate',
    name: 'Escalate critical alerts',
    signal: 'Any new CRITICAL alert',
    trigger: () => 'severity = CRITICAL',
    does: (p) => (p.notifyPiOnCritical ? 'Email the PI with the alert and the suggested fix.' : 'Notify the run owner only.'),
    toggle: 'notifyPiOnCritical',
  },
];

const SIGNALS: [string, string[]][] = [
  ['GPU (DCGM)', ['SM active', 'Memory used', 'Power', 'Xid errors']],
  ['Scheduler (Slurm)', ['Job state', 'Walltime left', 'Queue position', 'Preemption', 'Charged units']],
  ['Host', ['CPU util', 'RAM', 'Scratch I/O']],
  ['Training', ['Loss', 'Checkpoint age']],
];

const Guardrails: React.FC = () => {
  const { reportError } = useErrorBoundary();
  const { labId, error: labError } = useCurrentLab();
  const ap = useLoad(() => (labId ? getAutopilot(labId) : null), [labId]);
  const acts = useLoad(() => (labId ? fetchLabActions(labId, 200) : null), [labId], 30000);
  const [draft, setDraft] = useState<AutopilotPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!labId || ap.loading) return;
    setDraft(ap.data ?? { id: labId, lab: { id: labId }, enabled: false, cancelIdleAfterMin: 60, checkpointBeforeTimeoutMin: 30, budgetAlertPct: 0.8 });
  }, [ap.data, ap.loading, labId]);

  const persist = async (next: AutopilotPolicy) => {
    setDraft(next);
    setSaving(true);
    setErr(null);
    try {
      await saveAutopilot(next);
    } catch (e) {
      setErr(errorMessage(e));
      reportError(e);
    } finally {
      setSaving(false);
    }
  };

  const log = useMemo(() => (acts.data ?? []).filter((a) => a.actionType !== 'SUBMIT'), [acts.data]);
  const auto = log.filter((a) => a.actor === 'AUTOPILOT');
  const checkpoints = log.filter((a) => a.actionType === 'CHECKPOINT_NOW' && a.outcome === 'DONE').length;
  const released = log.filter((a) => (a.actionType === 'CANCEL' || a.actionType === 'SCALE_DOWN') && a.outcome === 'DONE').length;
  const pendingApproval = log.filter((a) => a.outcome === 'PENDING_APPROVAL').length;

  const num = (f: NumField, unit: string, scale = 1) =>
    draft ? (
      <span className="inline-flex items-center gap-1 align-middle">
        <Input
          size="sm"
          type="number"
          aria-label={f}
          className="w-16"
          disabled={!draft.enabled}
          value={draft[f] != null ? Math.round((draft[f] as number) * scale) : ''}
          onChange={(e) => setDraft({ ...draft, [f]: Number(e.target.value) / scale })}
          onBlur={() => persist(draft)}
        />
        {unit}
      </span>
    ) : null;

  const error = labError ?? ap.error;

  return (
    <PageFrame
      title="Guardrails"
      description="What EasyCompute watches during every run, and what it does on its own when something goes wrong."
      actions={
        draft ? (
          <label htmlFor="ap-enabled" className="flex items-center gap-3 rounded-md border border-[var(--c3-style-basic-border-border)] px-3 py-1.5 text-sm">
            <span className="font-medium text-[var(--c3-style-basic-fg-primary)]">{draft.enabled ? 'Acting automatically' : 'Alert only'}</span>
            <Switch id="ap-enabled" checked={Boolean(draft.enabled)} onCheckedChange={(v) => persist({ ...draft, enabled: v })} />
          </label>
        ) : undefined
      }
    >
      {error && <ErrorState message={`Could not load guardrails: ${error}`} onRetry={ap.reload} />}
      {err && <ErrorState message={err} />}

      {acts.loading && !acts.data ? (
        <KpiRowSkeleton />
      ) : (
        <KpiRow>
          <KpiTile label="Actions taken" value={formatInt(log.length)} caption={`${formatInt(auto.length)} automatic · ${formatInt(log.length - auto.length)} by people`} />
          <KpiTile label="Checkpoints forced" value={formatInt(checkpoints)} caption="Before walltime, preemption or OOM" tone="good" />
          <KpiTile label="GPU jobs released or scaled" value={formatInt(released)} caption="Idle or oversized GPUs given back" />
          <KpiTile label="Waiting for approval" value={formatInt(pendingApproval)} tone={pendingApproval ? 'warn' : undefined} caption="Walltime extensions need RCAC" />
        </KpiRow>
      )}

      <SectionCard
        flush
        title="Rules"
        actions={<HeadNote>{saving ? 'Saving…' : draft?.enabled ? 'Applies to all live runs of this lab' : 'Autopilot off: alerts only'}</HeadNote>}
      >
        {!draft ? (
          <TableSkeleton rows={6} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className={cn('text-left text-xs', muted)}>
                  <th className="w-14 px-5 py-2.5 font-medium">On</th>
                  <th className="px-3 py-2.5 font-medium">Guardrail</th>
                  <th className="px-3 py-2.5 font-medium">Trigger</th>
                  <th className="px-3 py-2.5 font-medium">EasyCompute does</th>
                </tr>
              </thead>
              <tbody>
                {RAILS.map((r) => {
                  const on = r.toggle ? Boolean(draft[r.toggle]) : true;
                  return (
                    <tr key={r.key} className="border-t border-[var(--c3-style-basic-border-border)]">
                      <td className="px-5 py-3 align-middle">
                        <Switch
                          size="sm"
                          aria-label={`${r.name} automatic action`}
                          checked={on && Boolean(draft.enabled)}
                          disabled={!r.toggle || !draft.enabled}
                          title={r.toggle ? undefined : 'Detection is always on'}
                          onCheckedChange={(v) => r.toggle && persist({ ...draft, [r.toggle]: v })}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-[var(--c3-style-basic-fg-primary)]">{r.name}</div>
                        <div className={cn('text-xs', muted)}>{r.signal}</div>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <Mono>{r.trigger(draft, num)}</Mono>
                      </td>
                      <td className={cn('min-w-64 px-3 py-3', !draft.enabled && muted)}>{r.does(draft)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <SectionCard title="Signals collected" actions={<HeadNote>Every 5 min per live run</HeadNote>}>
          <div className="flex flex-col gap-4">
            {SIGNALS.map(([group, items]) => (
              <div key={group}>
                <div className="mb-2 text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{group}</div>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((i) => (
                    <ToneBadge key={i} tone={group === 'Training' ? 'good' : 'neutral'}>
                      {i}
                    </ToneBadge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Recent actions" actions={<HeadNote>All runs</HeadNote>}>
          {acts.loading && !acts.data ? (
            <TableSkeleton rows={4} />
          ) : log.length === 0 ? (
            <EmptyState icon={<ShieldCheck />} title="No actions yet" hint="Guardrail and user actions on live runs appear here." className="py-6" />
          ) : (
            <ul className="flex flex-col">
              {log.slice(0, 8).map((e) => (
                <ActivityRow
                  key={e.id}
                  time={formatShortDateTime(e.actedAt)}
                  icon={e.actor === 'AUTOPILOT' ? <Bot /> : <User />}
                  title={`${ACTION_LABEL[e.actionType] ?? e.actionType} · ${e.job?.jobName ?? e.job?.name ?? e.job?.id ?? 'lab'}`}
                  detail={e.detail}
                />
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </PageFrame>
  );
};

export default Guardrails;
