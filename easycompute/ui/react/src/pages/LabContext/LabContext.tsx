/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { useEffect, useState } from 'react';
import { Bot, Plus, Save, Sparkles, Trash2, X } from 'lucide-react';

import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import PageFrame, { EmptyRows, errorMessage, ErrorState, LoadingState } from '@/components/PageFrame/PageFrame';
import { EnumBadge } from '@/components/StatusBadges/StatusBadges';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { DataGrid, DataGridBody, DataGridCell, DataGridHead, DataGridHeader, DataGridRow } from '@/components/ui/data-grid';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  createLabPolicy,
  extractConstraints,
  fetchAllocations,
  fetchLabPolicies,
  fetchMembers,
  fetchProjects,
  getAutopilot,
  getLab,
  removePolicy,
  saveAutopilot,
  saveContextDump,
  setPolicyActive,
} from '@/features/lab/api';
import { EmptyBlock, Meter, muted, RuleSeverityBadge } from '@/features/lab/components';
import { countdown, formatInt, RULE_SEVERITY_APPEARANCE, titleCase, WORKLOAD_LABEL } from '@/features/lab/format';
import type { AutopilotPolicy, ExtractedConstraint, RuleSeverity } from '@/features/lab/types';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLoad } from '@/features/lab/useLoad';
import { formatDate } from '@/lib/format';

const SEVERITIES: RuleSeverity[] = ['BLOCK', 'WARN', 'INFO'];

function ConstraintChip({
  c,
  onChange,
  onRemove,
}: {
  c: ExtractedConstraint;
  onChange: (next: ExtractedConstraint) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const nextSeverity = SEVERITIES[(SEVERITIES.indexOf(c.severity) + 1) % SEVERITIES.length];
  return (
    <li className="flex min-w-0 max-w-full flex-col gap-1 rounded-sm border border-[var(--c3-style-basic-border-primary)] bg-[var(--c3-style-basic-bg-primary)] px-3 py-2">
      <span className="flex items-center gap-2">
        <button type="button" title={`Severity: ${c.severity} (click for ${nextSeverity})`} onClick={() => onChange({ ...c, severity: nextSeverity })}>
          <RuleSeverityBadge value={c.severity} />
        </button>
        {editing ? (
          <Input
            size="sm"
            aria-label="Constraint title"
            autoFocus
            className="min-w-48 flex-1"
            value={c.title}
            onChange={(e) => onChange({ ...c, title: e.target.value })}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === 'Enter' && setEditing(false)}
          />
        ) : (
          <button type="button" className="min-w-0 truncate text-left text-c3-bold-body-p2 text-[var(--c3-style-basic-fg-primary)] hover:underline" onClick={() => setEditing(true)} title="Click to edit">
            {c.title}
          </button>
        )}
        <span className={`hidden shrink-0 font-mono text-[11px] sm:inline ${muted}`}>{c.kind}</span>
        <button type="button" aria-label={`Remove ${c.title}`} className={`ml-auto shrink-0 rounded-sm p-0.5 hover:text-[var(--c3-style-basic-fg-danger)] ${muted}`} onClick={onRemove}>
          <X className="size-3.5" />
        </button>
      </span>
      {c.sourceText && <span className={`line-clamp-1 text-xs italic ${muted}`} title={c.sourceText}>&ldquo;{c.sourceText}&rdquo;</span>}
    </li>
  );
}

function AutopilotCard({ labId }: { labId: string }) {
  const { reportError } = useErrorBoundary();
  const ap = useLoad(() => getAutopilot(labId), [labId]);
  const [draft, setDraft] = useState<AutopilotPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(ap.data ?? (ap.loading ? null : { id: labId, lab: { id: labId }, enabled: false, cancelIdleAfterMin: 60, checkpointBeforeTimeoutMin: 30, budgetAlertPct: 0.8 }));
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

  if (!draft) return <Container title="Autopilot"><LoadingState /></Container>;

  const toggles: { key: keyof AutopilotPolicy; label: string; hint: string }[] = [
    { key: 'notifyPiOnCritical', label: 'Notify PI on critical alerts', hint: 'Email with the alert and the suggested fix' },
    { key: 'requeueToStandbyOnLowPriority', label: 'Requeue low-priority work to standby', hint: 'Frees owned GPUs for deadline runs' },
    { key: 'autoExtendWalltime', label: 'Request walltime extensions', hint: 'When ETA exceeds the limit; RCAC still approves' },
  ];
  const numbers: { key: 'cancelIdleAfterMin' | 'checkpointBeforeTimeoutMin'; label: string; unit: string }[] = [
    { key: 'cancelIdleAfterMin', label: 'Cancel idle GPU jobs after', unit: 'min' },
    { key: 'checkpointBeforeTimeoutMin', label: 'Checkpoint before timeout', unit: 'min' },
  ];

  return (
    <Container
      title="Autopilot"
      subtitle={draft.enabled ? 'Acting on live runs within these limits' : 'Off: alerts are raised, nothing is changed'}
      actions={
        <span className="flex items-center gap-2">
          {saving && <span className={`text-xs ${muted}`}>Saving…</span>}
          <Switch id="ap-enabled" aria-label="Autopilot enabled" checked={Boolean(draft.enabled)} onCheckedChange={(v) => persist({ ...draft, enabled: v })} />
        </span>
      }
    >
      {err && <p className="mb-3 text-xs text-[var(--c3-style-basic-fg-danger)]">{err}</p>}
      <div className={`flex flex-col gap-4 ${draft.enabled ? '' : 'opacity-60'}`}>
        {toggles.map((t) => (
          <div key={t.key} className="flex items-start justify-between gap-3">
            <div className="flex flex-col">
              <Label htmlFor={`ap-${t.key}`}>{t.label}</Label>
              <span className={`text-xs ${muted}`}>{t.hint}</span>
            </div>
            <Switch id={`ap-${t.key}`} size="sm" disabled={!draft.enabled} checked={Boolean(draft[t.key])} onCheckedChange={(v) => persist({ ...draft, [t.key]: v })} />
          </div>
        ))}
        <div className="grid grid-cols-1 gap-3 border-t border-[var(--c3-style-basic-border-primary)] pt-4 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
          {numbers.map((n) => (
            <div key={n.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`ap-${n.key}`}>{n.label}</Label>
              <Input
                id={`ap-${n.key}`}
                size="sm"
                type="number"
                min={5}
                disabled={!draft.enabled}
                rightIcon={<span className={`text-xs ${muted}`}>{n.unit}</span>}
                value={draft[n.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [n.key]: Number(e.target.value) })}
                onBlur={() => persist(draft)}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ap-budget">Budget alert at</Label>
            <Input
              id="ap-budget"
              size="sm"
              type="number"
              min={10}
              max={100}
              disabled={!draft.enabled}
              rightIcon={<span className={`text-xs ${muted}`}>% used</span>}
              value={draft.budgetAlertPct != null ? Math.round(draft.budgetAlertPct * 100) : ''}
              onChange={(e) => setDraft({ ...draft, budgetAlertPct: Number(e.target.value) / 100 })}
              onBlur={() => persist(draft)}
            />
          </div>
        </div>
      </div>
    </Container>
  );
}

const LabContext: React.FC = () => {
  const { reportError } = useErrorBoundary();
  const { labId, error: labError } = useCurrentLab();
  const labRec = useLoad(() => (labId ? getLab(labId) : null), [labId]);
  const rules = useLoad(() => (labId ? fetchLabPolicies(labId) : null), [labId]);
  const other = useLoad(() => (labId ? Promise.all([fetchAllocations(labId), fetchProjects(labId), fetchMembers(labId)]) : null), [labId]);
  const [allocations, projects, members] = other.data ?? [[], [], []];

  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<ExtractedConstraint[] | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  useEffect(() => {
    setText(labRec.data?.contextDump ?? '');
    setDirty(false);
    setExtracted(null);
  }, [labRec.data]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    setSavedNote(null);
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
      setSavedNote('Context saved.');
    });

  const extract = () =>
    act('extract', async () => {
      if (!labId) return;
      if (dirty) {
        await saveContextDump(labId, text);
        setDirty(false);
      }
      const res = await extractConstraints(labId, text);
      setExtracted(res.map((c, i) => ({ ...c, key: c.key ?? `c${i}` })));
    });

  const saveRules = () =>
    act('rules', async () => {
      if (!labId || !extracted) return;
      for (const c of extracted) await createLabPolicy(labId, c);
      setSavedNote(`${extracted.length} rule${extracted.length === 1 ? '' : 's'} added to the lab. The planner enforces them from the next check.`);
      setExtracted(null);
      rules.reload();
    });

  const toggleRule = (id: string, active: boolean) => act(id, async () => {
    await setPolicyActive(id, active);
    rules.reload();
  });

  const deleteRule = (id: string) => act(`del-${id}`, async () => {
    await removePolicy(id);
    rules.reload();
  });

  const error = labError ?? labRec.error;

  return (
    <PageFrame title="Lab Context" description="Everything unique to your lab that the planner and autopilot should respect">
      {error && <ErrorState message={`Could not load lab: ${error}`} onRetry={labRec.reload} />}
      {err && <ErrorState message={err} />}
      {!labRec.data && !error && <LoadingState label="Loading lab context…" />}

      {labRec.data && labId && (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Container
              className="xl:col-span-2"
              title="Context dump"
              subtitle="Paste funding, deadlines, preferences and house rules in plain English"
              actions={
                <span className="flex flex-wrap gap-2">
                  <Button variant="outline" appearance="secondary" size="sm" leadingIcon={<Save />} disabled={!dirty} loading={busy === 'save'} onClick={save}>
                    Save
                  </Button>
                  <Button size="sm" leadingIcon={<Sparkles />} disabled={!text.trim()} loading={busy === 'extract'} onClick={extract}>
                    Extract constraints
                  </Button>
                </span>
              }
            >
              <Textarea
                aria-label="Lab context"
                rows={9}
                value={text}
                placeholder="We own 4 H100s on Gautschi and 6 A100-80GB on Gilbreth. NeurIPS camera-ready is Dec 12. Thesis runs never on preemptible…"
                onChange={(e) => {
                  setText(e.target.value);
                  setDirty(true);
                }}
              />
              <div className={`mt-2 flex justify-between text-xs ${muted}`}>
                <span>{dirty ? 'Unsaved changes' : 'Saved'}</span>
                <span className="tabular-nums">{`${formatInt(text.trim() ? text.trim().split(/\s+/).length : 0)} words`}</span>
              </div>

              {savedNote && <p role="status" className="mt-3 text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-success)]">{savedNote}</p>}

              {extracted && (
                <div className="mt-4 flex flex-col gap-3 border-t border-[var(--c3-style-basic-border-primary)] pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-col">
                      <span className="text-c3-bold-body-p1 text-[var(--c3-style-basic-fg-primary)]">{`Parsed ${extracted.length} constraint${extracted.length === 1 ? '' : 's'}`}</span>
                      <span className={`text-xs ${muted}`}>Click a title to edit, a severity to cycle it, × to drop it.</span>
                    </span>
                    <span className="flex gap-2">
                      <Button variant="ghost" appearance="secondary" size="sm" onClick={() => setExtracted(null)}>
                        Discard
                      </Button>
                      <Button size="sm" leadingIcon={<Plus />} disabled={extracted.length === 0} loading={busy === 'rules'} onClick={saveRules}>
                        {`Add ${extracted.length} as lab rules`}
                      </Button>
                    </span>
                  </div>
                  {extracted.length === 0 ? (
                    <EmptyBlock label="No enforceable constraints found. Mention limits, budgets, deadlines or QOS preferences." />
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {extracted.map((c) => (
                        <ConstraintChip
                          key={c.key}
                          c={c}
                          onChange={(next) => setExtracted((xs) => (xs ?? []).map((x) => (x.key === c.key ? next : x)))}
                          onRemove={() => setExtracted((xs) => (xs ?? []).filter((x) => x.key !== c.key))}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Container>

            <AutopilotCard labId={labId} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Container className="xl:col-span-2" contentWidth="full-width" title="Lab rules" subtitle="Checked on every planned run, alongside university, cluster and partition rules">
              <div className="overflow-x-auto">
                <DataGrid className="w-full">
                  <DataGridHeader>
                    <DataGridRow>
                      <DataGridHead sortable={false} filterable={false}>Active</DataGridHead>
                      <DataGridHead sortable={false} filterable={false}>Rule</DataGridHead>
                      <DataGridHead sortable={false} filterable={false}>Severity</DataGridHead>
                      <DataGridHead sortable={false} filterable={false}>Limit</DataGridHead>
                      <DataGridHead sortable={false} filterable={false} align="right"><span className="sr-only">Remove</span></DataGridHead>
                    </DataGridRow>
                  </DataGridHeader>
                  <DataGridBody>
                    {rules.loading && !rules.data && <EmptyRows colSpan={5} label="Loading rules…" />}
                    {rules.data?.length === 0 && <EmptyRows colSpan={5} label="No lab rules yet. Extract them from your context dump." />}
                    {(rules.data ?? []).map((p) => (
                      <DataGridRow key={p.id}>
                        <DataGridCell>
                          <Switch size="sm" aria-label={`Rule ${p.id} active`} checked={p.active !== false} disabled={busy === p.id} onCheckedChange={(v) => toggleRule(p.id, v)} />
                        </DataGridCell>
                        <DataGridCell className="max-w-96">
                          <div className="flex min-w-0 flex-col">
                            <span className={`truncate ${p.active === false ? muted : ''}`} title={p.title}>{p.title}</span>
                            <span className={`truncate font-mono text-xs ${muted}`}>{`${p.id} · ${p.kind ?? ''}`}</span>
                          </div>
                        </DataGridCell>
                        <DataGridCell><RuleSeverityBadge value={p.severity} /></DataGridCell>
                        <DataGridCell className="max-w-40 truncate tabular-nums">{p.limitValue != null ? formatInt(p.limitValue) : (p.limitText ?? '—')}</DataGridCell>
                        <DataGridCell align="right">
                          <Button variant="ghost" appearance="secondary" size="sm" aria-label={`Delete rule ${p.id}`} leadingIcon={<Trash2 />} loading={busy === `del-${p.id}`} onClick={() => deleteRule(p.id)} />
                        </DataGridCell>
                      </DataGridRow>
                    ))}
                  </DataGridBody>
                </DataGrid>
              </div>
            </Container>

            <Container title="Members" subtitle={`${members.length} people · usernames are pseudonymized`}>
              {members.length === 0 ? (
                <EmptyBlock label={other.loading ? 'Loading…' : 'No members.'} />
              ) : (
                <ul className="flex flex-col divide-y divide-[var(--c3-style-basic-border-primary)]">
                  {members.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--c3-style-basic-bg-secondary)] text-xs font-semibold">
                          {m.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-c3-regular-body-p2">{m.name}</span>
                          <span className={`truncate font-mono text-xs ${muted}`}>{m.username}</span>
                        </span>
                      </span>
                      {m.role && <EnumBadge value={titleCase(m.role)} appearance={m.role === 'PI' ? 'accent' : 'secondary'} />}
                    </li>
                  ))}
                </ul>
              )}
            </Container>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Container contentWidth="full-width" title="Allocations" subtitle="Compute the lab can spend, by source">
              <div className="overflow-x-auto">
                <DataGrid className="w-full">
                  <DataGridHeader>
                    <DataGridRow>
                      <DataGridHead sortable={false} filterable={false}>Allocation</DataGridHead>
                      <DataGridHead sortable={false} filterable={false}>Used</DataGridHead>
                      <DataGridHead sortable={false} filterable={false} align="right">Remaining</DataGridHead>
                      <DataGridHead sortable={false} filterable={false} align="right">Ends</DataGridHead>
                    </DataGridRow>
                  </DataGridHeader>
                  <DataGridBody>
                    {!other.loading && allocations.length === 0 && <EmptyRows colSpan={4} label="No allocations." />}
                    {allocations.map((a) => {
                      const frac = a.totalUnits ? (a.usedUnits ?? 0) / a.totalUnits : 0;
                      return (
                        <DataGridRow key={a.id}>
                          <DataGridCell className="max-w-64">
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate" title={a.grantName}>{a.grantName ?? a.id}</span>
                              <span className={`truncate text-xs ${muted}`}>{`${a.cluster?.name ?? a.cluster?.id} · ${titleCase(a.source ?? '')}`}</span>
                            </div>
                          </DataGridCell>
                          <DataGridCell className="min-w-32">
                            <div className="flex flex-col gap-1">
                              <span className="text-xs tabular-nums">{`${Math.round(frac * 100)}%`}</span>
                              <Meter value={frac} appearance={frac > 0.9 ? 'danger' : frac > 0.75 ? 'warning' : 'accent'} label={`${a.grantName} used`} />
                            </div>
                          </DataGridCell>
                          <DataGridCell align="right" className="whitespace-nowrap tabular-nums">{`${formatInt((a.totalUnits ?? 0) - (a.usedUnits ?? 0))} ${a.unitName ?? ''}`}</DataGridCell>
                          <DataGridCell align="right" className="whitespace-nowrap">{formatDate(a.endDate)}</DataGridCell>
                        </DataGridRow>
                      );
                    })}
                  </DataGridBody>
                </DataGrid>
              </div>
            </Container>

            <Container contentWidth="full-width" title="Projects & deadlines" subtitle="Plans are ranked on finishing before these">
              <div className="overflow-x-auto">
                <DataGrid className="w-full">
                  <DataGridHeader>
                    <DataGridRow>
                      <DataGridHead sortable={false} filterable={false}>Project</DataGridHead>
                      <DataGridHead sortable={false} filterable={false}>Priority</DataGridHead>
                      <DataGridHead sortable={false} filterable={false}>Deadline</DataGridHead>
                      <DataGridHead sortable={false} filterable={false} align="right">Time left</DataGridHead>
                    </DataGridRow>
                  </DataGridHeader>
                  <DataGridBody>
                    {!other.loading && projects.length === 0 && <EmptyRows colSpan={4} label="No projects." />}
                    {projects.map((p) => {
                      const c = countdown(p.deadline);
                      return (
                        <DataGridRow key={p.id}>
                          <DataGridCell className="max-w-64">
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate" title={p.name}>{p.name}</span>
                              <span className={`truncate text-xs ${muted}`}>{p.workloadType ? WORKLOAD_LABEL[p.workloadType] : ''}</span>
                            </div>
                          </DataGridCell>
                          <DataGridCell>
                            <EnumBadge value={p.priority === 1 ? 'High' : p.priority === 2 ? 'Medium' : 'Low'} appearance={p.priority === 1 ? RULE_SEVERITY_APPEARANCE.WARN : 'secondary'} />
                          </DataGridCell>
                          <DataGridCell className="max-w-56">
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate">{p.deadlineLabel ?? '—'}</span>
                              <span className={`text-xs ${muted}`}>{formatDate(p.deadline)}</span>
                            </div>
                          </DataGridCell>
                          <DataGridCell align="right"><EnumBadge value={c.text} appearance={c.tone} /></DataGridCell>
                        </DataGridRow>
                      );
                    })}
                  </DataGridBody>
                </DataGrid>
              </div>
            </Container>
          </div>

          <p className={`flex items-center gap-2 text-xs ${muted}`}>
            <Bot className="size-3.5" aria-hidden />
            Constraint extraction runs through the EasyCompute advisor; rules are enforced deterministically by the rule engine.
          </p>
        </>
      )}
    </PageFrame>
  );
};

export default LabContext;
