/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck, CircleX, ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CheckOutcomeBadge, Kpi, muted, RuleSeverityBadge } from '@/features/lab/components';
import { SCOPE_LABEL, SCOPE_ORDER } from '@/features/lab/format';
import type { CheckOutcome, RuleCheck, RuleScope } from '@/features/lab/types';

const OUTCOME_ICON: Record<CheckOutcome, React.ReactNode> = {
  PASS: <CircleCheck className="size-4 text-[var(--c3-style-basic-fg-success)]" aria-hidden />,
  WARN: <CircleAlert className="size-4 text-[var(--c3-style-basic-fg-warning)]" aria-hidden />,
  FAIL: <CircleX className="size-4 text-[var(--c3-style-basic-fg-danger)]" aria-hidden />,
};
const OUTCOME_RANK: Record<CheckOutcome, number> = { FAIL: 0, WARN: 1, PASS: 2 };

interface Props {
  checks: RuleCheck[];
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
}

export default function ChecksStep({ checks, busy, onBack, onNext }: Props) {
  const [show, setShow] = useState<'all' | 'issues'>(checks.some((c) => c.outcome !== 'PASS') ? 'issues' : 'all');
  const counts = useMemo(
    () => ({
      PASS: checks.filter((c) => c.outcome === 'PASS').length,
      WARN: checks.filter((c) => c.outcome === 'WARN').length,
      FAIL: checks.filter((c) => c.outcome === 'FAIL').length,
    }),
    [checks],
  );
  const blocking = checks.filter((c) => c.outcome === 'FAIL' && c.policy?.severity === 'BLOCK');

  const groups = useMemo(() => {
    const visible = checks.filter((c) => show === 'all' || c.outcome !== 'PASS');
    return SCOPE_ORDER.map((scope) => ({
      scope,
      rows: visible.filter((c) => (c.policy?.scope ?? 'LAB') === scope).sort((a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome]),
    })).filter((g) => g.rows.length > 0);
  }, [checks, show]);

  const verdict =
    counts.FAIL > 0
      ? `${counts.FAIL} rule${counts.FAIL > 1 ? 's' : ''} fail as requested. The planner will only propose options that satisfy blocking rules.`
      : counts.WARN > 0
        ? `No blockers. ${counts.WARN} warning${counts.WARN > 1 ? 's' : ''} will shape the plans.`
        : 'Every rule passes. Ready to plan.';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi label="Pass" value={counts.PASS} tone="success" caption="Within limits" />
        <Kpi label="Warn" value={counts.WARN} tone={counts.WARN ? 'warning' : undefined} caption="Allowed, with tradeoffs" />
        <Kpi label="Fail" value={counts.FAIL} tone={counts.FAIL ? 'danger' : undefined} caption={blocking.length ? `${blocking.length} blocking as requested` : 'Nothing blocking'} />
      </div>

      <Container
        title="Rule checks"
        subtitle={verdict}
        actions={
          <Tabs value={show} onValueChange={(v) => setShow(v as 'all' | 'issues')} variant="boxed" size="sm">
            <TabsList>
              <TabsTrigger value="issues">{`Issues (${counts.WARN + counts.FAIL})`}</TabsTrigger>
              <TabsTrigger value="all">{`All (${checks.length})`}</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        {groups.length === 0 ? (
          <p className={`py-6 text-center text-c3-regular-body-p2 ${muted}`}>No warnings or failures.</p>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((g) => (
              <section key={g.scope} aria-label={`${SCOPE_LABEL[g.scope as RuleScope]} rules`}>
                <h3 className={`mb-2 text-xs font-semibold uppercase tracking-wide ${muted}`}>{`${SCOPE_LABEL[g.scope as RuleScope]} rules`}</h3>
                <ul className="flex flex-col divide-y divide-[var(--c3-style-basic-border-primary)] rounded-sm border border-[var(--c3-style-basic-border-primary)]">
                  {g.rows.map((c) => (
                    <li key={c.id} className="flex items-start gap-3 px-4 py-3">
                      <span className="mt-0.5">{OUTCOME_ICON[c.outcome]}</span>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-c3-bold-body-p2 text-[var(--c3-style-basic-fg-primary)]">{c.policy?.title ?? c.policy?.id ?? 'Rule'}</span>
                          <span className={`font-mono text-xs ${muted}`}>{c.policy?.id}</span>
                        </span>
                        {c.message && <span className={`text-c3-regular-body-p2 ${muted}`}>{c.message}</span>}
                        {c.policy?.sourceUrl && (
                          <a href={c.policy.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-[var(--c3-style-basic-fg-accent)] hover:underline">
                            Source <ExternalLink className="size-3" aria-hidden />
                          </a>
                        )}
                      </div>
                      <span className="flex shrink-0 items-center gap-1">
                        <RuleSeverityBadge value={c.policy?.severity} />
                        <CheckOutcomeBadge value={c.outcome} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Container>

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" appearance="secondary" leadingIcon={<ArrowLeft />} onClick={onBack}>
          Edit request
        </Button>
        <Button trailingIcon={<ArrowRight />} loading={busy} onClick={onNext}>
          Recommend plans
        </Button>
      </div>
    </div>
  );
}
