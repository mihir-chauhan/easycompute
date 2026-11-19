/*
 * Policies & rules (mockup policies.html). Served at /admin/policies (Research Computing: every rule) and /policies
 * (lab view: university, cluster and partition rules plus the current lab's own rules). Category tabs, search,
 * cluster + enforcement filters, upstream-change note, rules table with "Blocks (30d)", rule detail panel
 * (?rule=<id>), "Test a configuration" dry-run and "How rules apply".
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ExternalLink, Plus, RefreshCw } from 'lucide-react';

import {
  CheckRow,
  ClearFilters,
  DataTable,
  ErrorState,
  ModelComputing,
  ModelProvenance,
  Note,
  PageFrame,
  Pill,
  ResultCount,
  SearchBox,
  SectionCard,
  Segmented,
  SelectPill,
  StatusBadge,
  humanize,
  useAppShell,
  useC3Data,
  type Column,
  type Tone,
} from '@/components/app';
import { KeyValue } from '@/components/app/Blocks';
import { Button } from '@/components/ui/button';
import { SidePanel } from '@/components/ui/side-panel';
import { listFailedChecks, listPartitions, listPolicies } from '@/features/admin/api';
import { num } from '@/features/admin/components';
import type { Partition, Policy } from '@/features/admin/types';

type Category = 'RCAC' | 'ACCESS' | 'LAB' | 'FUNDING';
const CATEGORY_LABEL: Record<Category, string> = { RCAC: 'Purdue RCAC', ACCESS: 'ACCESS', LAB: 'Lab', FUNDING: 'Funding' };
const SEVERITY_RANK: Record<string, number> = { BLOCK: 0, WARN: 1, INFO: 2 };

const categoryOf = (p: Policy): Category => {
  if (p.kind === 'BUDGET_REMAINING') return 'FUNDING';
  if (p.scope === 'LAB') return 'LAB';
  if (p.cluster?.id === 'anvil' || p.partition?.id?.startsWith('anvil')) return 'ACCESS';
  return 'RCAC';
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** "rcac · gautschi/queues" from an RCAC user-guide URL; "lab context" for lab rules. */
function sourceOf(p: Policy): string {
  if (!p.sourceUrl) return p.scope === 'LAB' ? 'lab context' : 'policy';
  try {
    const u = new URL(p.sourceUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const org = u.hostname.includes('rcac') ? 'rcac' : u.hostname.includes('access') ? 'access-ci' : u.hostname.replace(/^www\./, '').split('.')[0];
    const ug = parts.indexOf('userguides');
    const tail = ug >= 0 ? [parts[ug + 1], parts[parts.length - 1]].filter(Boolean).join('/') : parts.slice(-2).join('/');
    return tail ? `${org} · ${tail}` : org;
  } catch {
    return 'policy';
  }
}

function limitOf(p: Policy): string {
  const v = p.limitValue;
  switch (p.kind) {
    case 'MAX_WALLTIME':
      return v == null ? p.limitText ?? '—' : v >= 48 && v % 24 === 0 ? `≤ ${v / 24} days` : `≤ ${num(v)} h`;
    case 'MAX_GPUS_PER_JOB':
      return v == null ? p.limitText ?? '—' : `≤ ${num(v)} GPUs`;
    case 'MAX_NODES_PER_JOB':
      return v == null ? p.limitText ?? '—' : `≤ ${num(v)} nodes`;
    case 'MAX_JOBS_PER_USER':
      return v == null ? p.limitText ?? '—' : `≤ ${num(v)} jobs / user`;
    case 'MIN_GPU_UTIL':
      return v == null ? p.limitText ?? '—' : `≥ ${num(v)}% GPU util`;
    case 'BUDGET_REMAINING':
    case 'FAIRSHARE_CAP':
      return p.limitText && p.limitText.length > 4 ? p.limitText : v == null ? '—' : v <= 1 ? `≥ ${Math.round(v * 100)}% left` : `${num(v)} ${p.limitText ?? ''}`.trim();
    default:
      return p.limitText ?? (v != null ? num(v, 2) : '—');
  }
}

const scopeOf = (p: Policy): string => {
  if (p.scope === 'UNIVERSITY') return 'Purdue';
  if (p.scope === 'LAB') return p.cluster?.name ? `Lab · ${p.cluster.name}` : 'Lab';
  if (p.scope === 'PARTITION') return `${p.cluster?.name ?? p.cluster?.id ?? ''} · ${p.partition?.name ?? p.partition?.id ?? ''}`;
  return p.cluster?.name ?? p.cluster?.id ?? '—';
};

const ENFORCEMENT: Array<{ tone: Tone; label: string; text: string }> = [
  { tone: 'bad', label: 'Hard block', text: 'EasyCompute refuses to submit and offers a compliant plan.' },
  { tone: 'info', label: 'Auto-fixed', text: 'The job script is rewritten, for example adding --mem or splitting walltime into chained jobs.' },
  { tone: 'pink', label: 'PI approval', text: 'The run waits until the PI approves it in EasyCompute or by email.' },
  { tone: 'warn', label: 'Warn', text: 'Allowed, with the risk shown in the plan.' },
  { tone: 'neutral', label: 'Advisory', text: 'Used for ranking options, never blocks.' },
];

const SAMPLE = `# proposed by user_017
#SBATCH -A ramirez -p ai -q normal
#SBATCH --gpus=16 --time=5-00:00:00
#SBATCH --job-name=occ-sweep-wd`;

/** "5-00:00:00" | "36:00:00" | "90" (min) -> hours. */
const parseTime = (t: string): number | null => {
  const m = /^(?:(\d+)-)?(\d+)(?::(\d+))?(?::(\d+))?$/.exec(t.trim());
  if (!m) return null;
  const [, d, a, b] = m;
  if (d != null) return Number(d) * 24 + Number(a) + (b ? Number(b) / 60 : 0);
  if (b != null) return Number(a) + Number(b) / 60;
  return Number(a) / 60;
};

interface DryRunResult {
  status: 'ok' | 'warn' | 'crit' | 'info';
  title: string;
  detail: string;
  src: string;
}

/** Client-side dry run of the numeric limits; the authoritative check is RunRequest.checkRules() on the server. */
function dryRun(script: string, cluster: string, policies: Policy[], partitions: Partition[], labId: string | null): DryRunResult[] {
  const flag = (re: RegExp) => re.exec(script)?.[1];
  const part = flag(/(?:-p|--partition)[ =]([\w.-]+)/);
  const qos = flag(/(?:-q|--qos)[ =]([\w.-]+)/) ?? 'normal';
  const gpus = Number(flag(/--gpus(?:-per-node)?[ =](\d+)/) ?? flag(/--gres[ =]gpu(?::\w+)?:(\d+)/) ?? 0);
  const nodes = Number(flag(/(?:-N|--nodes)[ =](\d+)/) ?? 1);
  const time = flag(/(?:-t|--time)[ =]([\d:-]+)/);
  const hours = time ? parseTime(time) : null;
  const out: DryRunResult[] = [];
  const candidates = partitions.filter((p) => p.cluster?.id === cluster && (!part || (p.slurmPartition ?? p.name) === part));
  const pt = candidates.find((p) => (p.qos ?? 'normal') === qos) ?? candidates[0];
  if (!pt) {
    out.push({ status: 'crit', title: `No partition "${part ?? '?'}" on ${cluster}`, detail: 'Pick a partition that exists on this cluster.', src: cluster });
    return out;
  }
  const label = `${pt.slurmPartition ?? pt.name} · ${pt.qos ?? 'normal'}`;
  if (hours != null && pt.maxWalltimeHours != null) {
    const ok = hours <= pt.maxWalltimeHours;
    const alt = partitions.filter((p) => p.cluster?.id === cluster && (p.slurmPartition ?? p.name) === (pt.slurmPartition ?? pt.name) && (p.maxWalltimeHours ?? 0) >= hours && p.id !== pt.id);
    out.push({
      status: ok ? 'ok' : 'crit',
      title: ok ? `Walltime ${num(hours, 1)} h within the ${label} limit` : `Walltime ${num(hours, 1)} h exceeds the ${num(pt.maxWalltimeHours)} h ${label} limit`,
      detail: ok ? `Limit ${num(pt.maxWalltimeHours)} h.` : alt.length ? `Use ${alt.map((a) => a.qos).join(' or ')} QOS, or split into ${Math.ceil(hours / pt.maxWalltimeHours)} chained jobs with checkpoints.` : `Split into ${Math.ceil(hours / pt.maxWalltimeHours)} chained jobs with checkpoints.`,
      src: cluster,
    });
  }
  if (pt.maxGpusPerJob != null && gpus > 0) {
    const ok = gpus <= pt.maxGpusPerJob;
    out.push({ status: ok ? 'ok' : 'crit', title: `${gpus} GPUs ${ok ? '≤' : '>'} ${pt.maxGpusPerJob} per job`, detail: ok ? `Within the ${label} per-job ceiling.` : `Lower --gpus to ${pt.maxGpusPerJob} or use a larger partition.`, src: cluster });
  }
  if (pt.maxNodesPerJob != null && nodes > pt.maxNodesPerJob) {
    out.push({ status: 'crit', title: `${nodes} nodes > ${pt.maxNodesPerJob} per job`, detail: 'Reduce --nodes.', src: cluster });
  }
  if (pt.preemptible) out.push({ status: 'warn', title: `${label} is preemptible`, detail: 'Jobs may be requeued with ~10 min notice; checkpoint often.', src: cluster });
  // Lab rules on sweeps / QOS (text match, informational).
  policies
    .filter((p) => p.scope === 'LAB' && p.active !== false && (!labId || p.lab?.id === labId) && (!p.cluster || p.cluster.id === cluster))
    .slice(0, 3)
    .forEach((p) => out.push({ status: p.severity === 'BLOCK' ? 'warn' : 'info', title: p.title, detail: p.description ?? 'Lab rule; checked in full when the run is planned.', src: 'lab' }));
  return out;
}

export default function AdminPolicies() {
  const navigate = useNavigate();
  const { view, labId, clusterId } = useAppShell();
  const [params, setParams] = useSearchParams();
  const { data, loading, error, reload } = useC3Data(async () => {
    const [policies, partitions, fails] = await Promise.all([listPolicies(), listPartitions(), listFailedChecks().catch(() => [])]);
    return { policies, partitions, fails };
  }, []);

  const [q, setQ] = useState(params.get('q') ?? '');
  const category = params.get('cat') ?? 'ALL';
  const severity = params.get('severity') ?? 'ALL';
  const cluster = params.get('cluster') ?? clusterId ?? 'ALL';
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

  useEffect(() => {
    const t = window.setTimeout(() => setParam('q', q.trim() || null), 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Lab view: the current lab's rules plus every non-lab rule.
  const all = useMemo(
    () => (data?.policies ?? []).filter((p) => view === 'admin' || p.scope !== 'LAB' || !labId || p.lab?.id === labId),
    [data, view, labId],
  );
  const blocks = useMemo(() => {
    const since = Date.now() - 30 * 86400000;
    const m = new Map<string, number>();
    (data?.fails ?? []).forEach((f) => {
      if (f.policy?.id && (!f.checkedAt || new Date(f.checkedAt).getTime() >= since)) m.set(f.policy.id, (m.get(f.policy.id) ?? 0) + 1);
    });
    return m;
  }, [data]);
  const clusters = useMemo(() => {
    const m = new Map<string, string>();
    all.forEach((p) => p.cluster && m.set(p.cluster.id, p.cluster.name ?? p.cluster.id));
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [all]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((p) => (category === 'ALL' || categoryOf(p) === category) && (severity === 'ALL' || p.severity === severity))
      .filter((p) => cluster === 'ALL' || !p.cluster || p.cluster.id === cluster)
      .filter((p) => !needle || [p.id, p.title, p.description, p.kind, p.cluster?.name, p.partition?.name, p.lab?.name].some((s) => s?.toLowerCase().includes(needle)))
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || a.id.localeCompare(b.id));
  }, [all, category, severity, cluster, q]);

  const selected = all.find((p) => p.id === selectedId) ?? null;
  const filtered = category !== 'ALL' || severity !== 'ALL' || cluster !== 'ALL' || Boolean(q);
  const clear = () => {
    setQ('');
    setParams(new URLSearchParams(), { replace: true });
  };
  const countCat = (c: string) => all.filter((p) => c === 'ALL' || categoryOf(p) === c).length;

  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setParam('rule', null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Test a configuration
  const [script, setScript] = useState(SAMPLE);
  const [testCluster, setTestCluster] = useState('gautschi');
  // Brief "ClusterPolicyEngine is checking N rules…" state while the user edits the script.
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setChecking(true);
    const t = window.setTimeout(() => setChecking(false), 450);
    return () => window.clearTimeout(t);
  }, [script, testCluster]);
  const results = useMemo(() => (data ? dryRun(script, testCluster, data.policies, data.partitions, labId) : []), [data, script, testCluster, labId]);
  const testClusters = useMemo(() => {
    const m = new Map<string, string>();
    (data?.partitions ?? []).forEach((p) => p.cluster && m.set(p.cluster.id, p.cluster.name ?? p.cluster.id));
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [data]);

  const columns: Column<Policy>[] = [
    {
      key: 'title',
      header: 'Rule',
      render: (p) => (
        <span className="flex max-w-[64vw] min-w-0 flex-col sm:max-w-[22rem]">
          <span className={p.active === false ? 'truncate font-medium text-[var(--ec-fg-2)]' : 'truncate font-medium text-[var(--ec-fg-hi)]'}>
            {p.title}
            {p.active === false ? <span className="ml-2 text-xs text-[var(--ec-fg-3)]">inactive</span> : null}
          </span>
          {p.description ? <span className="mt-0.5 truncate text-xs text-[var(--ec-fg-2)]">{p.description}</span> : null}
        </span>
      ),
      sortValue: (p) => p.title,
    },
    { key: 'scope', header: 'Scope', render: scopeOf, sortValue: scopeOf, className: 'max-w-48 truncate', hideBelow: 'sm' },
    { key: 'limit', header: 'Limit', render: (p) => <span className="block max-w-64 truncate font-mono text-[12.5px] text-[var(--ec-fg)]">{limitOf(p)}</span>, hideBelow: 'md' },
    { key: 'severity', header: 'Enforcement', render: (p) => <StatusBadge kind="ruleSeverity" value={p.severity} />, sortValue: (p) => SEVERITY_RANK[p.severity] },
    { key: 'source', header: 'Source', render: (p) => <span className="font-mono text-[11px] text-[var(--ec-fg-3)]">{sourceOf(p)}</span>, hideBelow: 'lg' },
    { key: 'blocks', header: 'Blocks (30d)', align: 'right', render: (p) => num(blocks.get(p.id) ?? 0), sortValue: (p) => blocks.get(p.id) ?? 0 },
  ];

  return (
    <PageFrame
      title="Policies & rules"
      description="Every plan EasyCompute makes is checked against these rules before it is submitted. Purdue rules sync from the RCAC user guides."
      breadcrumbs={view === 'admin' ? [{ label: 'Research Computing', href: '#/admin' }, { label: 'Policies' }] : undefined}
      tabs={
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex h-[34px] items-center gap-2 rounded-md border border-[var(--ec-line-2)] px-2.5 text-sm font-medium">
              <span aria-hidden className="size-[7px] rounded-full bg-[var(--ec-accent-hi)]" />
              <span className="text-[var(--ec-fg-2)]">RCAC sync:</span>
              <span className="text-[var(--ec-fg-hi)]">2 h ago</span>
            </span>
            <Button variant="outline" appearance="secondary" leadingIcon={<RefreshCw />} onClick={reload}>
              Re-sync
            </Button>
            {view === 'lab' ? (
              <Button variant="outline" appearance="secondary" leadingIcon={<Plus />} onClick={() => navigate('/context')}>
                Add lab rule
              </Button>
            ) : null}
          </div>
          <Segmented
            label="Rule source"
            value={category}
            onChange={(v) => setParam('cat', v)}
            options={[{ value: 'ALL', label: 'All', count: countCat('ALL') }, ...(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c], count: countCat(c) }))]}
          />
        </div>
      }
      toolbar={
        <>
          <SearchBox value={q} onChange={setQ} label="Search rules" placeholder="Search rules" />
          <SelectPill label="Cluster" value={cluster} onChange={(v) => setParam('cluster', v)} options={[{ value: 'ALL', label: 'All' }, ...clusters]} />
          <SelectPill
            label="Enforcement"
            value={severity}
            onChange={(v) => setParam('severity', v)}
            options={[
              { value: 'ALL', label: 'Any' },
              { value: 'BLOCK', label: 'Hard block' },
              { value: 'WARN', label: 'Warn' },
              { value: 'INFO', label: 'Advisory' },
            ]}
          />
          {filtered ? <ClearFilters onClick={clear} /> : null}
          <ResultCount>{`${rows.length} of ${all.length} rules`}</ResultCount>
        </>
      }
    >
      <Note title="Changed upstream on Nov 2">
        Gautschi now gives each group a GPU share based on its semester usage, and normal QOS on the ai partition is limited to 4 days (was 14). EasyCompute updated the
        affected rules and re-planned queued runs.
      </Note>

      {error ? <ErrorState message={`Could not load policies: ${error}`} onRetry={reload} /> : null}

      <SectionCard
        flush
        title={`${rows.length} rules`}
        actions={
          loading && !data ? (
            <ModelComputing component="ClusterPolicyEngine" verb="is loading the policy set" />
          ) : (
            <ModelProvenance component="ClusterPolicyEngine" provenance={{ component: 'ClusterPolicyEngine', rulesEvaluated: all.length, policyVersion: 'RCAC sync 2026-11-02' }} />
          )
        }
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          loading={loading && !data}
          onRowClick={(p) => setParam('rule', p.id)}
          pageSize={20}
          emptyLabel={filtered ? 'No rules match these filters' : 'No rules defined yet'}
          emptyHint={filtered ? 'Try another source, cluster or enforcement level.' : undefined}
          emptyAction={filtered ? <ClearFilters onClick={clear} /> : undefined}
        />
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard
          title="Test a configuration"
          actions={
            data ? (
              <ModelProvenance component="ClusterPolicyEngine" provenance={{ component: 'ClusterPolicyEngine', rulesEvaluated: all.filter((p) => p.active !== false).length, policyVersion: 'RCAC sync 2026-11-02', mode: 'client dry-run of numeric limits' }} compact />
            ) : undefined
          }
          className="h-full"
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <SelectPill label="Cluster" value={testCluster} onChange={setTestCluster} options={testClusters.length ? testClusters : [{ value: 'gautschi', label: 'Gautschi' }]} />
            </div>
            <label htmlFor="ec-test-script" className="sr-only">
              Job script to test
            </label>
            <textarea
              id="ec-test-script"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              spellCheck={false}
              rows={5}
              className="ec-code min-h-28 resize-y whitespace-pre text-[var(--ec-fg)] outline-none focus-visible:border-[var(--ec-fg-3)]"
            />
            <div>
              {checking ? <ModelComputing component="ClusterPolicyEngine" verb={`is checking ${all.filter((p) => p.active !== false).length} rules`} variant="card" /> : null}
              {!checking && results.map((r, i) => (
                <CheckRow key={i} status={r.status} title={r.title} detail={r.detail} right={r.src} />
              ))}
            </div>
            <p className="m-0 text-xs text-[var(--ec-fg-3)]">Full check (budget, deadlines, lab rules) runs in the Launch planner via RunRequest.checkRules().</p>
          </div>
        </SectionCard>
        <SectionCard title="How rules apply" className="h-full">
          <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-5 gap-y-3 text-sm">
            {ENFORCEMENT.map((e) => (
              <React.Fragment key={e.label}>
                <Pill tone={e.tone}>{e.label}</Pill>
                <span className="text-[var(--ec-fg)]">{e.text}</span>
              </React.Fragment>
            ))}
          </div>
        </SectionCard>
      </div>

      {selected ? (
        <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={`Rule ${selected.id}`}>
          <button type="button" aria-label="Close rule detail" className="absolute inset-0 bg-black/50" onClick={() => setParam('rule', null)} />
          <SidePanel
            behavior="overlay"
            className="relative w-[440px]! max-w-[92vw] border-[var(--ec-line)]! bg-[var(--ec-bar)]!"
            title={selected.title}
            subtitle={`${selected.id} · ${humanize(selected.kind)}`}
            onClose={() => setParam('rule', null)}
          >
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="ruleSeverity" value={selected.severity} />
                <Pill tone="neutral">{CATEGORY_LABEL[categoryOf(selected)]}</Pill>
                {selected.active === false ? <Pill tone="neutral">Inactive</Pill> : <Pill tone="good">Active</Pill>}
              </div>
              {selected.description ? <p className="m-0 text-sm leading-6 text-[var(--ec-fg)]">{selected.description}</p> : null}
              <KeyValue
                items={[
                  { label: 'Scope', value: scopeOf(selected) },
                  ...(selected.lab ? [{ label: 'Lab', value: selected.lab.name ?? selected.lab.id }] : []),
                  { label: 'Limit', value: <span className="font-mono text-[12.5px]">{limitOf(selected)}</span> },
                  { label: 'Blocks (30d)', value: num(blocks.get(selected.id) ?? 0) },
                  {
                    label: 'Effect',
                    value:
                      selected.severity === 'BLOCK'
                        ? 'A violating plan is refused; only compliant options are recommended.'
                        : selected.severity === 'WARN'
                          ? 'Allowed, with the risk shown in the rule checks.'
                          : 'Advisory: used for ranking, never blocks.',
                  },
                  {
                    label: 'Source',
                    value: selected.sourceUrl ? (
                      <a href={selected.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--ec-accent-text)] hover:underline">
                        {hostOf(selected.sourceUrl)} <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ) : (
                      sourceOf(selected)
                    ),
                  },
                ]}
              />
            </div>
          </SidePanel>
        </div>
      ) : null}
    </PageFrame>
  );
}
