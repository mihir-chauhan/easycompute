/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, ChevronRight, Copy, Pencil, RotateCcw, Rocket } from 'lucide-react';

import { ErrorState, LoadingState, PageFrame, SectionCard, StatusBadge, ToneBadge, errorMessage, provenanceFor, useAppShell, type Tone } from '@/components/app';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Button } from '@/components/ui/button';
import {
  checkRules,
  createRunRequest,
  fetchClusters,
  fetchGpuTypes,
  fetchProjects,
  getRunRequestStatus,
  getRunRequest,
  fetchChecks,
  fetchPlans,
  predictDuration,
  type DurationPrediction,
  recommendPlans,
  submitWithApproval,
  updateRunRequest,
} from '@/features/lab/api';
import { CheckRow, HeadNote, KV, muted, ScriptBlock } from '@/features/lab/components';
import { ModelComputing, ModelProvenance, ModelsComputing } from '@/features/lab/models';
import { formatDuration, formatInt, formatUsd, WORKLOAD_LABEL } from '@/features/lab/format';
import type { RuleCheck, RunPlan, RunRequest, RunRequestStatus } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLabRole } from '@/features/lab/useLabRole';
import { useLoad } from '@/features/lab/useLoad';
import { formatDateTime, formatShortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import DescribeStep from './DescribeStep';
import { EMPTY_FORM, type PlanForm, toLocalInput, toRunRequest } from './planForm';

const STEPS = ['Describe', 'Check rules', 'Choose configuration', 'Submit'] as const;

const LABEL_TONE: Record<string, Tone> = { Balanced: 'good', Fastest: 'info', Cheapest: 'neutral' };
const LABEL_TEXT: Record<string, string> = { Balanced: 'Recommended', Fastest: 'Fastest', Cheapest: 'Lowest cost' };

const checkKind = (c: RuleCheck): 'ok' | 'warn' | 'bad' | 'info' =>
  c.outcome === 'FAIL' ? 'bad' : c.outcome === 'WARN' ? (/rules out|split|chain/i.test(c.message ?? '') ? 'info' : 'warn') : 'ok';

/** Right-side tag for a check: Auto-fixed (planner routes around it), Blocked, or the rule scope. */
function CheckTag({ c }: { c: RuleCheck }) {
  if (c.outcome === 'FAIL') return <ToneBadge tone="bad">{c.severity === 'BLOCK' ? 'Blocked' : 'Fails'}</ToneBadge>;
  if (c.outcome === 'WARN') return /rules out|split|chain/i.test(c.message ?? '') ? <ToneBadge tone="info">Auto-fixed</ToneBadge> : <ToneBadge tone="warn">Warning</ToneBadge>;
  return <span className={cn('font-mono text-[11px]', muted)}>{(c.scope ?? c.policy?.scope ?? 'rule').toLowerCase()}</span>;
}

function Stepper({ step, reached, onJump }: { step: number; reached: number; onJump: (i: number) => void }) {
  return (
    <nav aria-label="Planner steps" className="flex gap-7 overflow-x-auto border-b border-[var(--c3-style-basic-border-border)]">
      {STEPS.map((label, i) => (
        <button
          key={label}
          type="button"
          disabled={i > reached}
          aria-current={i === step ? 'step' : undefined}
          onClick={() => onJump(i)}
          className={cn(
            '-mb-px border-b-2 pt-3 pb-3 text-sm font-medium whitespace-nowrap',
            i === step ? 'border-[var(--c3-style-basic-border-accent)] text-[var(--c3-style-basic-fg-primary)]' : 'border-transparent',
            i !== step && (i <= reached ? 'text-[var(--c3-style-basic-fg-secondary)] hover:text-[var(--c3-style-basic-fg-primary)]' : 'cursor-default text-[var(--c3-style-basic-fg-secondary)] opacity-50'),
          )}
        >
          {`${i + 1} · ${label}`}
        </button>
      ))}
    </nav>
  );
}

const WAIT_RANGE: Record<string, string> = { '<15 min': '0-15 min', '15 min-2 h': '15 min-2 h', '2-12 h': '2-12 h', '>12 h': '12 h+' };

function PlanCard({ plan, selected, deadlineLabel, pred, fairShare, onSelect }: { plan: RunPlan; selected: boolean; deadlineLabel?: string; pred?: DurationPrediction | null; fairShare?: RuleCheck; onSelect: () => void }) {
  const label = plan.label ?? `Plan ${plan.rank}`;
  const slack = plan.deadlineSlackHours;
  const big = plan.label === 'Cheapest' && plan.estCostUnits != null ? `${formatInt(plan.estCostUnits)} units` : formatUsd(plan.estCostUsd);
  const chained = (plan.chainedJobs ?? 1) > 1;
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-[var(--ec-card-radius,8px)] border',
        selected ? 'border-[var(--c3-style-basic-border-accent)] bg-[var(--c3-style-basic-bg-success)]' : 'border-[var(--c3-style-basic-border-border)]',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--c3-style-basic-border-border)] px-5 py-4">
        <span className="truncate text-[15px] font-medium text-[var(--c3-style-basic-fg-primary)]">
          {[plan.cluster?.name ?? plan.cluster?.id, plan.slurmPartition ?? plan.partition?.name, plan.qos].filter(Boolean).join(' · ')}
        </span>
        <ToneBadge tone={LABEL_TONE[label] ?? 'neutral'}>{LABEL_TEXT[label] ?? label}</ToneBadge>
      </div>
      <div className="flex flex-1 flex-col gap-4 px-5 py-4">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[22px] font-medium tabular-nums text-[var(--c3-style-basic-fg-primary)]">{big}</span>
            <span className="rounded-full bg-[var(--c3-style-basic-bg-secondary)] px-2 text-xs leading-5">
              {plan.label === 'Cheapest' ? `≈ ${formatUsd(plan.estCostUsd)}` : `${formatInt(plan.estCostUnits)} units`}
            </span>
          </div>
          <div className={cn('mt-1 text-xs', muted)}>
            {plan.costPerGpuHourUsd != null ? `${formatUsd(plan.costPerGpuHourUsd)} per GPU-hour` : 'Charged to the lab allocation'}
            {plan.preemptionRisk ? ` · ${Math.round(plan.preemptionRisk * 100)}% preemption risk` : ''}
          </div>
        </div>
        <KV
          labelWidth="w-24"
          rows={[
            ['GPUs', `${plan.gpus ?? 0} × ${plan.gpuType?.id ?? 'CPU'} · ${plan.nodes ?? 1} node${(plan.nodes ?? 1) > 1 ? 's' : ''}`],
            ['Jobs', chained ? `${plan.chainedJobs} × ${formatDuration(plan.walltimeHours)}, chained` : `1 × ${formatDuration(plan.walltimeHours)}`],
            [
              'Runtime',
              <span key="rt" className="flex flex-col gap-1">
                <span>
                  {plan.estDurationP90Hours != null
                    ? `P50 ${formatDuration(plan.estDurationHours)} · P90 ${formatDuration(plan.estDurationP90Hours)}`
                    : pred?.estDurationHours != null && pred?.p90DurationHours != null
                      ? `P50 ${formatDuration(pred.estDurationHours)} · P90 ${formatDuration(pred.p90DurationHours as number)}`
                      : `${formatDuration(plan.estDurationHours)} predicted`}
                </span>
                <ModelProvenance
                  name="AnvilRuntimeQ50Q90"
                  provenance={provenanceFor(plan, 'AnvilRuntimeQ50Q90')}
                  support={pred?.sampleSize != null ? `${formatInt(pred.sampleSize as number)} jobs` : undefined}
                  extra={typeof pred?.explanation === 'string' ? pred.explanation : undefined}
                />
              </span>,
            ],
            [
              'Queue wait',
              <span key="w" className="flex flex-col gap-1">
                <span>
                  {plan.estWaitP90Hours != null ? `P50 ${formatDuration(plan.estWaitHours)} · P90 ${formatDuration(plan.estWaitP90Hours)}` : `~${formatDuration(plan.estWaitHours)}`}
                  {plan.estWaitP90Hours == null && plan.waitBucket ? <span className={muted}>{` (P50-P90 ${WAIT_RANGE[plan.waitBucket] ?? plan.waitBucket})`}</span> : null}
                </span>
                <ModelProvenance name="AnvilQueueWaitQ50Q90" provenance={provenanceFor(plan, 'AnvilQueueWaitQ50Q90')} confidence="low" extra={plan.waitReason} />
              </span>,
            ],
            [
              'GPU shape',
              <span key="g" className="flex flex-col gap-1">
                <span title={plan.shapeReason}>{plan.gpuMemNeedGb ? `Needs ~${formatInt(plan.gpuMemNeedGb)} GB VRAM · fits ${plan.gpuType?.id ?? ''}` : `${plan.gpus ?? 0} × ${plan.gpuType?.id ?? 'CPU'}`}</span>
                <ModelProvenance name="GPUShapeAdvisor" provenance={provenanceFor(plan, 'GPUShapeAdvisor')} extra={plan.shapeReason} />
              </span>,
            ],
            ...(plan.memRequestGb
              ? ([
                  [
                    'Host memory',
                    <span key="hm" className="flex flex-col gap-1">
                      <span>{`--mem ${formatInt(plan.memRequestGb)} GB (P90 of similar jobs)`}</span>
                      <ModelProvenance name="AnvilHostMemoryQ50Q90" provenance={provenanceFor(plan, 'AnvilHostMemoryQ50Q90')} />
                    </span>,
                  ],
                ] as [React.ReactNode, React.ReactNode][])
              : []),
            ...(fairShare
              ? ([
                  [
                    'Fair share',
                    <span key="fs" className="flex flex-col gap-1">
                      <span className={fairShare.outcome === 'PASS' ? undefined : 'text-[var(--c3-style-basic-fg-warning)]'}>{fairShare.outcome === 'PASS' ? 'Within the lab’s share' : 'Lab above share: lower launch priority'}</span>
                      <ModelProvenance name="LabFairShareAllocator" provenance={provenanceFor(plan, 'LabFairShareAllocator')} extra={fairShare.message} />
                    </span>,
                  ],
                ] as [React.ReactNode, React.ReactNode][])
              : []),
            [
              'Finishes',
              <span key="f">
                {plan.finishBy ? formatShortDate(plan.finishBy) : '—'}
                {slack != null && (
                  <span className={slack >= 0 ? 'text-[var(--c3-style-basic-fg-success)]' : 'text-[var(--c3-style-basic-fg-danger)]'}>
                    {slack >= 0 ? ` · ${formatDuration(slack)} of slack` : ` · misses ${deadlineLabel ?? 'deadline'} by ${formatDuration(-slack)}`}
                  </span>
                )}
              </span>,
            ],
          ]}
        />
        {plan.rationale && <p className={cn('line-clamp-4 text-[13px]', muted)} title={plan.rationale}>{plan.rationale}</p>}
        <Button className="mt-auto w-full" variant={selected ? 'solid' : 'outline'} appearance={selected ? 'accent' : 'secondary'} leadingIcon={selected ? <Check /> : undefined} onClick={onSelect}>
          {selected ? 'Selected' : 'Select'}
        </Button>
      </div>
    </div>
  );
}

const PlanRun: React.FC = () => {
  const navigate = useNavigate();
  const { reportError } = useErrorBoundary();
  const { lab, labId, error: labError } = useCurrentLab();
  const lr = useLabRole();
  const shell = useAppShell();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<PlanForm>(EMPTY_FORM);
  const [request, setRequest] = useState<RunRequest | null>(null);
  const [status, setStatus] = useState<RunRequestStatus>('DRAFT');
  const [checks, setChecks] = useState<RuleCheck[]>([]);
  const [plans, setPlans] = useState<RunPlan[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showRuledOut, setShowRuledOut] = useState(false);
  const [showPassed, setShowPassed] = useState(false);
  const [preds, setPreds] = useState<Record<string, DurationPrediction | null>>({});
  const plansRef = useRef<HTMLDivElement>(null);
  const scriptRef = useRef<HTMLDivElement>(null);

  const refs = useLoad(() => (labId ? Promise.all([fetchProjects(labId), fetchGpuTypes(), fetchClusters()]) : null), [labId]);
  const [projects, gpuTypes, clusters] = refs.data ?? [[], [], []];
  const project = projects.find((p) => p.id === form.projectId);
  const plan = plans?.find((p) => p.id === selected) ?? null;
  const reached = plan ? 3 : plans ? 2 : request ? 1 : 0;

  // Deep link from the advisor / elsewhere: /plan?runRequest=<id>&plan=<planId> opens that saved request at step 3.
  const [params] = useSearchParams();
  const linkedRequest = params.get('runRequest');
  const linkedPlan = params.get('plan');
  const loadedLink = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedRequest || loadedLink.current === linkedRequest) return;
    loadedLink.current = linkedRequest;
    guard('check', async () => {
      const rr = await getRunRequest(linkedRequest);
      if (!rr) throw new Error(`Run request ${linkedRequest} was not found.`);
      // A request from another lab (e.g. an advisor link): switch the demo lab so names, rules and budgets match it.
      if (rr.lab?.id && rr.lab.id !== labId) shell.setLabId(rr.lab.id);
      const [cs, ps] = await Promise.all([fetchChecks(rr.id), fetchPlans(rr.id)]);
      setRequest(rr);
      setStatus(rr.status ?? 'DRAFT');
      setForm({
        ...EMPTY_FORM,
        description: rr.description ?? '',
        name: rr.name ?? '',
        projectId: rr.project?.id ?? null,
        workloadType: rr.workloadType ?? EMPTY_FORM.workloadType,
        modelParamsB: rr.modelParamsB != null ? String(rr.modelParamsB) : '',
        datasetGb: rr.datasetGb != null ? String(rr.datasetGb) : '',
        estGpuHours: rr.estGpuHours != null ? String(rr.estGpuHours) : '',
        gpuTypeId: rr.requestedGpuType?.id ?? null,
        gpus: rr.requestedGpus != null ? String(rr.requestedGpus) : '',
        walltimeHours: rr.requestedWalltimeHours != null ? String(rr.requestedWalltimeHours) : '',
        clusterId: rr.requestedCluster?.id ?? null,
        deadline: toLocalInput(rr.deadline),
      });
      setChecks(cs);
      setPlans(ps);
      const sel = ps.find((p) => p.id === linkedPlan) ?? ps.find((p) => p.label === 'Balanced') ?? ps[0];
      setSelected(sel?.id ?? null);
      setStep(sel && linkedPlan ? 3 : ps.length ? 2 : 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRequest, linkedPlan]);

  useEffect(() => {
    if (step === 2) plansRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (step === 3) scriptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [step]);

  const guard = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
      reportError(err);
    } finally {
      setBusy(null);
    }
  };

  /** Describe → save request → rule checks → ranked plans, in one go (the user can still step back). */
  const plan3 = () =>
    guard('check', async () => {
      if (!labId) return;
      const body = { ...toRunRequest(form, labId), ...(lr.user ? { submittedBy: { id: lr.user.id } } : {}) };
      let rr: RunRequest;
      if (request) {
        await updateRunRequest({ ...body, id: request.id });
        rr = { ...request, ...body };
      } else {
        rr = await createRunRequest(body);
      }
      setRequest(rr);
      setPlans(null);
      setSelected(null);
      const cs = await checkRules(rr.id);
      setChecks(cs);
      setStep(1);
      const ps = await recommendPlans(rr.id);
      setPlans(ps);
      setPreds({});
      Promise.all(
        ps.map((p) =>
          predictDuration(rr.workloadType ?? 'TRAINING', p.gpuType?.id ?? null, p.gpus ?? 1, rr.modelParamsB ?? 1)
            .then((d) => [p.id, d] as const)
            .catch(() => [p.id, null] as const),
        ),
      ).then((rows) => setPreds(Object.fromEntries(rows)));
      setStatus((await getRunRequestStatus(rr.id).catch(() => null)) ?? (ps.length ? 'PLANNED' : 'REJECTED'));
      setSelected(ps.find((p) => p.label === 'Balanced')?.id ?? ps[0]?.id ?? null);
      if (ps.length) setStep(2);
    });

  const submit = () =>
    guard('submit', async () => {
      if (!request || !selected) return;
      const job = await submitWithApproval(request.id, selected, lr.canApprove);
      navigate(job?.id ? `/runs/${encodeURIComponent(job.id)}` : '/runs');
    });

  const reset = () => {
    setForm(EMPTY_FORM);
    setRequest(null);
    setStatus('DRAFT');
    setChecks([]);
    setPlans(null);
    setSelected(null);
    setError(null);
    setStep(0);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plan?.sbatchScript ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const fails = checks.filter((c) => c.outcome === 'FAIL');
  const fairShare = checks.find((c) => c.ruleKind === 'FAIRSHARE_CAP' && c.outcome !== 'PASS') ?? checks.find((c) => c.ruleKind === 'FAIRSHARE_CAP');
  const issues = checks.filter((c) => c.outcome !== 'PASS');
  const passed = checks.filter((c) => c.outcome === 'PASS');
  const warns = checks.filter((c) => c.outcome === 'WARN');
  const ruledOut = checks.filter((c) => c.outcome !== 'PASS' && /rules out/i.test(c.message ?? ''));
  const runName = (request?.name ?? form.name) || 'new run';
  const chained = plan?.chainedJobs ?? 1;

  return (
    <PageFrame
      title={
        <span>
          <span className={muted}>Launch planner / </span>
          {runName}
        </span>
      }
      description={`Describe the run. EasyCompute checks it against Purdue and ${lab?.name ?? 'lab'} rules, ranks configurations, and submits for you.`}
      badges={<StatusBadge kind="runRequestStatus" value={status} />}
      actions={
        request ? (
          <Button variant="outline" appearance="secondary" leadingIcon={<RotateCcw />} disabled={Boolean(busy)} onClick={reset}>
            New request
          </Button>
        ) : undefined
      }
    >
      <Stepper step={step} reached={reached} onJump={setStep} />
      {(labError || refs.error) && <ErrorState message={`Could not load lab data: ${labError ?? refs.error}`} onRetry={refs.reload} />}
      {error && <ErrorState message={error} />}

      {!refs.data && !refs.error && !labError ? (
        <LoadingState label="Loading lab context…" />
      ) : step === 0 || !request ? (
        <DescribeStep form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} projects={projects} gpuTypes={gpuTypes} clusters={clusters} busy={busy === 'check'} onNext={plan3} />
      ) : (
        <>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <SectionCard
              title="Run request"
              actions={
                <span className="flex items-center gap-3">
                  <HeadNote>{`${lab?.name ?? ''} · ${formatDateTime(request.createdAt)}`}</HeadNote>
                  <Button variant="ghost" appearance="secondary" size="sm" leadingIcon={<Pencil />} onClick={() => setStep(0)}>
                    Edit
                  </Button>
                </span>
              }
            >
              <div className="flex flex-col gap-5">
                {request.description && (
                  <p className="rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-border)] px-4 py-3 text-sm text-[var(--c3-style-basic-fg-primary)]">
                    {request.description}
                  </p>
                )}
                <KV
                  rows={[
                    ['Workload', request.workloadType ? WORKLOAD_LABEL[request.workloadType] : '—'],
                    ['Model', request.modelParamsB ? `${request.modelParamsB} B params` : '—'],
                    ['Data', request.datasetGb ? `${formatInt(request.datasetGb)} GB` : '—'],
                    ['Compute estimate', request.estGpuHours ? `${formatInt(request.estGpuHours)} A100-hours` : 'Predicted from past runs'],
                    ['Resources', [request.requestedGpus && `${request.requestedGpus} ×`, request.requestedGpuType?.id ?? (request.requestedGpus ? 'any GPU' : 'Planner chooses'), request.requestedWalltimeHours && `· ${formatDuration(request.requestedWalltimeHours)}`].filter(Boolean).join(' ')],
                    [
                      'Deadline',
                      request.deadline ? (
                        <span key="d" className="flex items-center gap-2">
                          {`${project?.deadlineLabel ?? 'Deadline'} · ${formatShortDate(request.deadline)}`}
                          {project?.priority && <ToneBadge tone="accent">{`P${project.priority}`}</ToneBadge>}
                        </span>
                      ) : (
                        'None'
                      ),
                    ],
                  ]}
                />
              </div>
            </SectionCard>

            <SectionCard
              title="Rule checks"
              actions={
                busy === 'check' && checks.length === 0 ? (
                  <ModelComputing name="ClusterPolicyEngine" detail="is checking rules…" />
                ) : fails.length && !plans?.length ? (
                  <ToneBadge tone="bad">{`${fails.length} blocking`}</ToneBadge>
                ) : (
                  <ToneBadge tone="good">{warns.length ? `Ready · ${warns.length} to review` : 'Ready to submit'}</ToneBadge>
                )
              }
            >
              {checks.length > 0 && (
                <div className="mb-3">
                  <ModelProvenance name="ClusterPolicyEngine" provenance={provenanceFor(checks[0], 'ClusterPolicyEngine')} support={`${checks.length} rules checked`} />
                </div>
              )}
              <ul className="flex flex-col">
                {issues.map((c) => (
                  <CheckRow key={c.id} kind={checkKind(c)} title={c.title ?? c.policy?.title ?? c.ruleKind ?? 'Rule'} detail={<span className="line-clamp-3" title={c.message}>{c.message}</span>} right={<CheckTag c={c} />} />
                ))}
                {(showPassed ? passed : passed.slice(0, 3)).map((c) => (
                  <CheckRow key={c.id} kind="ok" title={c.title ?? c.policy?.title ?? c.ruleKind ?? 'Rule'} right={<CheckTag c={c} />} />
                ))}
                {checks.length === 0 && <li className={cn('py-4 text-sm', muted)}>No rules apply to this request.</li>}
              </ul>
              {passed.length > 3 && (
                <button type="button" onClick={() => setShowPassed((v) => !v)} className="mt-3 flex items-center gap-1 text-[13px] text-[var(--c3-style-basic-fg-accent)] hover:underline">
                  <ChevronRight className={cn('size-3.5 transition-transform', showPassed && 'rotate-90')} aria-hidden />
                  {showPassed ? 'Hide passed rules' : `${passed.length - 3} more rules passed`}
                </button>
              )}
            </SectionCard>
          </div>

          <div ref={plansRef} className="flex scroll-mt-4 flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-medium text-[var(--c3-style-basic-fg-primary)]">Ranked configurations</h2>
              <span className="flex flex-wrap items-center gap-2">
                <HeadNote>Ranked by deadline slack, then lab cost, then queue wait</HeadNote>
                <ModelProvenance name="AnvilHostMemoryQ50Q90" extra="Host memory request sized from P90 of similar jobs (--mem in the script)." />
              </span>
            </div>
            {plans === null ? (
              <SectionCard>
                <ModelsComputing names={['AnvilRuntimeQ50Q90', 'AnvilQueueWaitQ50Q90', 'AnvilHostMemoryQ50Q90', 'GPUShapeAdvisor', 'LabFairShareAllocator']} />
              </SectionCard>
            ) : plans.length === 0 ? (
              <SectionCard>
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <p className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">No configuration satisfies every blocking rule</p>
                  <p className={cn('max-w-md text-[13px]', muted)}>Relax the GPU count, walltime or deadline, or ask your PI to approve an exception.</p>
                  <Button variant="outline" appearance="secondary" size="sm" leadingIcon={<Pencil />} onClick={() => setStep(0)}>
                    Edit request
                  </Button>
                </div>
              </SectionCard>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {plans.map((p) => (
                  <PlanCard
                    key={p.id}
                    plan={p}
                    pred={preds[p.id]}
                    fairShare={fairShare}
                    selected={p.id === selected}
                    deadlineLabel={project?.deadlineLabel}
                    onSelect={() => {
                      setSelected(p.id);
                      setStep(3);
                    }}
                  />
                ))}
              </div>
            )}
            {plans && plans.length > 0 && ruledOut.length > 0 && (
              <div className="rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-border)]">
                <button type="button" aria-expanded={showRuledOut} onClick={() => setShowRuledOut((v) => !v)} className="flex w-full items-center gap-2 px-5 py-3 text-left text-sm">
                  <ChevronRight className={cn('size-4 transition-transform', showRuledOut && 'rotate-90')} aria-hidden />
                  {`${ruledOut.length} rule${ruledOut.length === 1 ? '' : 's'} ruled configurations out`}
                </button>
                {showRuledOut && (
                  <ul className="flex flex-col px-5 pb-4">
                    {ruledOut.map((c) => (
                      <CheckRow key={c.id} kind="info" title={c.title ?? c.ruleKind} detail={c.message} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {plan && (
            <div ref={scriptRef} className="flex scroll-mt-4 flex-col gap-4">
              <SectionCard
                title="Job script EasyCompute will submit"
                actions={
                  <span className="flex items-center gap-2">
                    {chained > 1 && <ToneBadge tone="good">{`Job 1 of ${chained}`}</ToneBadge>}
                    <Button variant="outline" appearance="secondary" size="sm" leadingIcon={copied ? <Check /> : <Copy />} onClick={copy}>
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </span>
                }
              >
                <ScriptBlock script={plan.sbatchScript ?? '# The planner did not return a script for this plan.'} />
              </SectionCard>

              <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-4 rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-accent)] bg-[var(--c3-style-basic-bg-primary)] px-5 py-4 shadow-lg">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">
                    {`Submit to ${plan.cluster?.name ?? plan.cluster?.id} · ${plan.slurmPartition ?? plan.partition?.name ?? ''}${plan.account ? ` as ${plan.account}` : ''}`}
                  </div>
                  <div className={cn('text-[13px]', muted)}>
                    {chained > 1
                      ? `Job 1 is queued now; jobs 2-${chained} are chained with afterok and resume from checkpoint. Live monitoring starts automatically.`
                      : `Expected to finish ${plan.finishBy ? formatDateTime(plan.finishBy) : 'soon'} for about ${formatUsd(plan.estCostUsd)}. Live monitoring starts automatically.`}
                  </div>
                </div>
                <Button variant="outline" appearance="secondary" onClick={() => setStep(2)}>
                  Change configuration
                </Button>
                <Button leadingIcon={<Rocket />} loading={busy === 'submit'} onClick={submit}>
                  {chained > 1 ? `Submit ${chained} jobs` : 'Submit run'}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </PageFrame>
  );
};

export default PlanRun;
