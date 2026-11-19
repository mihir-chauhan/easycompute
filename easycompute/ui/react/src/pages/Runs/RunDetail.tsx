/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Ban,
  Bell,
  Bot,
  CheckCheck,
  Clock,
  FastForward,
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

import EChart from '@/components/charts/EChart';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import PageFrame, { errorMessage, ErrorState, LoadingState } from '@/components/PageFrame/PageFrame';
import { EnumBadge } from '@/components/StatusBadges/StatusBadges';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalSubtitle, ModalTitle } from '@/components/ui/modal';
import {
  ackAlert,
  applyJobAction,
  fetchJobActions,
  fetchJobAlerts,
  fetchJobMetrics,
  getJob,
  monitorTick,
} from '@/features/lab/api';
import { timeSeriesOption, type TimeSeries } from '@/features/lab/charts';
import { ActorBadge, AlertTypeBadge, EmptyBlock, JobStateBadge, Meter, muted, Stat } from '@/features/lab/components';
import {
  ACTION_LABEL,
  formatClock,
  formatDuration,
  formatInt,
  formatPct100,
  formatRelative,
  formatUsd,
  titleCase,
  walltimeLeft,
} from '@/features/lab/format';
import type { ActionType, Alert, JobMetric } from '@/features/lab/types';
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

type MetricKey = keyof Pick<JobMetric, 'gpuUtilPct' | 'gpuMemPct' | 'cpuUtilPct' | 'memPct' | 'ioReadMBps' | 'ioWriteMBps' | 'powerW'>;

const pts = (ms: JobMetric[], k: MetricKey): [number, number | null][] => ms.map((m) => [new Date(m.ts).getTime(), m[k] ?? null]);

const RunDetail: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { reportError } = useErrorBoundary();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ActionType | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const job = useLoad(() => getJob(id), [id]);
  const detail = useLoad(() => Promise.all([fetchJobMetrics(id), fetchJobAlerts(id), fetchJobActions(id)]), [id]);
  const reloadAll = () => {
    job.reload();
    detail.reload();
  };

  const { reload: reloadJob } = job;
  const { reload: reloadDetail } = detail;
  useEffect(() => {
    const t = window.setInterval(() => {
      reloadJob();
      reloadDetail();
    }, 30000);
    return () => window.clearInterval(t);
  }, [reloadJob, reloadDetail]);

  const [metrics, alerts, log] = detail.data ?? [[], [], []];
  const j = job.data;
  const latest = metrics.at(-1);
  const openAlerts = alerts.filter((a) => a.status === 'OPEN' || a.status === 'ACKED');
  const live = j?.state === 'RUNNING' || j?.state === 'PENDING';

  const charts = useMemo(() => {
    const pct = (v: number) => `${Math.round(v)}%`;
    const defs: { title: string; sub: string; series: TimeSeries[]; fmt: (v: number) => string; yMax?: number; thresholds?: { value: number; label: string; appearance: 'danger' | 'warning' }[] }[] = [
      { title: 'GPU utilization', sub: 'Mean across allocated GPUs', series: [{ name: 'GPU util', appearance: 'accent', area: true, points: pts(metrics, 'gpuUtilPct') }], fmt: pct, yMax: 100, thresholds: [{ value: 15, label: 'Idle', appearance: 'warning' }] },
      { title: 'GPU memory', sub: 'Framebuffer used', series: [{ name: 'GPU memory', appearance: 'accent', area: true, points: pts(metrics, 'gpuMemPct') }], fmt: pct, yMax: 100, thresholds: [{ value: 95, label: 'OOM risk', appearance: 'danger' }] },
      { title: 'CPU utilization', sub: 'Allocated cores', series: [{ name: 'CPU', appearance: 'accent', points: pts(metrics, 'cpuUtilPct') }], fmt: pct, yMax: 100 },
      { title: 'Host memory', sub: 'RSS vs requested --mem', series: [{ name: 'RAM', appearance: 'accent', points: pts(metrics, 'memPct') }], fmt: pct, yMax: 100, thresholds: [{ value: 90, label: 'OOM-kill', appearance: 'danger' }] },
      { title: 'I/O throughput', sub: 'Scratch read / write', series: [{ name: 'Read', appearance: 'accent', points: pts(metrics, 'ioReadMBps') }, { name: 'Write', appearance: 'info', points: pts(metrics, 'ioWriteMBps') }], fmt: (v) => `${Math.round(v)} MB/s` },
      { title: 'Power draw', sub: 'Per GPU, watts', series: [{ name: 'Power', appearance: 'accent', points: pts(metrics, 'powerW') }], fmt: (v) => `${Math.round(v)} W` },
    ];
    return defs.map((d) => ({ ...d, option: timeSeriesOption({ series: d.series, yFormatter: d.fmt, yMax: d.yMax, thresholds: d.thresholds }) }));
  }, [metrics]);

  const run = async (action: ActionType) => {
    if (!j) return;
    setBusy(action);
    setActionError(null);
    try {
      const res = await applyJobAction(j.id, action);
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

  const simulate = async () => {
    setBusy('tick');
    setActionError(null);
    try {
      const res = await monitorTick();
      setNote(`Simulated 15 min: ${formatInt(Number(res?.metricsAdded ?? 0))} samples, ${formatInt(Number(res?.alertsRaised ?? 0))} alerts, ${formatInt(Number(res?.actionsTaken ?? 0))} autopilot actions.`);
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
  const wallFrac = j.timelimitHours ? (j.elapsedHours ?? 0) / j.timelimitHours : 0;
  const burn = j.elapsedHours ? (j.costUsd ?? 0) / j.elapsedHours : null;
  const ckpt = latest?.checkpointAgeMin;

  return (
    <PageFrame
      title={j.jobName ?? j.id}
      description={`Slurm job ${j.slurmJobId ?? j.id} · ${j.user ?? 'unknown user'} · ${j.account ?? ''}${j.project?.name ? ` · ${j.project.name}` : ''}`}
      breadcrumbs={crumbs}
      badges={
        <span className="flex gap-1">
          <JobStateBadge value={j.state} />
          {j.qos && <EnumBadge value={j.qos} appearance={j.qos === 'normal' ? 'secondary' : 'info'} />}
        </span>
      }
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" appearance="secondary" leadingIcon={<FastForward />} loading={busy === 'tick'} onClick={simulate}>
            Simulate next 15 min
          </Button>
          {live && (
            <Button variant="outline" appearance="danger" leadingIcon={<Ban />} onClick={() => setConfirm('CANCEL')}>
              Cancel job
            </Button>
          )}
        </div>
      }
    >
      {actionError && <ErrorState message={actionError} />}
      {note && !actionError && (
        <div role="status" className={`rounded-sm border border-[var(--c3-style-basic-border-primary)] bg-[var(--c3-style-basic-bg-primary)] px-4 py-2 text-c3-regular-body-p2 ${muted}`}>
          {note}
        </div>
      )}

      <Container>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Cluster / partition" value={j.cluster?.name ?? j.cluster?.id} sub={`${j.partition?.name ?? j.partition?.id ?? '—'} · ${j.nodeList ?? ''}`} />
          <Stat label="Resources" value={`${j.allocGpus ?? 0}× ${j.gpuType?.id ?? 'CPU'}`} sub={`${j.allocNodes ?? 1} node · ${j.allocCpus ?? '—'} cores`} />
          <div className="flex min-w-0 flex-col gap-1">
            <Stat label="Walltime left" value={formatDuration(left)} sub={`${formatDuration(j.elapsedHours)} of ${formatDuration(j.timelimitHours)} used`} />
            <Meter value={wallFrac} appearance={wallFrac > 0.9 ? 'danger' : wallFrac > 0.75 ? 'warning' : 'accent'} label="Walltime used" />
          </div>
          <Stat label="Cost so far" value={formatUsd(j.costUsd)} sub={burn != null ? `${formatUsd(burn)}/h burn` : undefined} />
          <Stat label="GPU util now" value={formatPct100(latest?.gpuUtilPct)} sub={`avg ${formatPct100(j.gpuUtilAvg)} since start`} />
          <Stat
            label="Last checkpoint"
            value={<span className={ckpt != null && ckpt > 60 ? 'text-[var(--c3-style-basic-fg-danger)]' : undefined}>{ckpt != null ? `${formatDuration(ckpt / 60)} ago` : '—'}</span>}
            sub={j.startTime ? `Started ${formatDateTime(j.startTime)}` : `Queued ${formatRelative(j.submitTime)}`}
          />
        </div>
      </Container>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          <Container title="Alerts" subtitle={openAlerts.length ? `${openAlerts.length} open — recommended fixes are one click` : 'Health rules on the latest 60-minute window'}>
            {openAlerts.length === 0 ? (
              <EmptyBlock icon={<ShieldCheck className="size-6 text-[var(--c3-style-basic-fg-success)]" aria-hidden />} label={detail.loading && !detail.data ? 'Checking health…' : 'No open alerts. This run looks healthy.'} />
            ) : (
              <ul className="flex flex-col gap-3">
                {openAlerts.map((a) => {
                  const Icon = a.recommendedAction ? ACTION_ICON[a.recommendedAction] : CheckCheck;
                  return (
                    <li
                      key={a.id}
                      className="flex flex-col gap-3 rounded-sm border border-[var(--c3-style-basic-border-primary)] p-4 md:flex-row md:items-center"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <AlertTypeBadge type={a.alertType} severity={a.severity} />
                          {a.status === 'ACKED' && <EnumBadge value="Acknowledged" appearance="secondary" />}
                          {a.autoActionTaken && <EnumBadge value="Autopilot acted" appearance="accent" />}
                          <span className={`text-xs ${muted}`}>{formatRelative(a.detectedAt)}</span>
                        </span>
                        <span className="text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">{a.message}</span>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {a.status === 'OPEN' && (
                          <Button variant="ghost" appearance="secondary" size="sm" loading={busy === a.id} onClick={() => acknowledge(a)}>
                            Acknowledge
                          </Button>
                        )}
                        {a.recommendedAction && live && (
                          <Button
                            size="sm"
                            appearance={a.recommendedAction === 'CANCEL' ? 'danger' : 'accent'}
                            leadingIcon={<Icon />}
                            loading={busy === a.recommendedAction}
                            onClick={() => request(a.recommendedAction as ActionType)}
                          >
                            {ACTION_LABEL[a.recommendedAction]}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Container>

          {detail.error && <ErrorState message={`Could not load metrics: ${detail.error}`} onRetry={detail.reload} />}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {charts.map((c) => (
              <Container key={c.title} title={c.title} subtitle={c.sub}>
                {metrics.length < 2 ? (
                  <EmptyBlock label={detail.loading && !detail.data ? 'Loading samples…' : j.state === 'PENDING' ? 'Waiting for the job to start.' : 'No samples yet.'} />
                ) : (
                  <EChart ariaLabel={c.title} option={c.option} className="h-52" />
                )}
              </Container>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Container title="Actions" subtitle={live ? 'Every action is logged with its Slurm command' : 'This run has ended'}>
            <ul className="flex flex-col gap-1">
              {MANUAL_ACTIONS.map((a) => {
                const Icon = ACTION_ICON[a];
                return (
                  <li key={a}>
                    <button
                      type="button"
                      disabled={!live || busy !== null}
                      onClick={() => request(a)}
                      className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left hover:bg-[var(--c3-style-basic-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Icon className={`size-4 shrink-0 ${a === 'CANCEL' ? 'text-[var(--c3-style-basic-fg-danger)]' : 'text-[var(--c3-style-basic-fg-accent)]'}`} aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-c3-bold-body-p2 text-[var(--c3-style-basic-fg-primary)]">{ACTION_LABEL[a]}</span>
                        <span className={`truncate text-xs ${muted}`}>{ACTION_HELP[a]}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Container>

          <Container title="Activity" subtitle="Autopilot and user actions on this run">
            {log.length === 0 ? (
              <EmptyBlock icon={<Clock className="size-6" aria-hidden />} label="No actions yet." />
            ) : (
              <ol className="relative flex flex-col gap-4 border-l border-[var(--c3-style-basic-border-primary)] pl-5">
                {log.map((e) => {
                  const Icon = e.actor === 'AUTOPILOT' ? Bot : e.actor === 'ADMIN' ? ShieldCheck : User;
                  return (
                    <li key={e.id} className="relative">
                      <span className="absolute top-0.5 -left-[29px] flex size-4 items-center justify-center rounded-full bg-[var(--c3-style-basic-bg-primary)] ring-1 ring-[var(--c3-style-basic-border-primary)]">
                        <Icon className={`size-3 ${e.actor === 'AUTOPILOT' ? 'text-[var(--c3-style-basic-fg-accent)]' : muted}`} aria-hidden />
                      </span>
                      <div className="flex flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-c3-bold-body-p2 text-[var(--c3-style-basic-fg-primary)]">{ACTION_LABEL[e.actionType] ?? e.actionType}</span>
                          <ActorBadge value={e.actor} />
                          {e.outcome && e.outcome !== 'DONE' && <EnumBadge value={titleCase(e.outcome)} appearance={e.outcome === 'FAILED' ? 'danger' : 'warning'} />}
                        </span>
                        {e.detail && <span className={`break-words font-mono text-xs ${muted}`}>{e.detail}</span>}
                        <span className={`text-xs ${muted}`} title={formatDateTime(e.actedAt)}>
                          {formatClock(e.actedAt)} · {formatRelative(e.actedAt)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Container>
        </div>
      </div>

      <Modal open={confirm !== null} onOpenChange={(open) => !open && !busy && setConfirm(null)}>
        <ModalContent width={460} aria-describedby="confirm-action-subtitle">
          <ModalHeader>
            <ModalTitle>{confirm ? ACTION_LABEL[confirm] : ''}</ModalTitle>
            <ModalSubtitle id="confirm-action-subtitle">{confirm ? ACTION_HELP[confirm] : ''}</ModalSubtitle>
          </ModalHeader>
          <ModalBody>
            <p className="text-c3-regular-body-p2">
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
    </PageFrame>
  );
};

export default RunDetail;
