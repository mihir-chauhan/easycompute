/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, Sparkles, Trash2 } from 'lucide-react';

import { DataTable, EmptyState, ErrorState, LoadingState, PageFrame, SectionCard, ToneBadge, errorMessage, provenanceOf, type Column, type Tone } from '@/components/app';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  confirmConstraints,
  createLabPolicy,
  extractConstraints,
  fetchAllocations,
  fetchLabPolicies,
  fetchMembers,
  fetchProjects,
  getLab,
  removePolicy,
  saveContextDump,
  setPolicyActive,
} from '@/features/lab/api';
import { CheckRow, HeadNote, Mono, muted } from '@/features/lab/components';
import { notYetRules, toCandidateRules, withoutDismissed } from '@/features/lab/constraints';
import { ModelComputing, ModelProvenance } from '@/features/lab/models';
import { formatInt, titleCase } from '@/features/lab/format';
import type { Allocation, ExtractedConstraint, LabConstraints, Project } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLabRole } from '@/features/lab/useLabRole';
import { useLoad } from '@/features/lab/useLoad';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const SEVERITY_TAG: Record<string, [Tone, string]> = { BLOCK: ['bad', 'Hard'], WARN: ['warn', 'Monitored'], INFO: ['info', 'Advisory'] };
const SOURCE_USE: Record<string, [Tone, string]> = {
  ACCESS: ['good', 'Use first'],
  GRANT: ['good', 'Default'],
  DEPARTMENT: ['good', 'Default'],
  STARTUP: ['warn', 'Ask PI'],
  CLOUD_CREDITS: ['info', 'Overflow'],
};

/** The context text with each extracted rule's evidence span highlighted and numbered. */
function EvidenceText({ text, spans }: { text: string; spans: string[] }) {
  const hits = spans
    .map((sp, i) => ({ i, sp: sp.trim(), at: sp.trim() ? text.indexOf(sp.trim()) : -1 }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at);
  const parts: React.ReactNode[] = [];
  let pos = 0;
  hits.forEach((h) => {
    if (h.at < pos) return;
    parts.push(text.slice(pos, h.at));
    parts.push(
      <mark key={h.i} className="rounded-sm bg-[var(--c3-style-basic-bg-warning)] px-0.5 text-[var(--c3-style-basic-fg-primary)]">
        {h.sp}
        <sup className="ml-0.5 font-mono text-[10px] text-[var(--c3-style-basic-fg-warning)]">{h.i + 1}</sup>
      </mark>,
    );
    pos = h.at + h.sp.length;
  });
  parts.push(text.slice(pos));
  return <p className="text-[13px] leading-6 whitespace-pre-wrap text-[var(--c3-style-basic-fg-secondary)]">{parts}</p>;
}

const LabContext: React.FC = () => {
  const navigate = useNavigate();
  const { reportError } = useErrorBoundary();
  const { labId, error: labError } = useCurrentLab();
  const labRec = useLoad(() => (labId ? getLab(labId) : null), [labId]);
  const rules = useLoad(() => (labId ? fetchLabPolicies(labId) : null), [labId]);
  const other = useLoad(() => (labId ? Promise.all([fetchAllocations(labId), fetchProjects(labId), fetchMembers(labId)]) : null), [labId]);
  const [allocations, projects, members] = other.data ?? [[], [], []];

  const lr = useLabRole();
  const ro = !lr.canEditContext;
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [parsed, setParsed] = useState<LabConstraints | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setText(labRec.data?.contextDump ?? '');
    setDirty(false);
    setParsed(null);
    setDismissed([]);
  }, [labRec.data]);

  const pending = useMemo(
    () => notYetRules(toCandidateRules(parsed), rules.data ?? []).filter((c) => !dismissed.includes(c.key)),
    [parsed, rules.data, dismissed],
  );

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorMessage(e));
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    act('save', async () => {
      if (!labId) return;
      await saveContextDump(labId, text);
      setDirty(false);
      setNote('Context saved. Every new plan is checked against it.');
    });

  const extract = () =>
    act('extract', async () => {
      if (!labId) return;
      if (dirty) {
        await saveContextDump(labId, text);
        setDirty(false);
      }
      setParsed(await extractConstraints(labId, text));
      setDismissed([]);
    });

  const accept = (c: ExtractedConstraint) =>
    act(`add-${c.key}`, async () => {
      if (!labId) return;
      await createLabPolicy(labId, c);
      rules.reload();
    });

  /** LabContextExtractor confirmation: confirm the reviewed extraction, then enforce each item as a LAB rule. */
  const acceptAll = () =>
    act('add-all', async () => {
      if (!labId || !parsed) return;
      const confirmed = await confirmConstraints(labId, withoutDismissed(parsed, dismissed)).catch((e: unknown) => {
        throw new Error(`LabContextExtractor could not confirm: ${errorMessage(e)}`);
      });
      for (const c of pending) await createLabPolicy(labId, c);
      setParsed((p) => (p ? { ...p, status: confirmed?.status ?? 'CONFIRMED' } : p));
      setNote(`Confirmed. ${pending.length} rule${pending.length === 1 ? '' : 's'} added; the planner enforces them from the next check.`);
      rules.reload();
    });

  const allocColumns: Column<Allocation>[] = [
    {
      key: 'src',
      header: 'Source',
      render: (a) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-[var(--c3-style-basic-fg-primary)]">{a.grantName ?? a.id}</span>
          <Mono className={muted}>{`${a.cluster?.name ?? a.cluster?.id ?? ''} · ${titleCase(a.source ?? '')} · ends ${formatDate(a.endDate)}`}</Mono>
        </div>
      ),
    },
    { key: 'avail', header: 'Available', align: 'right', render: (a) => `${formatInt((a.totalUnits ?? 0) - (a.usedUnits ?? 0))} ${a.unitName ?? ''}` },
    {
      key: 'use',
      header: 'Use',
      render: (a) => {
        const frac = a.totalUnits ? (a.usedUnits ?? 0) / a.totalUnits : 0;
        const [tone, label] = frac >= 0.98 ? (['bad', 'Exhausted'] as [Tone, string]) : (SOURCE_USE[a.source ?? ''] ?? ['neutral', 'Available']);
        return <ToneBadge tone={tone}>{label}</ToneBadge>;
      },
    },
  ];

  const projColumns: Column<Project>[] = [
    { key: 'p', header: 'Priority', render: (p) => <ToneBadge tone={p.priority === 1 ? 'accent' : p.priority === 2 ? 'info' : 'neutral'}>{`P${p.priority ?? 3}`}</ToneBadge> },
    {
      key: 'm',
      header: 'Milestone',
      render: (p) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-[var(--c3-style-basic-fg-primary)]">{p.deadlineLabel ?? p.name}</span>
          <span className={cn('truncate text-xs', muted)}>{p.name}</span>
        </div>
      ),
    },
    { key: 'd', header: 'Date', align: 'right', render: (p) => (p.deadline ? formatDate(p.deadline) : <span className={muted}>None</span>) },
  ];

  const error = labError ?? labRec.error;
  const updated = labRec.data && (labRec.data as { meta?: { updated?: string } }).meta?.updated;

  return (
    <PageFrame
      title="Lab context"
      description="Paste anything about your lab. EasyCompute pulls out budgets, deadlines and house rules, and every plan is checked against them."
      badges={updated ? <ToneBadge tone="neutral">{`Last updated ${formatDate(updated)}`}</ToneBadge> : undefined}
    >
      {error && <ErrorState message={`Could not load lab: ${error}`} onRetry={labRec.reload} />}
      {err && <ErrorState message={err} />}
      {!labRec.data && !error && <LoadingState label="Loading lab context…" />}

      {labRec.data && labId && (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4">
            <SectionCard title="Context dump" actions={<HeadNote>Free text: funding, deadlines, house rules</HeadNote>}>
              <Textarea
                aria-label="Lab context"
                readOnly={ro}
                rows={16}
                value={text}
                className="text-sm leading-6"
                placeholder="Compute money this year is the NSF award, $48k compute line… Students: max 16 GPUs at once without asking me…"
                onChange={(e) => {
                  setText(e.target.value);
                  setDirty(true);
                }}
              />
              {ro ? (
                <p className={cn('mt-4 text-[13px]', muted)}>Read-only for lab members. Your PI or lab admin edits the lab context and confirms extracted rules.</p>
              ) : (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button leadingIcon={<Sparkles />} disabled={!text.trim()} loading={busy === 'extract'} onClick={extract}>
                  {parsed ? 'Extract again' : 'Extract constraints'}
                </Button>
                <Button variant="outline" appearance="secondary" leadingIcon={<Save />} disabled={!dirty} loading={busy === 'save'} onClick={save}>
                  Save
                </Button>
                <span className={cn('text-xs', muted)}>
                  {dirty ? 'Unsaved changes' : `${formatInt(text.trim() ? text.trim().split(/\s+/).length : 0)} words · re-read whenever it changes`}
                </span>
              </div>
              )}
              {busy === 'extract' && <ModelComputing name="LabContextExtractor" className="mt-3" />}
              {note && <p role="status" className="mt-3 text-[13px] text-[var(--c3-style-basic-fg-success)]">{note}</p>}
              {parsed && (
                <div className="mt-4 flex flex-col gap-3 border-t border-[var(--c3-style-basic-border-border)] pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">Evidence in your text</span>
                    {parsed.status && <ToneBadge tone={parsed.status === 'CONFIRMED' ? 'good' : 'warn'}>{parsed.status === 'CONFIRMED' ? 'Confirmed' : 'Unconfirmed'}</ToneBadge>}
                    <ModelProvenance
                      name="LabContextExtractor"
                      provenance={provenanceOf(parsed)}
                      support={parsed.source === 'llm' ? `LLM${parsed.cached ? ' (cached)' : ''} + rules validation` : 'rules parser (LLM unavailable)'}
                      extra={parsed.llmError}
                    />
                  </div>
                  {parsed.summary && <p className={cn('text-[13px]', muted)}>{parsed.summary}</p>}
                  {parsed.validation && parsed.validation.valid === false && (
                    <p className="text-[13px] text-[var(--c3-style-basic-fg-warning)]">{`Validation dropped ${parsed.validation.dropped?.length ?? 0} item(s): ${(parsed.validation.errors ?? []).slice(0, 3).join('; ')}`}</p>
                  )}
                  <EvidenceText text={text} spans={pending.map((c) => c.sourceText ?? '')} />
                </div>
              )}
            </SectionCard>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {parsed && pending.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-[var(--ec-card-radius,8px)] border border-[var(--c3-style-basic-border-warning)] bg-[var(--c3-style-basic-bg-warning)] px-5 py-4">
                <span className="flex size-5 items-center justify-center rounded-full text-xs font-bold text-[var(--c3-style-basic-fg-warning)]">?</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--c3-style-basic-fg-primary)]">{`${pending.length} item${pending.length === 1 ? '' : 's'} need your confirmation`}</div>
                  <div className={cn('text-[13px]', muted)}>EasyCompute will not enforce an extracted rule until it is confirmed.</div>
                </div>
                <Button size="sm" loading={busy === 'add-all'} onClick={acceptAll}>
                  Confirm all
                </Button>
              </div>
            )}
            {parsed?.warnings?.map((w) => (
              <p key={w} className="text-[13px] text-[var(--c3-style-basic-fg-warning)]">{w}</p>
            ))}

            <SectionCard flush title="Funding" actions={<ToneBadge tone="good">{`${allocations.length} source${allocations.length === 1 ? "" : "s"}`}</ToneBadge>}>
              <DataTable columns={allocColumns} rows={allocations} rowKey={(a) => a.id} loading={other.loading && !other.data} emptyLabel="No allocations recorded" />
            </SectionCard>

            <SectionCard flush title="Deadlines and priorities">
              <DataTable columns={projColumns} rows={projects} rowKey={(p) => p.id} loading={other.loading && !other.data} emptyLabel="No projects yet" />
            </SectionCard>

            <SectionCard
              title="Lab rules"
              actions={
                <Button variant="ghost" appearance="secondary" size="sm" onClick={() => navigate('/admin/policies?scope=LAB')}>
                  See all policies
                </Button>
              }
            >
              {rules.loading && !rules.data ? (
                <LoadingState />
              ) : (rules.data ?? []).length === 0 && pending.length === 0 ? (
                <EmptyState title="No lab rules yet" hint="Extract them from the context dump, then confirm each one." />
              ) : (
                <ul className="flex flex-col">
                  {(rules.data ?? []).map((p) => {
                    const [tone, label] = SEVERITY_TAG[p.severity] ?? ['neutral', p.severity];
                    return (
                      <CheckRow
                        key={p.id}
                        kind={p.active === false ? 'info' : 'ok'}
                        glyph={p.active === false ? '–' : undefined}
                        title={<span className={p.active === false ? muted : undefined}>{p.title}</span>}
                        detail={p.description ?? (p.limitValue != null ? `Limit ${formatInt(p.limitValue)}${p.limitText ? ` ${p.limitText}` : ''}` : p.limitText)}
                        right={
                          <>
                            <ToneBadge tone={tone}>{label}</ToneBadge>
                            <Switch size="sm" aria-label={`Rule ${p.id} active`} checked={p.active !== false} disabled={ro || busy === p.id} onCheckedChange={(v) => act(p.id, async () => { await setPolicyActive(p.id, v); rules.reload(); })} />
                            {!ro && <button type="button" aria-label={`Delete rule ${p.title}`} className={cn('rounded p-1 hover:text-[var(--c3-style-basic-fg-danger)]', muted)} onClick={() => act(`del-${p.id}`, async () => { await removePolicy(p.id); rules.reload(); })}>
                              <Trash2 className="size-3.5" />
                            </button>}
                          </>
                        }
                      />
                    );
                  })}
                  {pending.map((c) => (
                    <CheckRow
                      key={c.key}
                      kind="warn"
                      glyph="?"
                      title={
                        <span>
                          <sup className="mr-1 font-mono text-[10px] text-[var(--c3-style-basic-fg-warning)]">{pending.indexOf(c) + 1}</sup>
                          {c.title}
                        </span>
                      }
                      detail={c.sourceText ? `“${c.sourceText}”` : `No evidence span returned for this ${titleCase(c.kind).toLowerCase()} rule: check it against your text before confirming.`}
                      right={
                        <>
                          <Button variant="outline" appearance="secondary" size="sm" loading={busy === `add-${c.key}`} onClick={() => accept(c)}>
                            Yes
                          </Button>
                          <Button variant="outline" appearance="secondary" size="sm" onClick={() => setDismissed((d) => [...d, c.key])}>
                            No
                          </Button>
                        </>
                      }
                    />
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Members" actions={<HeadNote>{`${members.length} people · usernames pseudonymized`}</HeadNote>}>
              <ul className="flex flex-wrap gap-2">
                {members.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 rounded-full border border-[var(--c3-style-basic-border-border)] py-1 pr-3 pl-1 text-[13px]">
                    <span className="flex size-6 items-center justify-center rounded-full bg-[var(--c3-style-basic-bg-secondary)] text-[11px] font-semibold">
                      {m.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                    </span>
                    <span className="text-[var(--c3-style-basic-fg-primary)]">{m.name}</span>
                    <Mono className={muted}>{m.username}</Mono>
                    {m.role === 'PI' && <ToneBadge tone="accent">PI</ToneBadge>}
                  </li>
                ))}
                {members.length === 0 && <li className={cn('text-[13px]', muted)}>{other.loading ? 'Loading…' : 'No members.'}</li>}
              </ul>
            </SectionCard>
          </div>
        </div>
      )}
    </PageFrame>
  );
};

export default LabContext;
