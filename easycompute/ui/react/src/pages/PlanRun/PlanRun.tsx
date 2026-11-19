/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, RotateCcw } from 'lucide-react';

import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import PageFrame, { errorMessage, ErrorState, LoadingState } from '@/components/PageFrame/PageFrame';
import { Button } from '@/components/ui/button';
import {
  checkRules,
  createRunRequest,
  fetchClusters,
  fetchGpuTypes,
  fetchProjects,
  recommendPlans,
  submitPlan,
  updateRunRequest,
} from '@/features/lab/api';
import type { RuleCheck, RunPlan, RunRequest } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLoad } from '@/features/lab/useLoad';
import { cn } from '@/lib/utils';

import ChecksStep from './ChecksStep';
import DescribeStep from './DescribeStep';
import { EMPTY_FORM, type PlanForm, toRunRequest } from './planForm';
import PlansStep from './PlansStep';
import SubmitStep from './SubmitStep';

const STEPS = ['Describe', 'Rule checks', 'Plans', 'Submit'] as const;

function Stepper({ step, onJump }: { step: number; onJump: (i: number) => void }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2" aria-label="Plan steps">
      {STEPS.map((label, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={label} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!done}
              onClick={() => onJump(i)}
              aria-current={current ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-c3-regular-body-p2',
                current && 'bg-[var(--c3-style-basic-bg-accent)] text-[var(--c3-style-basic-fg-primary)]',
                done && 'cursor-pointer text-[var(--c3-style-basic-fg-primary)] hover:bg-[var(--c3-style-basic-bg-secondary)]',
                !done && !current && 'text-[var(--c3-style-basic-fg-secondary)]',
              )}
            >
              <span
                className={cn(
                  'flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
                  done || current
                    ? 'bg-[var(--c3-style-basic-bg-accent-inverse)] text-[var(--c3-style-basic-fg-accent-inverse)]'
                    : 'border border-[var(--c3-style-basic-border-primary)]',
                )}
              >
                {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
              </span>
              <span className={current ? 'font-semibold' : undefined}>{label}</span>
            </button>
            {i < STEPS.length - 1 && <span className="h-px w-6 bg-[var(--c3-style-basic-border-primary)] md:w-10" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

const PlanRun: React.FC = () => {
  const navigate = useNavigate();
  const { reportError } = useErrorBoundary();
  const { lab, labId, error: labError } = useCurrentLab();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<PlanForm>(EMPTY_FORM);
  const [request, setRequest] = useState<RunRequest | null>(null);
  const [checks, setChecks] = useState<RuleCheck[]>([]);
  const [plans, setPlans] = useState<RunPlan[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refs = useLoad(() => (labId ? Promise.all([fetchProjects(labId), fetchGpuTypes(), fetchClusters()]) : null), [labId]);
  const [projects, gpuTypes, clusters] = refs.data ?? [[], [], []];

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const toChecks = () =>
    guard(async () => {
      if (!labId) return;
      const body = toRunRequest(form, labId);
      const rr = request ? { ...request, ...body } : await createRunRequest(body);
      if (request) await updateRunRequest({ ...body, id: request.id });
      setRequest(rr);
      setChecks(await checkRules(rr.id));
      setPlans([]);
      setSelected(null);
      setStep(1);
    });

  const toPlans = () =>
    guard(async () => {
      if (!request) return;
      const ps = await recommendPlans(request.id);
      setPlans(ps);
      setSelected(ps.find((p) => p.label === 'Balanced')?.id ?? ps[0]?.id ?? null);
      setStep(2);
    });

  const submit = () =>
    guard(async () => {
      if (!request || !selected) return;
      const job = await submitPlan(request.id, selected);
      navigate(job?.id ? `/runs/${encodeURIComponent(job.id)}` : '/runs');
    });

  const reset = () => {
    setForm(EMPTY_FORM);
    setRequest(null);
    setChecks([]);
    setPlans([]);
    setSelected(null);
    setError(null);
    setStep(0);
  };

  const plan = plans.find((p) => p.id === selected);

  return (
    <PageFrame
      title="Plan a Run"
      description={`Check a run against university, cluster and ${lab?.name ?? 'lab'} rules, then pick the fastest, cheapest or balanced launch plan`}
      actions={
        step > 0 ? (
          <Button variant="outline" appearance="secondary" leadingIcon={<RotateCcw />} onClick={reset} disabled={busy}>
            Start over
          </Button>
        ) : undefined
      }
    >
      <Stepper step={step} onJump={(i) => !busy && setStep(i)} />
      {(labError || refs.error) && <ErrorState message={`Could not load lab data: ${labError ?? refs.error}`} onRetry={refs.reload} />}
      {error && <ErrorState message={error} />}

      {!refs.data && !refs.error && !labError ? (
        <LoadingState label="Loading lab context…" />
      ) : (
        <>
          {step === 0 && (
            <DescribeStep
              form={form}
              onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
              projects={projects}
              gpuTypes={gpuTypes}
              clusters={clusters}
              busy={busy}
              onNext={toChecks}
            />
          )}
          {step === 1 && <ChecksStep checks={checks} busy={busy} onBack={() => setStep(0)} onNext={toPlans} />}
          {step === 2 && (
            <PlansStep
              plans={plans}
              selectedId={selected}
              onSelect={setSelected}
              deadline={request?.deadline}
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
            />
          )}
          {step === 3 && plan && (
            <SubmitStep plan={plan} runName={request?.name ?? form.name} checks={checks} busy={busy} onBack={() => setStep(2)} onSubmit={submit} />
          )}
        </>
      )}
    </PageFrame>
  );
};

export default PlanRun;
