/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Ban,
  Bell,
  Bot,
  CheckCheck,
  Clock,
  Hourglass,
  Layers,
  type LucideIcon,
  Minimize2,
  Pause,
  Rocket,
  Save,
  ShieldCheck,
  User,
} from 'lucide-react';

import {
  CardGrid,
  KpiRow,
  KpiTile,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricChart,
  PageFrame,
  ProgressBar,
  SectionCard,
  StatusBadge,
  ToneBadge,
  TONE_BG,
  errorMessage,
  lineOption,
  toneColor,
  useThemeKey,
  utilTone,
  provenanceFor,
  type ChartSeries,
  type ChartThreshold,
} from '@/components/app';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalSubtitle, ModalTitle } from '@/components/ui/modal';
import { ackAlert, applyJobAction, decideApproval, fetchJobActions, fetchJobAlerts, fetchJobMetrics, getJob, pendingApprovals } from '@/features/lab/api';
import { ActivityRow, AlertTypeBadge, HeadNote, JobStateBadge, muted, Notice } from '@/features/lab/components';
import { ACTION_LABEL, ALERT_TYPE_LABEL, formatShortDateTime, formatClock, formatDuration, formatInt, formatPct100, formatRelative, formatUsd, walltimeLeft } from '@/features/lab/format';
import type { ActionType, Alert, JobMetric } from '@/features/lab/types';
import { alertModel, ModelComputing, ModelProvenance, WhyFired } from '@/features/lab/models';
import { LIVE_POLL_MS, LiveBadge, liveJob, mergeSnap, SimNote, useLiveSnapshot, useNow, withLatest } from '@/features/lab/live';
import { queueStatus, useTelemetry } from '@/features/lab/telemetry';
import { useLabRole } from '@/features/lab/useLabRole';
import { useLoad } from '@/features/lab/useLoad';
import { formatDateTime } from '@/lib/format';

const ACTION_ICON: Record<ActionType, LucideIcon> = {
  SUBMIT: Rocket,
  CANCEL: Ban,
  EXTEND_WALLTIME: Hourglass,
  REQUEUE_STANDBY: Layers,
  CHECKPOINT_NOW: Save,
  SCALE_DOWN: Minimize2,
  NOTIFY_PI: Bell,
  HOLD: Pause,
};

const ACTION_HELP: Partial<Record<ActionType, string>> = {
  CHECKPOINT_NOW: 'Send USR1 so the job writes a checkpoint',
  EXTEND_WALLTIME: 'Ask RCAC to add 4 h (admin approval)',
  SCALE_DOWN: 'Requeue from checkpoint with half the GPUs',
  REQUEUE_STANDBY: 'Move to standby / preemptible QOS',
  NOTIFY_PI: 'Email the PI a summary of this run',
  CANCEL: 'scancel — stops billing immediately',
};

const MANUAL_ACTIONS: ActionType[] = ['CHECKPOINT_NOW', 'EXTEND_WALLTIME', 'SCALE_DOWN', 'REQUEUE_STANDBY', 'NOTIFY_PI', 'CANCEL'];
const DESTRUCTIVE: ActionType[] = ['CANCEL', 'SCALE_DOWN', 'REQUEUE_STANDBY'];

type MetricKey = keyof Pick<JobMetric, 'gpuUtilPct' | 'gpuMemPct' | 'cpuUtilPct' | 'memPct' | 'ioReadMBps' | 'ioWriteMBps' | 'powerW' | 'trainingLoss'>;
type Tab = 'metrics' | 'events' | 'activity' | 'actions';

const pts = (ms: JobMetric[], k: MetricKey): (number | null)[] => ms.map((m) => (m[k] == null ? null : Math.round((m[k] as number) * 10) / 10));

const RunDetail: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { reportError } = useErrorBoundary();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ActionType | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('metrics');

  const themeKey = useThemeKey();
  const job = useLoad(() => getJob(id), [id], LIVE_POLL_MS);
  const detail = useLoad(() => Promise.all([fetchJobMetrics(id), fetchJobAlerts(id), fetchJobActions(id)]), [id], LIVE_POLL_MS);
  const now = useNow(1000);
  const reloadAll = () => {
    job.reload();
    detail.reload();
  };

  const [fetchedMetrics, alerts, log] = detail.data ?? [[], [], []];
  const snap = useLiveSnapshot(job.data?.lab?.id ?? null);
  const approvals = useLoad(() => (job.data?.lab?.id ? pendingApprovals(job.data.lab.id) : null), [job.data?.lab?.id], LIVE_POLL_MS);
  const proposals = (approvals.data?.items ?? []).filter((i) => i.jobId === id && i.status === 'PENDING');
  const serverMetrics = useMemo(() => withLatest(fetchedMetrics, snap.byJob[id]?.latest), [fetchedMetrics, snap, id]);
  const sj = snap.byJob[id];
  const merged = job.data ? mergeSnap(job.data, sj) : null;
  const metrics = useTelemetry(merged, serverMetrics);
  const j = merged ? liveJob(merged, sj ? snap.updatedAt : job.updatedAt, now, merged.progressPerRealSec) : null;
  const latest = metrics.at(-1);
  const openAlerts = alerts.filter((a) => a.status === 'OPEN' || a.status === 'ACKED');
  const live = j?.state === 'RUNNING' || j?.state === 'PENDING';
  const lr = useLabRole();
  const canAct = Boolean(j && lr.canActOn(j.user));

  const charts = useMemo(() => {
    const x = metrics.map((m) => new Date(m.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    const pct = (v: number) => `${Math.round(v)}%`;
    const defs: { key: string; title: string; sub: string; series: ChartSeries[]; fmt: (v: number) => string; max?: number; thresholds?: ChartThreshold[]; color?: string }[] = [
      { key: 'util', title: 'GPU utilization', sub: 'Mean SM activity across allocated GPUs', series: [{ name: 'GPU util', data: pts(metrics, 'gpuUtilPct'), area: true, color: toneColor('good') }], fmt: pct, max: 100, thresholds: [{ value: 15, label: 'Idle below 15%', tone: 'warn' }] },
      { key: 'mem', title: 'GPU memory used', sub: `peak ${formatPct100(Math.max(0, ...metrics.map((m) => m.gpuMemPct ?? 0)))}`, series: [{ name: 'GPU memory', data: pts(metrics, 'gpuMemPct'), area: true, color: toneColor('pink') }], fmt: pct, max: 100, thresholds: [{ value: 95, label: 'OOM risk 95%', tone: 'bad' }] },
      { key: 'loss', title: 'Training loss', sub: latest?.trainingLoss != null ? `${latest.trainingLoss.toFixed(2)} · no NaN/Inf` : 'From the training sidecar', series: [{ name: 'Loss', data: pts(metrics, 'trainingLoss'), area: true, color: toneColor('good') }], fmt: (v) => v.toFixed(2) },
      { key: 'io', title: 'I/O throughput', sub: 'Scratch read / write, MB/s', series: [{ name: 'Read', data: pts(metrics, 'ioReadMBps'), area: true, color: toneColor('info') }, { name: 'Write', data: pts(metrics, 'ioWriteMBps'), color: toneColor('accent') }], fmt: (v) => `${Math.round(v)}` },
      { key: 'power', title: 'Node power', sub: 'Per-GPU average, watts', series: [{ name: 'Power', data: pts(metrics, 'powerW'), area: true, color: toneColor('warn') }], fmt: (v) => `${Math.round(v)} W` },
      { key: 'host', title: 'CPU and host memory', sub: 'Allocated cores · RSS vs --mem', series: [{ name: 'CPU', data: pts(metrics, 'cpuUtilPct') }, { name: 'RAM', data: pts(metrics, 'memPct'), color: toneColor('info'), dashed: true }], fmt: pct, max: 100, thresholds: [{ value: 90, label: 'OOM-kill', tone: 'bad' }] },
    ];
    return defs.map((d) => ({ ...d, option: lineOption({ x, series: d.series, valueFormat: d.fmt, min: 0, max: d.max, thresholds: d.thresholds }) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics, themeKey, latest]);

  const run = async (action: ActionType) => {
    if (!j) return;
    setBusy(action);
    setActionError(null);
    try {
      const res = await applyJobAction(j.id, action, lr.actor);
      setNote(`${ACTION_LABEL[action]}: ${res?.detail ?? 'done'}${res?.outcome === 'PENDING_APPROVAL' ? ' — waiting for approval' : ''}`);
      setConfirm(null);
      reloadAll();
    } catch (err) {
      setActionError(errorMessage(err));
      reportError(err);
    } finally {
      setBusy(null);
    }
  };

  const request = (action: ActionType) => (DESTRUCTIVE.includes(action) ? setConfirm(action) : run(action));

  const acknowledge = async (a: Alert) => {
    setBusy(a.id);
    try {
      await ackAlert(a.id);
      detail.reload();
    } catch (err) {
      setActionError(errorMessage(err));
      reportError(err);
    } finally {
      setBusy(null);
    }
  };

  const decide = async (approvalId: string, ok: boolean) => {
    setBusy(`${approvalId}:${ok ? 'yes' : 'no'}`);
    setActionError(null);
    try {
      await decideApproval(approvalId, ok);
      setNote(ok ? 'Confirmed: the action is running and is logged on this run.' : 'Declined: nothing changes on the run.');
      approvals.reload();
      reloadAll();
    } catch (err) {
      setActionError(errorMessage(err));
      reportError(err);
    } finally {
      setBusy(null);
    }
  };


  const crumbs = [{ label: 'Live Runs', href: '#/runs' }, { label: j?.jobName ?? id }];

  if (job.loading && !j) {
    return (
      <PageFrame title="Run" breadcrumbs={crumbs}>
        <LoadingState label="Loading run…" />
      </PageFrame>
    );
  }
  if (!j) {
    return (
      <PageFrame title="Run" breadcrumbs={crumbs}>
        <ErrorState message={job.error ? `Could not load run: ${job.error}` : `Run "${id}" was not found.`} onRetry={job.reload} />
      </PageFrame>
    );
  }

  const left = walltimeLeft(j);
  const part = j.partition as (typeof j.partition & { avgWaitHours?: number; currentQueueDepth?: number }) | undefined;
  const queueDepth = part?.currentQueueDepth ?? null;
  const qs = queueStatus({ ...j, partition: part, queuePosition: merged?.queuePosition, etaStartAt: merged?.etaStartAt }, now);
  const wallFrac = j.timelimitHours ? (j.elapsedHours ?? 0) / j.timelimitHours : 0;
  const burn = j.elapsedHours ? (j.costUsd ?? 0) / j.elapsedHours : null;
  const ckpt = latest?.checkpointAgeMin;

  const ckptTone = ckpt == null ? 'neutral' : ckpt > 60 ? 'bad' : ckpt > 30 ? 'warn' : 'good';
  const banner = openAlerts.find((a) => a.severity === 'CRITICAL' && a.status === 'OPEN');
  const issues = [...alerts].sort((a, b) => (a.detectedAt ?? '').localeCompare(b.detectedAt ?? ''));
  const peakMem = Math.max(0, ...metrics.map((m) => m.gpuMemPct ?? 0));
  const utilTrend = metrics.slice(-12).map((m) => m.gpuUtilPct ?? null);
  const chartByKey = Object.fromEntries(charts.map((c) => [c.key, c]));
  const chart = (k: string, height = 'h-52') => {
    const c = chartByKey[k];
    return (
      <MetricChart
        key={k}
        title={c.title}
        subtitle={c.sub}
        option={c.option}
        loading={detail.loading && !detail.data}
        error={detail.error}
        onRetry={detail.reload}
        empty={metrics.length < 2}
        emptyLabel={j.state === 'PENDING' ? 'Waiting for the job to start' : 'No samples yet'}
        heightClass={height}
        live={j.state === 'RUNNING'}
        ariaLabel={c.title}
        legend={c.series.length > 1 ? c.series.map((sr, i) => ({ label: sr.name, swatchClass: i === 0 ? TONE_BG.info : TONE_BG.accent, dashed: sr.dashed })) : undefined}
      />
    );
  };

  return (
    <PageFrame
      title={
        <span>
          <a href="#/runs" className={`${muted} hover:underline`}>Runs</a>
          <span className={muted}> / </span>
          <span className="font-mono">{j.jobName ?? j.id}</span>
        </span>
      }
      description={[j.user, [j.cluster?.name ?? j.cluster?.id, j.partition?.slurmPartition ?? j.partition?.name].filter(Boolean).join(' '), j.qos && `${j.qos} QOS`, j.slurmJobId && `job ${j.slurmJobId}`, j.nodeList && `node ${j.nodeList}`, j.project?.name].filter(Boolean).join(' · ')}
      badges={
        <span className="flex flex-wrap items-center gap-2">
          {banner && live ? <ToneBadge tone="warn">Needs approval</ToneBadge> : <JobStateBadge value={j.state} />}
          {live && <LiveBadge updatedAt={snap.updatedAt ?? job.updatedAt} />}
        </span>
      }
      actions={
        <div className="flex flex-wrap gap-2">
          {live && canAct && (
            <Button variant="outline" appearance="secondary" leadingIcon={<Save />} loading={busy === 'CHECKPOINT_NOW'} onClick={() => run('CHECKPOINT_NOW')}>
              Checkpoint now
            </Button>
          )}
          {live && canAct && (
            <Button variant="outline" appearance="danger" leadingIcon={<Ban />} onClick={() => setConfirm('CANCEL')}>
              Cancel run
            </Button>
          )}
        </div>
      }
    >
      {actionError && <ErrorState message={actionError} />}
      {proposals.map((p) => (
        <div key={p.id} role="alert" className="flex flex-wrap items-center gap-4 rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-warning)] bg-[var(--c3-style-basic-bg-warning)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{p.title ?? `${p.actor === 'AUTOPILOT' ? 'Autopilot proposes' : 'Requested'}: ${p.actionType ? ACTION_LABEL[p.actionType] : p.kind}`}</div>
            {p.detail && <div className={`mt-0.5 text-[13px] ${muted}`}>{p.detail}</div>}
            <div className="mt-1.5">
              <ModelProvenance name="GuardrailRuleEngine" extra="Consequential actions wait for the run owner or PI to confirm." />
            </div>
          </div>
          {canAct || lr.canApprove ? (
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" appearance="secondary" size="sm" loading={busy === `${p.id}:no`} onClick={() => decide(p.id, false)}>
                Decline
              </Button>
              <Button size="sm" loading={busy === `${p.id}:yes`} onClick={() => decide(p.id, true)}>
                {p.kind === 'ACTION_CONFIRMATION' ? 'Confirm' : 'Approve'}
              </Button>
            </div>
          ) : (
            <ToneBadge tone="warn">Waiting for the run owner or PI</ToneBadge>
          )}
        </div>
      ))}
      {j.state === 'PENDING' && (
        <div role="status" className="flex flex-wrap items-center gap-4 rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-info,var(--c3-style-basic-border-border))] bg-[var(--c3-style-basic-bg-info,var(--c3-style-basic-bg-secondary))] px-5 py-4">
          <span aria-hidden className="ec-pulse inline-block size-2.5 rounded-full bg-[var(--c3-style-basic-fg-info)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">
              {qs.starting ? qs.label : `Queued on ${j.cluster?.name ?? j.cluster?.id} ${j.partition?.slurmPartition ?? j.partition?.name ?? ''}${merged?.queuePosition != null ? ` · position #${merged.queuePosition}` : queueDepth != null ? ` · about ${formatInt(queueDepth + 1)} jobs ahead in this partition` : ''}`}
            </div>
            <div className={`text-[13px] ${muted}`}>
              {`Submitted ${formatRelative(j.submitTime)}${qs.etaMs ? ` · ${qs.starting ? 'Slurm is placing it now' : qs.label}` : ''}. Metrics start flowing as soon as Slurm places it on a node.`}
            </div>
            {qs.etaMs != null && <ProgressBar value={qs.progress} tone="info" size="sm" className="mt-2 max-w-sm" ariaLabel="Queue wait elapsed" />}
          </div>
          <ModelProvenance name="AnvilQueueWaitQ50Q90" confidence="low" />
        </div>
      )}
      {busy === 'tick' && (
        <Notice>
          <span className="flex flex-wrap gap-4">
            <ModelComputing name="GPUUnderuseDetector" />
            <ModelComputing name="GuardrailRuleEngine" detail="is evaluating every live run…" />
          </span>
        </Notice>
      )}
      {note && !actionError && busy !== 'tick' && <Notice>{note}</Notice>}

      {banner && live && (
        <div role="alert" className="flex flex-wrap items-center gap-4 rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-danger)] bg-[var(--c3-style-basic-bg-danger)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{`${ALERT_TYPE_LABEL[banner.alertType] ?? banner.alertType} · ${formatClock(banner.detectedAt)}`}</div>
            <div className={`mt-0.5 text-[13px] ${muted}`}>{banner.message}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <ModelProvenance name={alertModel(banner.alertType)} provenance={provenanceFor(banner, alertModel(banner.alertType))} />
              <WhyFired type={banner.alertType} firedRule={banner.firedRule} evidence={banner.evidence} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {canAct && (
              <Button variant="outline" appearance="secondary" size="sm" loading={busy === banner.id} onClick={() => acknowledge(banner)}>
                Acknowledge
              </Button>
            )}
            {!canAct && <ToneBadge tone="warn">Waiting for the PI or run owner to approve</ToneBadge>}
            {banner.recommendedAction && canAct && (
              <Button size="sm" appearance={banner.recommendedAction === 'CANCEL' ? 'danger' : 'accent'} loading={busy === banner.recommendedAction} onClick={() => request(banner.recommendedAction as ActionType)}>
                {ACTION_LABEL[banner.recommendedAction]}
              </Button>
            )}
          </div>
        </div>
      )}

      <KpiRow>
        <KpiTile
          label="Walltime"
          value={formatDuration(j.elapsedHours)}
          unit={`of ${formatDuration(j.timelimitHours)}`}
          caption={j.state === 'RUNNING' ? `${formatDuration(left)} left · ticking` : (j.startTime ? `Started ${formatDateTime(j.startTime)}` : `Queued ${formatRelative(j.submitTime)}`)}
          tone={wallFrac > 0.9 ? 'bad' : wallFrac > 0.75 ? 'warn' : 'good'}
        />
        <KpiTile
          label="GPU utilization"
          value={formatPct100(latest?.gpuUtilPct)}
          unit={`${j.allocGpus ?? 0} × ${j.gpuType?.id ?? 'GPU'}`}
          caption={`${formatPct100(j.gpuUtilAvg)} average since start`}
          trend={utilTrend.length > 1 ? (utilTrend as number[]) : undefined}
          trendTone={utilTone(latest?.gpuUtilPct)}
        />
        <KpiTile
          label="GPU memory · checkpoint"
          value={formatPct100(latest?.gpuMemPct)}
          unit={`peak ${formatPct100(peakMem)}`}
          tone={peakMem >= 95 ? 'bad' : peakMem >= 88 ? 'warn' : undefined}
          caption={<span className={ckptTone === 'bad' ? 'text-[var(--c3-style-basic-fg-danger)]' : undefined}>{ckpt != null ? `Last checkpoint ${formatDuration(ckpt / 60)} ago` : 'No checkpoint reported'}</span>}
        />
        <KpiTile label="Charged so far" value={formatUsd(j.costUsd)} unit={j.costUnits != null ? `${formatInt(j.costUnits)} units` : undefined} caption={burn != null ? `${formatUsd(burn)}/h burn rate` : 'Not started'} />
      </KpiRow>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} variant="bordered">
        <TabsList>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="events">{`Events${issues.length ? ` (${issues.length})` : ''}`}</TabsTrigger>
          <TabsTrigger value="activity">{`Activity${log.length ? ` (${log.length})` : ''}`}</TabsTrigger>
          <TabsTrigger value="actions">Actions</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'metrics' && (
        <>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            {chart('util', 'h-64')}
            <SectionCard title="Detected issues" actions={<HeadNote>{`${issues.length} on this run`}</HeadNote>}>
              {issues.length === 0 ? (
                <EmptyState icon={<ShieldCheck />} title={detail.loading && !detail.data ? 'Checking health…' : 'No issues detected'} hint="Idle GPUs, OOM risk, walltime, checkpoints and budget are checked every 5 minutes." className="py-6" />
              ) : (
                <ol className="flex flex-col">
                  {issues.map((a, i) => (
                    <li key={a.id} className="grid grid-cols-[44px_22px_minmax(0,1fr)] gap-2 border-b border-[var(--c3-style-basic-border-border)] py-3 first:pt-0 last:border-b-0 last:pb-0">
                      <span className={`pt-0.5 font-mono text-[11.5px] ${muted}`}>{formatShortDateTime(a.detectedAt)}</span>
                      <span className={`mt-0.5 flex size-5 items-center justify-center rounded-full text-[11px] font-semibold ${a.status === 'OPEN' ? (a.severity === 'CRITICAL' ? 'bg-[var(--c3-style-basic-bg-danger)] text-[var(--c3-style-basic-fg-danger)]' : 'bg-[var(--c3-style-basic-bg-warning)] text-[var(--c3-style-basic-fg-warning)]') : 'bg-[var(--c3-style-basic-bg-success)] text-[var(--c3-style-basic-fg-success)]'}`}>
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{ALERT_TYPE_LABEL[a.alertType] ?? a.alertType}</div>
                        <div className={`text-[13px] ${muted}`}>{a.message}</div>
                        <div className="mt-1">
                          <WhyFired type={a.alertType} firedRule={a.firedRule} evidence={a.evidence} />
                        </div>
                        <div className="mt-1">
                          <ModelProvenance name={alertModel(a.alertType)} provenance={provenanceFor(a, alertModel(a.alertType))} />
                        </div>
                        <div className={`mt-0.5 text-[12px] ${muted}`}>
                          {a.status === 'OPEN' || a.status === 'ACKED'
                            ? `Suggested: ${a.recommendedAction ? ACTION_LABEL[a.recommendedAction] : 'review'}${a.status === 'ACKED' ? ' · acknowledged' : ''}`
                            : `${a.autoActionTaken ? 'Guardrail acted · ' : ''}${a.status === 'AUTO_RESOLVED' ? 'Cleared on its own' : 'Resolved'}`}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </SectionCard>
          </div>
          <CardGrid layout="halves">
            {chart('mem')}
            {chart('loss')}
            {chart('io')}
            {chart('power')}
          </CardGrid>
          {chart('host', 'h-44')}
        </>
      )}

      {tab === 'events' && (
        <SectionCard title="Alerts" subtitle={openAlerts.length ? `${openAlerts.length} open · recommended fixes are one click` : 'Health rules run on the latest 60-minute window'}>
          {alerts.length === 0 ? (
            <EmptyState icon={<ShieldCheck />} title="No alerts on this run" className="py-6" />
          ) : (
            <ul className="flex flex-col gap-3">
              {[...openAlerts, ...alerts.filter((a) => !openAlerts.includes(a))].map((a) => {
                const Icon = a.recommendedAction ? ACTION_ICON[a.recommendedAction] : CheckCheck;
                const isOpen = a.status === 'OPEN' || a.status === 'ACKED';
                return (
                  <li key={a.id} className="flex flex-col gap-3 rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-border)] p-4 md:flex-row md:items-center">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <AlertTypeBadge type={a.alertType} severity={a.severity} />
                        <StatusBadge kind="alertStatus" value={a.status} />
                        {a.autoActionTaken && <ToneBadge tone="accent">Auto-fixed</ToneBadge>}
                        <span className={`text-xs ${muted}`}>{formatRelative(a.detectedAt)}</span>
                      </span>
                      <span className="text-[13px] text-[var(--c3-style-basic-fg-primary)]">{a.message}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <ModelProvenance name={alertModel(a.alertType)} provenance={provenanceFor(a, alertModel(a.alertType))} />
                        <WhyFired type={a.alertType} firedRule={a.firedRule} evidence={a.evidence} />
                      </span>
                    </div>
                    {isOpen && (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {a.status === 'OPEN' && canAct && (
                          <Button variant="ghost" appearance="secondary" size="sm" loading={busy === a.id} onClick={() => acknowledge(a)}>
                            Acknowledge
                          </Button>
                        )}
                        {a.recommendedAction && live && canAct && (
                          <Button size="sm" appearance={a.recommendedAction === 'CANCEL' ? 'danger' : 'accent'} leadingIcon={<Icon />} loading={busy === a.recommendedAction} onClick={() => request(a.recommendedAction as ActionType)}>
                            {ACTION_LABEL[a.recommendedAction]}
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === 'activity' && (
        <SectionCard title="Activity" subtitle="Guardrail and user actions on this run, with the Slurm command each one ran">
          {log.length === 0 ? (
            <EmptyState icon={<Clock />} title={detail.loading && !detail.data ? 'Loading…' : 'No actions yet'} className="py-6" />
          ) : (
            <ul className="flex flex-col">
              {log.map((e) => (
                <ActivityRow
                  key={e.id}
                  time={formatShortDateTime(e.actedAt)}
                  icon={e.actor === 'AUTOPILOT' ? <Bot /> : e.actor === 'ADMIN' ? <ShieldCheck /> : <User />}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {ACTION_LABEL[e.actionType] ?? e.actionType}
                      <StatusBadge kind="actor" value={e.actor} />
                      {e.outcome && e.outcome !== 'DONE' && <StatusBadge kind="actionOutcome" value={e.outcome} />}
                    </span>
                  }
                  detail={e.detail ? <span className="font-mono text-[12px] break-words">{e.detail}</span> : undefined}
                />
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === 'actions' && (
        <SectionCard title="Actions" subtitle={!live ? 'This run has ended' : canAct ? 'Every action is logged with its Slurm command' : `Only ${j.user ?? 'the run owner'} or a PI can act on this run`}>
          <ul className="grid grid-cols-1 gap-1 md:grid-cols-2">
            {MANUAL_ACTIONS.map((a) => {
              const Icon = ACTION_ICON[a];
              return (
                <li key={a}>
                  <button
                    type="button"
                    disabled={!live || !canAct || busy !== null}
                    onClick={() => request(a)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-[var(--c3-style-basic-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className={`flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--c3-style-basic-bg-secondary)] ${a === 'CANCEL' ? 'text-[var(--c3-style-basic-fg-danger)]' : 'text-[var(--c3-style-basic-fg-primary)]'}`}>
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[13px] font-medium text-[var(--c3-style-basic-fg-primary)]">{ACTION_LABEL[a]}</span>
                      <span className={`truncate text-xs ${muted}`}>{ACTION_HELP[a]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      )}

      <Modal open={confirm !== null} onOpenChange={(open) => !open && !busy && setConfirm(null)}>
        <ModalContent width={460} aria-describedby="confirm-action-subtitle">
          <ModalHeader>
            <ModalTitle>{confirm ? ACTION_LABEL[confirm] : ''}</ModalTitle>
            <ModalSubtitle id="confirm-action-subtitle">{confirm ? ACTION_HELP[confirm] : ''}</ModalSubtitle>
          </ModalHeader>
          <ModalBody>
            <p className="text-sm">
              {confirm === 'CANCEL'
                ? `Cancel ${j.jobName}? Work since the last checkpoint (${ckpt != null ? `${Math.round(ckpt)} min` : 'unknown'}) will be lost.`
                : `Apply "${confirm ? ACTION_LABEL[confirm] : ''}" to ${j.jobName}? The job restarts from its last checkpoint.`}
            </p>
          </ModalBody>
          <ModalFooter>
            <div className="flex w-full justify-end gap-2">
              <Button variant="outline" appearance="secondary" disabled={Boolean(busy)} onClick={() => setConfirm(null)}>
                Keep running
              </Button>
              <Button appearance={confirm === 'CANCEL' ? 'danger' : 'accent'} loading={busy === confirm} onClick={() => confirm && run(confirm)}>
                {confirm ? ACTION_LABEL[confirm] : 'Confirm'}
              </Button>
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <SimNote />
    </PageFrame>
  );
};

export default RunDetail;
