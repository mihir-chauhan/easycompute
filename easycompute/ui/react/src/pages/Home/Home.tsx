/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, File, FileCode, FileCog, FileJson, FileSpreadsheet, FileText, Plus, Rocket, X } from 'lucide-react';

import { BrandMark, errorMessage, ROLE_LABEL, useAppShell, type EcRole } from '@/components/app';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { checkRules, createRunRequest, extractConstraints, fetchJobMetrics, fetchProjects, getJob, getLabSummary, recommendPlans, submitWithApproval } from '@/features/lab/api';
import { LiveBadge, liveJob, mergeSnap, SimNote, useLiveSnapshot, useNow } from '@/features/lab/live';
import { formatDuration, formatInt, formatUsd, WORKLOAD_LABEL } from '@/features/lab/format';
import { ModelComputing, ModelProvenance, type ModelName } from '@/features/lab/models';
import { costPhrase, doneBy, fixesOf, pickPlan, PREFERENCE_LABEL, preferenceFrom, settingsOf, type Preference } from '@/features/lab/oneBox';
import Ribbon, { type RibbonHandle } from '@/features/lab/Ribbon';
import type { Job, LabConstraints, RuleCheck, RunPlan, RunRequest } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLoad } from '@/features/lab/useLoad';
import { cn } from '@/lib/utils';
import { parseDescription } from '@/pages/PlanRun/planForm';

type Stage = { model: ModelName; text: string };

const GLASS =
  'rounded-[14px] border border-[var(--ec-line-2,var(--c3-style-basic-border-border))] bg-[color-mix(in_srgb,var(--c3-style-basic-bg-primary)_72%,transparent)] backdrop-blur-[14px]';
const BTN = 'inline-flex h-[42px] items-center justify-center gap-2.5 rounded-[10px] border px-[18px] font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-50';
const BTN_PRI = `${BTN} border-[var(--ec-accent-hi,var(--c3-style-basic-bg-accent-inverse))] bg-[var(--ec-accent-hi,var(--c3-style-basic-bg-accent-inverse))] text-[var(--ec-on-accent,#132010)] hover:brightness-110`;
const BTN_SEC = `${BTN} border-[var(--c3-style-basic-border-border)] bg-transparent text-[var(--c3-style-basic-fg-primary)] hover:bg-[var(--c3-style-basic-bg-secondary)]`;
const DOT = 'inline-block size-[7px] shrink-0 rounded-full bg-[var(--ec-accent-hi,var(--c3-style-basic-fg-success))]';

const EXAMPLE =
  'Fine-tune Llama-3-8B with LoRA on our 40 MB dataset, done before the RSS deadline of Jan 2nd. Use free compute if there is any, and then the cost-based compute';

/** Icon for an attached file chip, by extension (demo only: files are never uploaded). */
const fileIcon = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'py' || ext === 'ipynb' || ext === 'sh') return FileCode;
  if (ext === 'yaml' || ext === 'yml' || ext === 'toml') return FileCog;
  if (ext === 'json') return FileJson;
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx') return FileSpreadsheet;
  if (ext === 'pdf' || ext === 'md' || ext === 'txt') return FileText;
  return File;
};

/** Days until an ISO date, for the "Done by" phrase. */
const daysTo = (iso?: string) => (iso ? Math.round((new Date(iso).getTime() - Date.now()) / 86400000) : null);

const Home: React.FC = () => {
  const navigate = useNavigate();
  const { reportError } = useErrorBoundary();
  const shell = useAppShell();
  const { lab, labId } = useCurrentLab();
  const ribbon = useRef<RibbonHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [text, setText] = useState(EXAMPLE);
  const [files, setFiles] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<RunRequest | null>(null);
  const [checks, setChecks] = useState<RuleCheck[]>([]);
  const [plans, setPlans] = useState<RunPlan[]>([]);
  const [pref, setPref] = useState<Preference>('balanced');
  const [showHow, setShowHow] = useState(false);
  const [showChange, setShowChange] = useState(false);
  const [change, setChange] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState<Job | null>(null);

  const summary = useLoad(() => (labId ? getLabSummary(labId) : null), [labId]);
  const projects = useLoad(() => (labId ? fetchProjects(labId) : null), [labId]);
  const allocations = summary.data?.allocations ?? [];
  const budgetLeft = summary.data?.kpis.allocationRemainingUsd;

  const picked = useMemo(() => pickPlan(plans, pref), [plans, pref]);
  // After launch: follow the job live (queue → node placement → metrics).
  const follow = useLoad(() => (launched ? Promise.all([getJob(launched.id), fetchJobMetrics(launched.id)]) : null), [launched?.id], 5000);
  const now = useNow(1000);
  const snap = useLiveSnapshot(launched ? labId : null);
  const sj = launched ? snap.byJob[launched.id] : undefined;
  const base = follow.data?.[0] ? mergeSnap(follow.data[0], sj) : launched;
  const lj = base ? liveJob(base, sj ? snap.updatedAt : follow.updatedAt, now, sj?.progressPerRealSec) : null;
  const lastMetric = sj?.latest ?? follow.data?.[1]?.at(-1);
  const plan = picked.plan;
  const busy = stage !== null;

  useEffect(() => {
    document.title = 'EasyCompute';
  }, []);

  /** Text (+ file names) → LabContextExtractor → RunRequest → ClusterPolicyEngine → plan ranking. */
  const run = async (description: string, prefOverride?: Preference) => {
    if (!labId || !description.trim()) return;
    ribbon.current?.surge(2400);
    setError(null);
    setLaunched(null);
    setShowHow(false);
    setShowChange(false);
    setPlans([]);
    setChecks([]);
    try {
      // Attached files are demo-only chips: they are never uploaded or sent to the backend.
      const full = description;
      setStage({ model: 'LabContextExtractor', text: 'is reading your request and lab context…' });
      const ctx = await Promise.race<LabConstraints | null>([
        extractConstraints(labId, full).catch(() => null),
        new Promise<null>((r) => window.setTimeout(() => r(null), 12000)),
      ]);
      const parsed = parseDescription(description, projects.data ?? [], []);
      const now = Date.now();
      const textDeadline = ctx?.deadlines?.map((d) => d.date).filter((d) => d && new Date(d).getTime() > now).sort()[0];
      const project = (projects.data ?? []).find((p) => p.id === parsed.projectId) ?? (projects.data ?? []).filter((p) => p.deadline && new Date(p.deadline).getTime() > now).sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''))[0];
      // An explicit date in the request wins, then one the extractor found, then the matched project's deadline.
      const deadline = (parsed.deadline ? new Date(parsed.deadline).toISOString() : null) ?? textDeadline ?? project?.deadline;
      const num = (v?: string) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
      const rr = await createRunRequest({
        lab: { id: labId },
        project: project ? { id: project.id } : undefined,
        submittedBy: shell.user ? { id: shell.user.id } : undefined,
        name: parsed.name || `run-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`,
        description: full,
        workloadType: parsed.workloadType ?? project?.workloadType ?? 'TRAINING',
        modelParamsB: num(parsed.modelParamsB),
        datasetGb: num(parsed.datasetGb),
        requestedGpus: num(parsed.gpus),
        requestedWalltimeHours: num(parsed.walltimeHours),
        deadline,
      });
      setRequest(rr);
      setStage({ model: 'ClusterPolicyEngine', text: 'is checking every Purdue, cluster and lab rule…' });
      const cs = await checkRules(rr.id);
      setChecks(cs);
      setStage({ model: 'AnvilRuntimeQ50Q90', text: `passed ${cs.length} rules · comparing the ways to run it…` });
      const ps = await recommendPlans(rr.id);
      setPlans(ps);
      const pctx = preferenceFrom(description) ?? (ctx?.preferences?.preemptibleOk ? 'hours' : null);
      setPref(prefOverride ?? pctx ?? 'balanced');
      if (!ps.length) setError(`No configuration passes every rule (${cs.filter((c) => c.outcome === 'FAIL').map((c) => c.title).join('; ')}). Try fewer GPUs, a shorter run or a later deadline.`);
    } catch (err) {
      setError(errorMessage(err));
      reportError(err);
    } finally {
      setStage(null);
    }
  };

  const launch = async () => {
    if (!request || !plan) return;
    setLaunching(true);
    setError(null);
    ribbon.current?.surge(2600);
    try {
      setLaunched(await submitWithApproval(request.id, plan.id, shell.can('approve_requests')));
    } catch (err) {
      setError(errorMessage(err));
      reportError(err);
    } finally {
      setLaunching(false);
    }
  };

  const applyChange = (e?: React.FormEvent) => {
    e?.preventDefault();
    const p = preferenceFrom(change);
    if (p && change.trim().split(/\s+/).length <= 4) {
      setPref(p);
    } else if (change.trim()) {
      setText((t) => `${t.trim()} ${change.trim()}`);
      run(`${text.trim()} ${change.trim()}`, p ?? undefined);
    }
    setChange('');
    setShowChange(false);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((f) => [...f, ...Array.from(list).map((x) => x.name)]);
  };

  const reset = () => {
    setLaunched(null);
    setPlans([]);
    setRequest(null);
    setText('');
    setFiles([]);
  };

  const failing = checks.filter((c) => c.outcome === 'FAIL').length;
  const warns = checks.filter((c) => c.outcome === 'WARN').length;
  const settings = plan ? settingsOf(plan, allocations) : [];
  const fixes = plan ? fixesOf(plan, checks) : [];
  const days = daysTo(plan?.finishBy);
  const named = /\b([A-Z][\w-]*(?:\s+[A-Z0-9][\w-]*)?)\s+deadline\b/.exec(request?.description ?? '');
  const deadlineName = named ? `the ${named[1]} deadline` : 'your deadline';

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--c3-style-basic-bg-page)] text-[var(--c3-style-basic-fg-primary)]">
      <section className="relative isolate min-h-[860px]">
        <Ribbon ref={ribbon} className="absolute inset-0 -z-20 block size-full" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_55%_at_50%_50%,color-mix(in_srgb,var(--c3-style-basic-bg-page)_90%,transparent)_0%,color-mix(in_srgb,var(--c3-style-basic-bg-page)_55%,transparent)_60%,color-mix(in_srgb,var(--c3-style-basic-bg-page)_20%,transparent)_100%)] md:bg-[radial-gradient(ellipse_48%_60%_at_50%_50%,color-mix(in_srgb,var(--c3-style-basic-bg-page)_92%,transparent)_0%,color-mix(in_srgb,var(--c3-style-basic-bg-page)_68%,transparent)_45%,transparent_100%)]"
        />

        <header className="relative z-10 flex h-[72px] items-center gap-7 border-b border-[var(--c3-style-basic-border-border)] bg-[color-mix(in_srgb,var(--c3-style-basic-bg-page)_72%,transparent)] px-4 backdrop-blur-md sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 text-[17px] font-semibold text-[var(--c3-style-basic-fg-primary)]">
            <BrandMark />
            EasyCompute
          </Link>
          <nav className="hidden gap-7 font-medium md:flex">
            <Link to="/runs" className="hover:text-[var(--c3-style-basic-fg-primary)]">
              My runs
            </Link>
            <Link to="/dashboard" className="hover:text-[var(--c3-style-basic-fg-primary)]">
              Dashboard
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden h-[30px] items-center gap-2 rounded-full border border-[var(--c3-style-basic-border-border)] bg-[color-mix(in_srgb,black_35%,transparent)] px-3 text-[13px] sm:inline-flex">
              <span className={DOT} />
              {`${lab?.name ?? 'Your lab'}${budgetLeft != null ? ` · ${formatUsd(budgetLeft)} left` : ''}`}
            </span>
            <DropdownMenu align="end">
              <DropdownMenuTrigger>
                <button
                  type="button"
                  aria-label="Account and role"
                  className="grid size-[30px] place-items-center rounded-full bg-[linear-gradient(135deg,#8b7cf6,#c06bd6)] text-[13px] font-semibold text-white"
                >
                  {(shell.user?.name ?? 'You').slice(0, 1).toUpperCase()}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuLabel>{shell.user ? `${shell.user.name} · ${ROLE_LABEL[shell.role]}` : 'Demo role'}</DropdownMenuLabel>
              {(['PI', 'MEMBER', 'UNIVERSITY_ADMIN'] as EcRole[]).map((r) => (
                <DropdownMenuItem key={r} value={r} label={ROLE_LABEL[r]} trailingIcon={shell.role === r ? <Check /> : undefined} onSelect={() => shell.setRole(r)} />
              ))}
              <DropdownMenuItem value="__dash" label="Open dashboard" onSelect={() => navigate('/dashboard')} />
            </DropdownMenu>
          </div>
        </header>

        <div className="mx-auto max-w-[1240px] px-4 pt-16 pb-14 sm:px-6 md:pt-24 md:pb-20">
          <div className="mx-auto flex max-w-[660px] flex-col items-stretch gap-7 text-center">
            <h1 className="m-0 text-[38px] leading-[42px] font-medium tracking-[-0.04em] text-balance text-[var(--c3-style-basic-fg-primary)] sm:text-[46px] sm:leading-[50px] md:text-[76px] md:leading-[78px]">
              Say what you want to run.
            </h1>
            <p className="mx-auto -mt-2 max-w-[40ch] text-[19px] leading-7 text-[var(--c3-style-basic-fg-secondary)]">
              EasyCompute picks the cluster, checks every Purdue and lab rule, and launches it for you.
            </p>

            <div
              className={cn(GLASS, 'text-left', drag && 'border-dashed border-[var(--ec-accent-hi,var(--c3-style-basic-border-accent))]')}
              onDragEnter={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                addFiles(e.dataTransfer?.files ?? null);
              }}
            >
              <textarea
                aria-label="Describe your run"
                className="block min-h-24 w-full resize-none border-0 bg-transparent px-[18px] pt-[18px] pb-1.5 text-base leading-6 text-[var(--c3-style-basic-fg-primary)] outline-none placeholder:text-[var(--c3-style-basic-fg-secondary)]"
                placeholder="What are you training, and when is it due?"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(text);
                }}
              />
              <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2 pb-2.5">
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }} />
                <button
                  type="button"
                  aria-label="Add files"
                  onClick={() => fileInput.current?.click()}
                  className="grid size-[30px] place-items-center rounded-full border border-[var(--c3-style-basic-border-border)] text-[var(--c3-style-basic-fg-secondary)] hover:text-[var(--c3-style-basic-fg-primary)]"
                >
                  <Plus className="size-4" />
                </button>
                {files.map((f, i) => {
                  const Icon = fileIcon(f);
                  return (
                    <span key={`${f}-${i}`} className="inline-flex max-w-56 items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,white_7%,transparent)] pr-1 pl-2.5 text-xs leading-[26px]">
                      <Icon className="size-3.5 shrink-0 text-[var(--c3-style-basic-fg-secondary)]" aria-hidden />
                      <span className="truncate" title={f}>
                        {f}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${f}`}
                        onClick={() => setFiles((xs) => xs.filter((_, k) => k !== i))}
                        className="grid size-5 place-items-center rounded-full text-[var(--c3-style-basic-fg-secondary)] hover:bg-[color-mix(in_srgb,white_10%,transparent)] hover:text-[var(--c3-style-basic-fg-primary)]"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
                {text !== EXAMPLE && (
                  <button type="button" className="text-xs text-[var(--c3-style-basic-fg-secondary)] underline underline-offset-2" onClick={() => setText(EXAMPLE)}>
                    Try an example
                  </button>
                )}
                <button type="button" className={cn(BTN_PRI, 'ml-auto')} disabled={busy || !text.trim() || !labId} onClick={() => run(text)}>
                  Plan it <ArrowRight className="size-4" />
                </button>
              </div>
            </div>

            {stage && (
              <div className="flex items-center justify-center">
                <ModelComputing name={stage.model} detail={stage.text} />
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm text-[var(--c3-style-basic-fg-danger)]">
                {error}
              </p>
            )}

            {plan && !launched && !busy && (
              <div className={cn(GLASS, 'flex flex-col gap-4 p-[22px]')}>
                <div className="flex items-center justify-center gap-2 text-[13px] text-[var(--c3-style-basic-fg-secondary)]">
                  <span className={DOT} />
                  {failing ? 'Ready: every blocking rule is routed around' : 'Ready to launch'}
                </div>
                <p className="m-0 text-2xl leading-8 font-medium tracking-[-0.01em] text-balance text-[var(--c3-style-basic-fg-primary)]">
                  {`${plan.cluster?.name ?? plan.cluster?.id}${plan.qos && plan.qos !== 'normal' ? ` ${plan.qos}` : ''}, ${plan.gpus ?? 0} ${plan.gpuType?.id?.split('-')[0] ?? ''} GPU${plan.gpus === 1 ? '' : 's'}. `}
                  <span className="text-[var(--c3-style-basic-fg-secondary)]">
                    <b className="font-medium whitespace-nowrap">{`Done ${doneBy(plan)}`}</b>
                    {days != null && days >= 0 ? ` (${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`})` : ''}
                    {plan.deadlineSlackHours != null ? (plan.deadlineSlackHours >= 0 ? `, ${formatDuration(plan.deadlineSlackHours)} before ${deadlineName}.` : `, after ${deadlineName}.`) : '.'}
                  </span>{' '}
                  {costPhrase(plan, allocations)}
                </p>
                {picked.note && <p className="text-[13px] text-[var(--c3-style-basic-fg-warning)]">{picked.note}</p>}
                <div className="text-sm text-[var(--c3-style-basic-fg-secondary)]">
                  {`EasyCompute chose ${settings.length} settings and passed all ${checks.length - failing} rules${warns ? ` (${warns} with notes)` : ''}. `}
                  <button type="button" className="text-[var(--c3-style-basic-fg-primary)] underline underline-offset-[3px]" onClick={() => setShowHow((v) => !v)}>
                    {showHow ? 'Hide' : 'See how'}
                  </button>
                </div>
                {showHow && (
                  <div className="flex flex-col gap-3 border-t border-[var(--c3-style-basic-border-border)] pt-3.5">
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {settings.map(([k, v]) => (
                        <span key={k} className="rounded-md bg-[color-mix(in_srgb,white_6%,transparent)] px-[9px] text-xs leading-6 whitespace-nowrap">
                          <i className="mr-1.5 text-[var(--c3-style-basic-fg-secondary)] not-italic">{k}</i>
                          {v}
                        </span>
                      ))}
                    </div>
                    <div className="flex flex-col gap-1">
                      {fixes.map((f) => (
                        <p key={f} className="m-0 text-[13px] text-[var(--c3-style-basic-fg-secondary)]">
                          {f}
                        </p>
                      ))}
                    </div>
                    <div className="flex flex-wrap justify-center gap-1.5">
                      <ModelProvenance name="ClusterPolicyEngine" support={`${checks.length} rules`} />
                      <ModelProvenance name="AnvilRuntimeQ50Q90" />
                      <ModelProvenance name="AnvilQueueWaitQ50Q90" confidence="low" />
                      <ModelProvenance name="GPUShapeAdvisor" />
                      <ModelProvenance name="LabFairShareAllocator" />
                    </div>
                    <p className="m-0 text-[13px] text-[var(--c3-style-basic-fg-secondary)]">
                      {`${request?.workloadType ? WORKLOAD_LABEL[request.workloadType] : 'Run'} · ${plans.length} configurations compared · `}
                      <Link to="/plan" className="underline underline-offset-2">
                        open in the launch planner
                      </Link>
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap justify-center gap-2.5">
                  <button type="button" className={BTN_PRI} disabled={launching} onClick={launch}>
                    <Rocket className="size-4" />
                    {launching ? 'Launching…' : `Launch on ${plan.cluster?.name ?? plan.cluster?.id}`}
                  </button>
                  <button type="button" className={BTN_SEC} onClick={() => setShowChange((v) => !v)}>
                    Change something
                  </button>
                </div>
                {showChange && (
                  <form className="flex flex-wrap gap-2 border-t border-[var(--c3-style-basic-border-border)] pt-3.5" onSubmit={applyChange}>
                    <input
                      aria-label="What should be different"
                      autoComplete="off"
                      placeholder="What should be different?"
                      value={change}
                      onChange={(e) => setChange(e.target.value)}
                      className="h-[42px] min-w-0 flex-[1_1_220px] rounded-[10px] border border-[var(--c3-style-basic-border-border)] bg-[color-mix(in_srgb,black_30%,transparent)] px-3 text-[var(--c3-style-basic-fg-primary)] outline-none placeholder:text-[var(--c3-style-basic-fg-secondary)]"
                    />
                    <button type="submit" className={BTN_SEC}>
                      Update
                    </button>
                    <div className="flex w-full flex-wrap justify-center gap-1.5">
                      {(['fast', 'hours', 'free', 'balanced'] as Preference[]).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => {
                            setPref(p);
                            setShowChange(false);
                            ribbon.current?.surge(1200);
                          }}
                          className={cn(
                            'rounded-full border px-3 text-[13px] leading-7',
                            pref === p ? 'border-[var(--ec-accent-hi,var(--c3-style-basic-border-accent))] text-[var(--c3-style-basic-fg-primary)]' : 'border-[var(--c3-style-basic-border-border)]',
                          )}
                        >
                          {PREFERENCE_LABEL[p]}
                        </button>
                      ))}
                    </div>
                  </form>
                )}
              </div>
            )}

            {launched && (
              <div className={cn(GLASS, 'flex flex-col gap-4 p-[22px]')}>
                <div className="flex items-center justify-center gap-2 text-[13px] text-[var(--c3-style-basic-fg-secondary)]">
                  <span className={DOT} />
                  {`${lj?.state === 'RUNNING' ? 'Running' : 'Launched'} on ${launched.cluster?.name ?? launched.cluster?.id ?? plan?.cluster?.name ?? ''}`}
                </div>
                <p className="m-0 text-2xl leading-8 font-medium text-balance text-[var(--c3-style-basic-fg-primary)]">
                  {lj?.state === 'RUNNING'
                    ? `Running on ${lj.nodeList ?? 'its node'} as job ${lj.slurmJobId ?? lj.id}.`
                    : lj?.state === 'PENDING'
                      ? `Queued as job ${lj.slurmJobId ?? lj.id}. Starts in about ${formatDuration(Math.max(0, (plan?.estWaitHours ?? 0) - (lj.submitTime ? (now - new Date(lj.submitTime).getTime()) / 3600000 : 0)))}.`
                      : `Job ${lj?.slurmJobId ?? lj?.id} is ${String(lj?.state ?? '').toLowerCase()}.`}{' '}
                  <span className="text-[var(--c3-style-basic-fg-secondary)]">EasyCompute will only message you if something needs you.</span>
                </p>
                {lj?.state === 'RUNNING' && (
                  <div className="flex flex-wrap justify-center gap-1.5 text-xs">
                    <span className="rounded-md bg-[color-mix(in_srgb,white_6%,transparent)] px-2 leading-6 tabular-nums">{`Elapsed ${formatDuration(lj.elapsedHours)} of ${formatDuration(lj.timelimitHours)}`}</span>
                    {lastMetric?.gpuUtilPct != null && <span className="rounded-md bg-[color-mix(in_srgb,white_6%,transparent)] px-2 leading-6 tabular-nums">{`GPU util ${Math.round(lastMetric.gpuUtilPct)}%`}</span>}
                    <span className="rounded-md bg-[color-mix(in_srgb,white_6%,transparent)] px-2 leading-6 tabular-nums">{`${formatUsd(lj.costUsd)} so far`}</span>
                  </div>
                )}
                <div className="flex justify-center">
                  <LiveBadge updatedAt={snap.updatedAt ?? follow.updatedAt} />
                </div>
                <div className="flex flex-wrap justify-center gap-2.5">
                  <button type="button" className={BTN_PRI} onClick={() => navigate(`/runs/${encodeURIComponent(launched.id)}`)}>
                    Watch it live
                  </button>
                  <button type="button" className={BTN_SEC} onClick={reset}>
                    New run
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
      <SimNote />
      <p className="px-4 pb-8 text-center text-xs text-[var(--c3-style-basic-fg-secondary)]">
        {summary.data ? `${lab?.name ?? ''} · ${formatInt(summary.data.kpis.liveJobs)} live runs · plans use your lab's real rules, allocations and history` : 'Plans use your lab’s real rules, allocations and history.'}
      </p>
    </div>
  );
};

export default Home;
