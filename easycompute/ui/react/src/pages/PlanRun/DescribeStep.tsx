/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useState } from 'react';
import { ArrowRight, Calculator, Sparkles, WandSparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Container } from '@/components/ui/container';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { predictDuration } from '@/features/lab/api';
import { muted } from '@/features/lab/components';
import { countdown, formatDuration, formatInt, WORKLOAD_LABEL } from '@/features/lab/format';
import type { Project, WorkloadType } from '@/features/lab/types';
import { formatDateTime } from '@/lib/format';

import { EXAMPLES, parseDescription, type PlanForm, toLocalInput } from './planForm';

interface Props {
  form: PlanForm;
  onChange: (patch: Partial<PlanForm>) => void;
  projects: Project[];
  gpuTypes: { id: string; name: string; memoryGb?: number }[];
  clusters: { id: string; name: string }[];
  busy: boolean;
  onNext: () => void;
}

const ANY = '__any__';

function Field({ id, label, hint, children, className }: { id: string; label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ''}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className={`text-xs ${muted}`}>{hint}</span>}
    </div>
  );
}

export default function DescribeStep({ form, onChange, projects, gpuTypes, clusters, busy, onNext }: Props) {
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState<{ gpuHours?: number; basis?: string } | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [filled, setFilled] = useState<string[]>([]);

  const project = projects.find((p) => p.id === form.projectId);
  const deadlineIso = form.deadline ? new Date(form.deadline).toISOString() : project?.deadline;
  const cd = countdown(deadlineIso);

  const autofill = (text = form.description) => {
    const patch = parseDescription(text, projects, gpuTypes.map((g) => g.id));
    const keys = Object.keys(patch);
    setFilled(keys);
    onChange({ ...patch, description: text });
  };

  const runEstimate = async () => {
    setEstimating(true);
    setEstimateError(null);
    try {
      const res = await predictDuration(form.workloadType, form.gpuTypeId, Number(form.gpus) || 1, Number(form.modelParamsB) || 1);
      const gh = typeof res?.estGpuHours === 'number' ? res.estGpuHours : undefined;
      setEstimate({ gpuHours: gh, basis: typeof res?.basis === 'string' ? res.basis : undefined });
      if (gh != null) onChange({ estGpuHours: String(Math.round(gh * 10) / 10) });
    } catch (err) {
      setEstimateError(err instanceof Error ? err.message : 'Estimate failed');
    } finally {
      setEstimating(false);
    }
  };

  // Clear the "auto-filled" highlight after a few seconds.
  useEffect(() => {
    if (!filled.length) return undefined;
    const t = window.setTimeout(() => setFilled([]), 2500);
    return () => window.clearTimeout(t);
  }, [filled]);

  const hl = (k: keyof PlanForm) => (filled.includes(k) ? 'rounded-sm ring-2 ring-[var(--c3-style-basic-border-accent)] transition-shadow' : 'transition-shadow');
  const canNext = form.description.trim().length > 0 || form.name.trim().length > 0;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
        <Container title="Describe the run" subtitle="Plain English is fine; the planner reads your lab context, rules and past runs">
          <div className="flex flex-col gap-3">
            <Textarea
              id="plan-description"
              aria-label="Run description"
              rows={4}
              placeholder="e.g. Fine-tune Llama-3-8B with LoRA on 40 GB of clinical notes, need results before the CVPR rebuttal."
              value={form.description}
              onChange={(e) => onChange({ description: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="soft" appearance="accent" leadingIcon={<WandSparkles />} disabled={!form.description.trim()} onClick={() => autofill()}>
                Fill fields from description
              </Button>
              <span className={`text-xs ${muted}`}>Try:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => autofill(ex)}
                  className="max-w-72 truncate rounded-full border border-[var(--c3-style-basic-border-primary)] px-2.5 py-0.5 text-xs text-[var(--c3-style-basic-fg-secondary)] hover:border-[var(--c3-style-basic-border-accent)] hover:text-[var(--c3-style-basic-fg-accent)]"
                  title={ex}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        </Container>

        <Container title="Workload" subtitle="What the run is; leave resources empty to let the planner choose">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field id="plan-name" label="Run name" className={hl('name')}>
              <Input id="plan-name" value={form.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="llama3-8b-lora-ft" />
            </Field>
            <Field id="plan-project" label="Project" hint={project?.deadlineLabel ? `${project.deadlineLabel} · ${formatDateTime(project.deadline)}` : undefined} className={hl('projectId')}>
              <Combobox
                id="plan-project"
                placeholder="No project"
                options={[{ value: ANY, label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name, subLabel: p.deadlineLabel }))]}
                value={form.projectId ?? ANY}
                onValueChange={(v) => {
                  const p = projects.find((x) => x.id === v);
                  onChange({
                    projectId: v && v !== ANY ? v : null,
                    ...(p?.deadline ? { deadline: toLocalInput(p.deadline) } : {}),
                    ...(p?.workloadType ? { workloadType: p.workloadType } : {}),
                  });
                }}
              />
            </Field>
            <Field id="plan-workload" label="Workload type" className={hl('workloadType')}>
              <Combobox
                id="plan-workload"
                options={(Object.keys(WORKLOAD_LABEL) as WorkloadType[]).map((w) => ({ value: w, label: WORKLOAD_LABEL[w] }))}
                value={form.workloadType}
                onValueChange={(v) => v && onChange({ workloadType: v as WorkloadType })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field id="plan-params" label="Model size (B params)" className={hl('modelParamsB')}>
                <Input id="plan-params" type="number" min={0} step="0.1" inputMode="decimal" value={form.modelParamsB} onChange={(e) => onChange({ modelParamsB: e.target.value })} placeholder="8" />
              </Field>
              <Field id="plan-data" label="Dataset (GB)" className={hl('datasetGb')}>
                <Input id="plan-data" type="number" min={0} inputMode="decimal" value={form.datasetGb} onChange={(e) => onChange({ datasetGb: e.target.value })} placeholder="40" />
              </Field>
            </div>
            <Field id="plan-deadline" label="Deadline" hint={deadlineIso ? `${cd.text} from now` : 'Optional; plans are ranked on finishing before it'} className={hl('deadline')}>
              <Input id="plan-deadline" type="datetime-local" value={form.deadline} onChange={(e) => onChange({ deadline: e.target.value })} />
            </Field>
            <Field id="plan-gpuh" label="Estimated GPU-hours" hint="From similar past runs; edit if you know better">
              <div className="flex gap-2">
                <Input id="plan-gpuh" className="flex-1" type="number" min={0} inputMode="decimal" value={form.estGpuHours} onChange={(e) => onChange({ estGpuHours: e.target.value })} placeholder="Auto" />
                <Button variant="outline" appearance="secondary" leadingIcon={<Calculator />} loading={estimating} onClick={runEstimate}>
                  Estimate
                </Button>
              </div>
            </Field>
          </div>
        </Container>

        <Container title="Resources (optional)" subtitle="Constrain the search; anything left as Any is optimized">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field id="plan-gputype" label="GPU type" className={hl('gpuTypeId')}>
              <Combobox
                id="plan-gputype"
                options={[{ value: ANY, label: 'Any' }, ...gpuTypes.map((g) => ({ value: g.id, label: g.name, subLabel: g.memoryGb ? `${g.memoryGb} GB` : undefined }))]}
                value={form.gpuTypeId ?? ANY}
                onValueChange={(v) => onChange({ gpuTypeId: v && v !== ANY ? v : null })}
              />
            </Field>
            <Field id="plan-gpus" label="GPUs" className={hl('gpus')}>
              <Input id="plan-gpus" type="number" min={1} max={64} inputMode="numeric" value={form.gpus} onChange={(e) => onChange({ gpus: e.target.value })} placeholder="Any" />
            </Field>
            <Field id="plan-wall" label="Walltime (hours)" className={hl('walltimeHours')}>
              <Input id="plan-wall" type="number" min={0.5} inputMode="decimal" value={form.walltimeHours} onChange={(e) => onChange({ walltimeHours: e.target.value })} placeholder="Any" />
            </Field>
            <Field id="plan-cluster" label="Cluster">
              <Combobox
                id="plan-cluster"
                options={[{ value: ANY, label: 'Any' }, ...clusters.map((c) => ({ value: c.id, label: c.name }))]}
                value={form.clusterId ?? ANY}
                onValueChange={(v) => onChange({ clusterId: v && v !== ANY ? v : null })}
              />
            </Field>
          </div>
        </Container>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <Container title="Request summary">
          <dl className="flex flex-col gap-3 text-c3-regular-body-p2">
            {[
              ['Workload', WORKLOAD_LABEL[form.workloadType]],
              ['Model', form.modelParamsB ? `${form.modelParamsB} B params` : '—'],
              ['Data', form.datasetGb ? `${formatInt(Number(form.datasetGb))} GB` : '—'],
              ['Compute', form.estGpuHours ? `≈ ${formatInt(Number(form.estGpuHours))} GPU-h` : 'Estimated by planner'],
              ['Resources', [form.gpus && `${form.gpus}×`, form.gpuTypeId ?? (form.gpus ? 'any GPU' : 'Any'), form.walltimeHours && `· ${formatDuration(Number(form.walltimeHours))}`].filter(Boolean).join(' ')],
              ['Deadline', deadlineIso ? `${formatDateTime(deadlineIso)} (${cd.text})` : 'None'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className={muted}>{k}</dt>
                <dd className="truncate text-right tabular-nums text-[var(--c3-style-basic-fg-primary)]">{v}</dd>
              </div>
            ))}
          </dl>
          {estimate?.basis && <p className={`mt-3 text-xs ${muted}`}>Estimate basis: {estimate.basis}</p>}
          {estimateError && <p className="mt-3 text-xs text-[var(--c3-style-basic-fg-danger)]">{estimateError}</p>}
          <Button className="mt-4 w-full" trailingIcon={<ArrowRight />} disabled={!canNext} loading={busy} onClick={onNext}>
            Check rules
          </Button>
        </Container>
        <Container title="How planning works">
          <ol className={`flex flex-col gap-2 text-c3-regular-body-p2 ${muted}`}>
            <li className="flex gap-2"><Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-basic-fg-accent)]" aria-hidden />University, cluster, partition and your lab rules are checked first.</li>
            <li className="flex gap-2"><Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-basic-fg-accent)]" aria-hidden />Runtime is predicted from your lab&apos;s past jobs and GPU throughput; queue wait from live partition depth.</li>
            <li className="flex gap-2"><Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-basic-fg-accent)]" aria-hidden />You get the fastest, cheapest and best-balanced plan with a ready sbatch script.</li>
          </ol>
        </Container>
      </div>
    </div>
  );
}
