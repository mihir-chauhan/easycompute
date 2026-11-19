/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useState } from 'react';
import { ArrowLeft, Check, Copy, Send } from 'lucide-react';

import { EnumBadge } from '@/components/StatusBadges/StatusBadges';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Container } from '@/components/ui/container';
import { muted } from '@/features/lab/components';
import { formatDuration, formatUsd } from '@/features/lab/format';
import type { RuleCheck, RunPlan } from '@/features/lab/types';
import { formatDateTime } from '@/lib/format';

interface Props {
  plan: RunPlan;
  runName: string;
  checks: RuleCheck[];
  busy: boolean;
  onBack: () => void;
  onSubmit: () => void;
}

export default function SubmitStep({ plan, runName, checks, busy, onBack, onSubmit }: Props) {
  const [copied, setCopied] = useState(false);
  const [ack, setAck] = useState(false);
  const warnings = checks.filter((c) => c.outcome !== 'PASS');
  const finish = new Date(Date.now() + ((plan.estWaitHours ?? 0) + (plan.estDurationHours ?? 0)) * 3600000).toISOString();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plan.sbatchScript ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <Container
        className="xl:col-span-2"
        contentWidth="full-width"
        title="sbatch preview"
        subtitle={`${runName}.sbatch — generated from the ${plan.label ?? 'selected'} plan`}
        actions={
          <Button variant="ghost" appearance="secondary" size="sm" leadingIcon={copied ? <Check /> : <Copy />} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        }
      >
        <pre className="max-h-[420px] overflow-auto bg-[var(--c3-style-basic-bg-secondary)] p-4 font-mono text-xs leading-relaxed text-[var(--c3-style-basic-fg-primary)]">
          {plan.sbatchScript ?? '# The planner did not return a script for this plan.'}
        </pre>
      </Container>

      <Container title="Confirm submission" subtitle="Submission is simulated: the job enters the live monitor">
        <dl className="flex flex-col gap-3 text-c3-regular-body-p2">
          {[
            ['Plan', <EnumBadge key="l" value={plan.label} appearance="accent" />],
            ['Where', `${plan.cluster?.name ?? plan.cluster?.id} / ${plan.partition?.name ?? plan.partition?.id}`],
            ['Resources', `${plan.gpus}× ${plan.gpuType?.id ?? 'CPU'} · ${plan.nodes ?? 1} node`],
            ['Walltime', formatDuration(plan.walltimeHours)],
            ['Expected finish', formatDateTime(finish)],
            ['Estimated cost', formatUsd(plan.estCostUsd)],
          ].map(([k, v]) => (
            <div key={String(k)} className="flex items-center justify-between gap-3">
              <dt className={muted}>{k}</dt>
              <dd className="truncate text-right tabular-nums text-[var(--c3-style-basic-fg-primary)]">{v}</dd>
            </div>
          ))}
        </dl>
        {warnings.length > 0 && (
          <div className="mt-4 flex flex-col gap-2 rounded-sm border border-[var(--c3-style-basic-border-warning)] bg-[var(--c3-style-basic-bg-warning)] p-3">
            <span className="text-c3-bold-body-p2 text-[var(--c3-style-basic-fg-warning)]">{`${warnings.length} rule warning${warnings.length > 1 ? 's' : ''}`}</span>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-[var(--c3-style-basic-fg-primary)]">
              {warnings.slice(0, 4).map((w) => (
                <li key={w.id}>{w.policy?.title ?? w.message}</li>
              ))}
            </ul>
            <Checkbox id="ack-warnings" size="sm" label="I have read these warnings" checked={ack} onCheckedChange={(v) => setAck(v === true)} />
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2">
          <Button leadingIcon={<Send />} loading={busy} disabled={warnings.length > 0 && !ack} onClick={onSubmit}>
            Submit to Slurm
          </Button>
          <Button variant="ghost" appearance="secondary" leadingIcon={<ArrowLeft />} disabled={busy} onClick={onBack}>
            Choose another plan
          </Button>
        </div>
      </Container>
    </div>
  );
}
