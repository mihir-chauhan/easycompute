/*
 * Research Computing — Policy catalog (/admin/policies): every rule a run is checked against, filterable by
 * scope and severity, with a rule detail panel (?rule=<id>).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExternalLink, ScrollText } from 'lucide-react';

import {
  ClearFilters,
  ClusterTag,
  DataTable,
  ErrorState,
  PageFrame,
  ResultCount,
  SearchBox,
  SectionCard,
  Segmented,
  SeverityBadge,
  StatusBadge,
  ToneBadge,
  humanize,
  useC3Data,
  type Column,
} from '@/components/app';
import DetailList from '@/components/DetailList/DetailList';
import { Link } from '@/components/ui/link';
import { SidePanel } from '@/components/ui/side-panel';
import { listPolicies } from '@/features/admin/api';
import { num } from '@/features/admin/components';
import type { Policy } from '@/features/admin/types';

const SCOPES = ['UNIVERSITY', 'CLUSTER', 'PARTITION', 'LAB'] as const;
const SEVERITIES = ['BLOCK', 'WARN', 'INFO'] as const;
const SEVERITY_RANK: Record<string, number> = { BLOCK: 0, WARN: 1, INFO: 2 };

/** Human sentence for what a rule limits. */
function limitOf(p: Policy): string {
  if (p.limitText) return p.limitText;
  if (p.limitValue == null) return '—';
  const v = p.limitValue;
  switch (p.kind) {
    case 'MAX_WALLTIME':
      return `${num(v)} h`;
    case 'MAX_GPUS_PER_JOB':
      return `${num(v)} GPUs`;
    case 'MAX_NODES_PER_JOB':
      return `${num(v)} nodes`;
    case 'MAX_JOBS_PER_USER':
      return `${num(v)} jobs`;
    case 'MIN_GPU_UTIL':
      return `≥ ${num(v)}% GPU util`;
    case 'BUDGET_REMAINING':
    case 'FAIRSHARE_CAP':
      return v <= 1 ? `${Math.round(v * 100)}%` : num(v);
    default:
      return num(v, 2);
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

function appliesTo(p: Policy): React.ReactNode {
  if (p.scope === 'UNIVERSITY') return <span className="text-[var(--c3-style-basic-fg-secondary)]">All of Purdue</span>;
  if (p.scope === 'LAB') return <span className="truncate">{p.lab?.name ?? p.lab?.id ?? '—'}</span>;
  if (p.scope === 'PARTITION')
    return <ClusterTag id={p.cluster?.id} name={`${p.cluster?.name ?? p.cluster?.id ?? ''}${p.partition ? ` · ${p.partition.name ?? p.partition.id}` : ''}`} />;
  return <ClusterTag id={p.cluster?.id} name={p.cluster?.name ?? p.cluster?.id} />;
}

export default function AdminPolicies() {
  const [params, setParams] = useSearchParams();
  const { data, loading, error, reload } = useC3Data<Policy[]>(listPolicies, []);

  const [q, setQ] = useState(params.get('q') ?? '');
  const scope = params.get('scope') ?? 'ALL';
  const severity = params.get('severity') ?? 'ALL';
  const selectedId = params.get('rule');

  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value == null || value === '' || value === 'ALL') next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  // Debounce the search box into the URL.
  useEffect(() => {
    const t = window.setTimeout(() => setParam('q', q.trim() || null), 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const all = useMemo(() => data ?? [], [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((p) => (scope === 'ALL' || p.scope === scope) && (severity === 'ALL' || p.severity === severity))
      .filter(
        (p) =>
          !needle ||
          [p.id, p.title, p.description, p.kind, p.cluster?.name, p.partition?.name, p.lab?.name].some((s) => s?.toLowerCase().includes(needle)),
      )
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || a.id.localeCompare(b.id));
  }, [all, scope, severity, q]);

  const selected = all.find((p) => p.id === selectedId) ?? null;
  const filtered = scope !== 'ALL' || severity !== 'ALL' || Boolean(q);
  const clear = () => {
    setQ('');
    setParams(new URLSearchParams(), { replace: true });
  };

  // Escape closes the detail panel.
  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setParam('rule', null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const columns: Column<Policy>[] = [
    { key: 'id', header: 'ID', render: (p) => <span className="font-mono text-xs">{p.id}</span>, sortValue: (p) => p.id },
    {
      key: 'title',
      header: 'Rule',
      render: (p) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className={p.active === false ? 'truncate text-[var(--c3-style-basic-fg-secondary)]' : 'truncate font-medium'}>{p.title}</span>
          {p.active === false ? <ToneBadge tone="neutral">Inactive</ToneBadge> : null}
        </span>
      ),
      sortValue: (p) => p.title,
      className: 'max-w-[22rem]',
    },
    { key: 'severity', header: 'Severity', render: (p) => <SeverityBadge value={p.severity} />, sortValue: (p) => SEVERITY_RANK[p.severity] },
    { key: 'scope', header: 'Scope', render: (p) => <StatusBadge kind="ruleScope" value={p.scope} />, sortValue: (p) => p.scope, hideBelow: 'sm' },
    { key: 'applies', header: 'Applies to', render: appliesTo, sortValue: (p) => p.cluster?.name ?? p.lab?.name ?? '', className: 'max-w-56', hideBelow: 'md' },
    { key: 'kind', header: 'Check', render: (p) => humanize(p.kind), sortValue: (p) => p.kind, hideBelow: 'lg' },
    { key: 'limit', header: 'Limit', align: 'right', render: limitOf, hideBelow: 'lg' },
  ];

  const countBy = (key: 'scope' | 'severity', v: string) => all.filter((p) => v === 'ALL' || p[key] === v).length;

  return (
    <PageFrame
      title="Policies"
      description="University, cluster, partition and lab rules that every planned run is checked against"
      breadcrumbs={[{ label: 'Research Computing', href: '#/admin' }, { label: 'Policies' }]}
      toolbar={
        <>
          <SearchBox value={q} onChange={setQ} label="Search rules" placeholder="Search rules, clusters, labs" />
          <Segmented
            label="Scope"
            value={scope}
            onChange={(v) => setParam('scope', v)}
            options={[{ value: 'ALL', label: 'All scopes', count: countBy('scope', 'ALL') }, ...SCOPES.map((s) => ({ value: s, label: humanize(s), count: countBy('scope', s) }))]}
          />
          <Segmented
            label="Severity"
            value={severity}
            onChange={(v) => setParam('severity', v)}
            options={[{ value: 'ALL', label: 'Any severity' }, ...SEVERITIES.map((s) => ({ value: s, label: humanize(s), count: countBy('severity', s) }))]}
          />
          {filtered ? <ClearFilters onClick={clear} /> : null}
          <ResultCount>{`${rows.length} of ${all.length} rules`}</ResultCount>
        </>
      }
    >
      {error ? <ErrorState message={`Could not load policies: ${error}`} onRetry={reload} /> : null}

      <SectionCard flush>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          loading={loading && !data}
          onRowClick={(p) => setParam('rule', p.id)}
          pageSize={25}
          emptyLabel={filtered ? 'No rules match these filters' : 'No rules defined yet'}
          emptyHint={filtered ? 'Try another scope, severity or search term.' : undefined}
          emptyAction={filtered ? <ClearFilters onClick={clear} /> : undefined}
        />
      </SectionCard>

      {selected ? (
        <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={`Rule ${selected.id}`}>
          <button type="button" aria-label="Close rule detail" className="app-drawer__backdrop absolute inset-0" onClick={() => setParam('rule', null)} />
          <SidePanel
            behavior="overlay"
            className="relative w-[420px]! max-w-[92vw]"
            title={selected.title}
            subtitle={`${selected.id} · ${humanize(selected.kind)}`}
            onClose={() => setParam('rule', null)}
          >
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge value={selected.severity} />
                <StatusBadge kind="ruleScope" value={selected.scope} />
                {selected.active === false ? <ToneBadge tone="neutral">Inactive</ToneBadge> : <ToneBadge tone="good">Active</ToneBadge>}
              </div>
              {selected.description ? <p className="text-sm leading-6">{selected.description}</p> : null}
              <DetailList
                columns={1}
                items={[
                  { label: 'Applies to', value: appliesTo(selected) },
                  { label: 'Limit', value: limitOf(selected) },
                  {
                    label: 'Effect on a planned run',
                    value:
                      selected.severity === 'BLOCK'
                        ? 'A violating plan is rejected; the advisor only recommends options that satisfy it.'
                        : selected.severity === 'WARN'
                          ? 'The run can be submitted, with a warning shown in the rule check.'
                          : 'Informational: shown with the rule checks, never blocks.',
                  },
                  {
                    label: 'Source',
                    value: selected.sourceUrl ? (
                      <Link href={selected.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
                        {hostOf(selected.sourceUrl)} <ExternalLink className="size-3" aria-hidden />
                      </Link>
                    ) : (
                      'Lab / RCAC policy'
                    ),
                  },
                ]}
              />
              <div className="rounded-md bg-[var(--c3-style-basic-bg-secondary)] p-3 text-xs text-[var(--c3-style-basic-fg-secondary)]">
                <ScrollText className="mr-1.5 inline size-3.5 align-[-2px]" aria-hidden />
                Checked by <span className="font-mono">RunRequest.checkRules()</span> before every plan, together with the lab&apos;s allocation balance and deadlines.
              </div>
            </div>
          </SidePanel>
        </div>
      ) : null}
    </PageFrame>
  );
}
