/*
 * Research Computing — Data Fusion (/admin/data): lineage of every data path, sources -> pipelines -> EasyCompute
 * entities -> consumers, with per-node status, last load, rows loaded / rejected, freshness, and deep links into C3's
 * native Data Fusion, Data Monitoring, File Explorer and Lakehouse. Graph = node cards in a 4-column grid with SVG
 * connectors measured from the DOM (no extra deps); select a node to highlight its upstream/downstream path.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, Database, ExternalLink, FileStack, GitBranch, RefreshCw, Workflow } from 'lucide-react';

import {
  ErrorState,
  KeyValue,
  KpiRow,
  KpiRowSkeleton,
  KpiTile,
  Note,
  PageFrame,
  Pill,
  SectionCard,
  Skeleton,
  useC3Data,
  type Tone,
} from '@/components/app';
import { NATIVE_TOOL_LABEL, nativeToolUrl, type NativeTool } from '@/components/app/nativeTools';
import { Button } from '@/components/ui/button';
import { entityStat, feedStat, type EntityStat, type FeedStat } from '@/features/admin/api';
import { ENTITY_TYPES, LINEAGE_EDGES, LINEAGE_NODES, connected, type LineageKind } from '@/features/admin/lineage';
import { cn } from '@/lib/utils';

const COLUMNS: Array<{ kind: LineageKind; title: string; icon: React.ReactNode }> = [
  { kind: 'source', title: 'Sources', icon: <FileStack className="size-3.5" /> },
  { kind: 'pipeline', title: 'Pipelines', icon: <Workflow className="size-3.5" /> },
  { kind: 'entity', title: 'EasyCompute entities', icon: <Database className="size-3.5" /> },
  { kind: 'consumer', title: 'Consumers', icon: <Boxes className="size-3.5" /> },
];

interface NodeStatus {
  tone: Tone;
  label: string;
  rows: number | null;
  rejected: number | null;
  lastLoad: string | null;
  files?: number;
  note?: string;
}

const ago = (iso: string | null): string => {
  if (!iso) return '—';
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (Number.isNaN(h)) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
};
const fresh = (iso: string | null, slaHours = 24): Tone => {
  if (!iso) return 'neutral';
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  return h <= slaHours ? 'good' : h <= slaHours * 4 ? 'warn' : 'bad';
};
const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));
const maxIso = (a: Array<string | null>) => a.filter((x): x is string => Boolean(x)).sort().pop() ?? null;

interface Stats {
  feeds: Record<string, FeedStat>;
  entities: Record<string, EntityStat>;
  loadedAt: string;
}

async function loadStats(): Promise<Stats> {
  const feedNames = LINEAGE_NODES.filter((n) => n.kind === 'pipeline' && n.ref).map((n) => n.ref as string);
  const types = [...new Set(Object.values(ENTITY_TYPES).flat())];
  const [feeds, ents] = await Promise.all([Promise.all(feedNames.map(feedStat)), Promise.all(types.map(entityStat))]);
  return {
    feeds: Object.fromEntries(feeds.map((f) => [f.feed, f])),
    entities: Object.fromEntries(ents.map((e) => [e.type, e])),
    loadedAt: new Date().toISOString(),
  };
}

function computeStatus(stats: Stats | null): Record<string, NodeStatus> {
  const out: Record<string, NodeStatus> = {};
  if (!stats) return out;
  const entityOf = (id: string) => {
    const es = (ENTITY_TYPES[id] ?? []).map((t) => stats.entities[t]).filter(Boolean);
    const rows = es.some((e) => e.count != null) ? es.reduce((s, e) => s + (e.count ?? 0), 0) : null;
    return { rows, lastLoad: maxIso(es.map((e) => e.lastUpdated)), error: es.find((e) => e.error)?.error };
  };
  LINEAGE_NODES.filter((n) => n.kind === 'entity').forEach((n) => {
    const e = entityOf(n.id);
    const tone: Tone = e.error ? 'bad' : !e.rows ? 'bad' : fresh(e.lastLoad, n.slaHours);
    out[n.id] = {
      tone,
      label: e.error ? 'Unreachable' : !e.rows ? 'Empty' : tone === 'good' ? 'Fresh' : tone === 'warn' ? 'Aging' : 'Stale',
      rows: e.rows,
      rejected: null,
      lastLoad: e.lastLoad,
      note: e.error,
    };
  });
  LINEAGE_NODES.filter((n) => n.kind === 'pipeline').forEach((n) => {
    const targets = LINEAGE_EDGES.filter((x) => x.from === n.id).map((x) => out[x.to]);
    const targetLoad = maxIso(targets.map((t) => t?.lastLoad ?? null));
    if (n.native) {
      const tone = fresh(targetLoad, n.slaHours);
      out[n.id] = { tone, label: tone === 'good' ? 'Running' : tone === 'warn' ? 'Behind' : tone === 'bad' ? 'Stalled' : 'Idle', rows: null, rejected: null, lastLoad: targetLoad, note: 'App code (not a Data Fusion feed).' };
      return;
    }
    const f = n.ref ? stats.feeds[n.ref] : undefined;
    if (!f || !f.deployed) {
      out[n.id] = {
        tone: 'neutral',
        label: 'Seed load',
        rows: targets.reduce((s, t) => s + (t?.rows ?? 0), 0),
        rejected: null,
        lastLoad: targetLoad,
        note: 'Feed not yet deployed in C3 Data Fusion; entities were loaded from the package seed (C3.pkg().upsertAllSeed).',
      };
      return;
    }
    const tone: Tone = f.failedFiles > 0 ? 'warn' : fresh(f.lastLoad, n.slaHours);
    out[n.id] = {
      tone,
      label: f.failedFiles > 0 ? `${f.failedFiles} failed file${f.failedFiles > 1 ? 's' : ''}` : tone === 'good' ? 'Healthy' : tone === 'warn' ? 'Behind' : 'Stalled',
      rows: targets.reduce((s, t) => s + (t?.rows ?? 0), 0),
      rejected: f.rejected,
      lastLoad: f.lastLoad,
      files: f.files,
    };
  });
  LINEAGE_NODES.filter((n) => n.kind === 'source').forEach((n) => {
    const p = LINEAGE_EDGES.filter((x) => x.from === n.id).map((x) => out[x.to])[0];
    out[n.id] = p
      ? { tone: p.tone, label: p.label === 'Seed load' ? 'Seed snapshot' : p.label === 'Running' ? 'Streaming' : p.tone === 'good' ? 'Connected' : p.label, rows: p.rows, rejected: p.rejected, lastLoad: p.lastLoad, files: p.files }
      : { tone: 'neutral', label: 'Unknown', rows: null, rejected: null, lastLoad: null };
  });
  LINEAGE_NODES.filter((n) => n.kind === 'consumer').forEach((n) => {
    const ups = LINEAGE_EDGES.filter((x) => x.to === n.id).map((x) => out[x.from]);
    const bad = ups.filter((u) => u?.tone === 'bad').length;
    const warn = ups.filter((u) => u?.tone === 'warn').length;
    out[n.id] = { tone: bad ? 'bad' : warn ? 'warn' : 'good', label: bad ? 'Degraded inputs' : warn ? 'Aging inputs' : 'Inputs OK', rows: null, rejected: null, lastLoad: maxIso(ups.map((u) => u?.lastLoad ?? null)) };
  });
  return out;
}

const DOT: Record<Tone, string> = {
  good: 'bg-[var(--ec-accent-hi)]',
  accent: 'bg-[var(--ec-accent-hi)]',
  warn: 'bg-[var(--ec-warn)]',
  bad: 'bg-[var(--ec-bad)]',
  info: 'bg-[var(--ec-info)]',
  neutral: 'bg-[var(--ec-fg-3)]',
  pink: 'bg-[var(--ec-pink)]',
};

interface Path {
  key: string;
  d: string;
  from: string;
  to: string;
}

export default function AdminData() {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useC3Data(loadStats, []);
  const status = useMemo(() => computeStatus(data), [data]);
  const [selected, setSelected] = useState<string | null>('p-sacct');
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? selected;
  const lit = useMemo(() => (focus ? connected(focus) : null), [focus]);

  // Measure node cards and draw connectors.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [paths, setPaths] = useState<Path[]>([]);
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const box = wrap.getBoundingClientRect();
    const rect = (id: string) => wrap.querySelector<HTMLElement>(`[data-node="${id}"]`)?.getBoundingClientRect();
    const sameColumn = (a: DOMRect, b: DOMRect) => Math.abs(a.left - b.left) < 4;
    const next: Path[] = [];
    LINEAGE_EDGES.forEach((e) => {
      const a = rect(e.from);
      const b = rect(e.to);
      if (!a || !b || sameColumn(a, b) || b.left < a.right) return; // stacked layout: no connectors
      const x1 = a.right - box.left;
      const y1 = a.top + a.height / 2 - box.top;
      const x2 = b.left - box.left;
      const y2 = b.top + b.height / 2 - box.top;
      const dx = Math.max(24, (x2 - x1) / 2);
      next.push({ key: `${e.from}>${e.to}`, from: e.from, to: e.to, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2 - 6},${y2}` });
    });
    setSize({ w: box.width, h: box.height });
    setPaths(next);
  }, []);
  useLayoutEffect(() => {
    measure();
  }, [measure, data]);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measure]);

  const sel = LINEAGE_NODES.find((n) => n.id === selected) ?? null;
  const selStatus = sel ? status[sel.id] : undefined;
  const feedsDeployed = data ? Object.values(data.feeds).filter((f) => f.deployed).length : 0;
  const totalRows = data ? Object.values(data.entities).reduce((s, e) => s + (e.count ?? 0), 0) : 0;
  const rejected = data ? Object.values(data.feeds).reduce((s, f) => s + (f.rejected ?? 0), 0) : 0;
  const unhealthy = Object.entries(status).filter(([, s]) => s.tone === 'bad' || s.tone === 'warn').length;

  const toolButton = (tool: NativeTool, primary = false) => (
    <Button
      key={tool}
      variant={primary ? 'solid' : 'outline'}
      appearance={primary ? 'accent' : 'secondary'}
      trailingIcon={<ExternalLink />}
      onClick={() => window.open(nativeToolUrl(tool), '_blank', 'noopener')}
    >
      {NATIVE_TOOL_LABEL[tool]}
    </Button>
  );

  return (
    <PageFrame
      title="Data Fusion"
      description="Every data path behind EasyCompute: where it comes from, how it is loaded, which entities it fills and who uses it."
      breadcrumbs={[{ label: 'Research Computing', href: '#/admin' }, { label: 'Data' }]}
      actions={
        <>
          <Button variant="outline" appearance="secondary" leadingIcon={<RefreshCw />} onClick={reload}>
            Refresh
          </Button>
          {toolButton('datafusion', true)}
        </>
      }
    >
      {error ? <ErrorState message={`Could not load pipeline status: ${error}`} onRetry={reload} /> : null}

      {loading && !data ? (
        <KpiRowSkeleton />
      ) : (
        <KpiRow>
          <KpiTile label="Sources" value={LINEAGE_NODES.filter((n) => n.kind === 'source').length} caption="sacct, telemetry, ledger, status, context, simulator" />
          <KpiTile label="Data Fusion feeds" value={feedsDeployed} chip="of 4 deployed" tone={feedsDeployed === 4 ? 'good' : 'warn'} caption="FileSourceCollections in EasyComputeFeeds" />
          <KpiTile label="Rows in entities" value={totalRows.toLocaleString('en-US')} caption={data ? `checked ${ago(data.loadedAt)}` : ''} />
          <KpiTile
            label="Rejected rows"
            value={feedsDeployed ? rejected.toLocaleString('en-US') : '—'}
            tone={!feedsDeployed ? undefined : rejected ? 'warn' : 'good'}
            caption={feedsDeployed ? `${unhealthy} node${unhealthy === 1 ? '' : 's'} need attention` : 'IngestRejection fills once feeds run'}
          />
        </KpiRow>
      )}

      <SectionCard
        title="Lineage"
        actions={
          <span className="flex flex-wrap items-center gap-3 text-xs text-[var(--ec-fg-2)]">
            {(['good', 'warn', 'bad', 'neutral'] as Tone[]).map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn('size-[7px] rounded-full', DOT[t])} />
                {t === 'good' ? 'Healthy' : t === 'warn' ? 'Behind' : t === 'bad' ? 'Failing / empty' : 'Seed / idle'}
              </span>
            ))}
          </span>
        }
      >
        <div ref={wrapRef} className="relative" onMouseLeave={() => setHover(null)}>
          <svg aria-hidden className="pointer-events-none absolute inset-0 hidden lg:block" width={size.w} height={size.h}>
            <defs>
              <marker id="ec-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className="fill-[var(--ec-line-2)]" />
              </marker>
              <marker id="ec-arrow-on" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className="fill-[var(--ec-accent-hi)]" />
              </marker>
            </defs>
            {paths.map((p) => {
              const on = Boolean(lit && lit.has(p.from) && lit.has(p.to));
              return (
                <path
                  key={p.key}
                  d={p.d}
                  fill="none"
                  strokeWidth={on ? 1.75 : 1.25}
                  markerEnd={on ? 'url(#ec-arrow-on)' : 'url(#ec-arrow)'}
                  className={cn('transition-opacity', on ? 'stroke-[var(--ec-accent-hi)]' : 'stroke-[var(--ec-line-2)]', lit && !on ? 'opacity-30' : 'opacity-100')}
                />
              );
            })}
          </svg>
          <div className="relative grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-14">
            {COLUMNS.map((col) => (
              <div key={col.kind} className="flex min-w-0 flex-col gap-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--ec-fg-2)]">
                  {col.icon}
                  {col.title}
                </div>
                {LINEAGE_NODES.filter((n) => n.kind === col.kind).map((n) => {
                  const st = status[n.id];
                  const on = !lit || lit.has(n.id);
                  return (
                    <button
                      key={n.id}
                      type="button"
                      data-node={n.id}
                      onClick={() => setSelected(n.id)}
                      onMouseEnter={() => setHover(n.id)}
                      onFocus={() => setHover(n.id)}
                      onBlur={() => setHover(null)}
                      aria-pressed={selected === n.id}
                      className={cn(
                        'flex min-w-0 flex-col gap-1.5 rounded-lg border bg-[var(--ec-card)] px-3 py-2.5 text-left transition-[opacity,border-color]',
                        selected === n.id ? 'border-[var(--ec-accent-hi)]' : 'border-transparent hover:border-[var(--ec-line-2)]',
                        on ? 'opacity-100' : 'opacity-40',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className={cn('truncate text-sm font-medium text-[var(--ec-fg-hi)]', (n.kind === 'pipeline' || n.kind === 'entity') && 'font-mono text-[13px]')}>{n.label}</span>
                        {st ? <span aria-label={st.label} title={st.label} className={cn('size-[7px] shrink-0 rounded-full', DOT[st.tone])} /> : <Skeleton className="size-2 rounded-full" />}
                      </span>
                      <span className="truncate text-xs text-[var(--ec-fg-2)]">{n.sub}</span>
                      {n.kind !== 'consumer' ? (
                        <span className="flex items-center justify-between gap-2 text-[11px] text-[var(--ec-fg-3)] tabular-nums">
                          <span>{st ? (st.rows != null ? `${fmt(st.rows)} rows` : st.label) : ' '}</span>
                          <span className="font-mono">{st ? ago(st.lastLoad) : ''}</span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-[var(--ec-fg-3)]">{st?.label ?? ' '}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <SectionCard
          title={
            sel ? (
              <span className="flex flex-wrap items-center gap-2.5">
                <span className={sel.kind === 'pipeline' || sel.kind === 'entity' ? 'font-mono' : undefined}>{sel.label}</span>
                {selStatus ? (
                  <Pill tone={selStatus.tone} dot>
                    {selStatus.label}
                  </Pill>
                ) : null}
              </span>
            ) : (
              'Select a node'
            )
          }
          actions={sel ? <span className="text-[13px] text-[var(--ec-fg-2)] capitalize">{sel.kind}</span> : undefined}
        >
          {sel ? (
            <div className="flex flex-col gap-4">
              <p className="m-0 text-sm text-[var(--ec-fg)]">{sel.detail}</p>
              <KeyValue
                items={[
                  ...(sel.chain ? [{ label: 'Chain', value: <span className="font-mono text-[12.5px]">{sel.chain.join(' → ')}</span> }] : []),
                  ...(sel.kind === 'entity' ? [{ label: 'C3 types', value: <span className="font-mono text-[12.5px]">{(ENTITY_TYPES[sel.id] ?? []).join(', ')}</span> }] : []),
                  { label: 'Rows', value: fmt(selStatus?.rows) },
                  ...(sel.kind === 'pipeline' && !sel.native ? [{ label: 'Rejected rows', value: selStatus?.rejected == null ? '—' : fmt(selStatus.rejected) }] : []),
                  ...(selStatus?.files != null ? [{ label: 'Source files', value: fmt(selStatus.files) }] : []),
                  { label: 'Last load', value: selStatus?.lastLoad ? `${new Date(selStatus.lastLoad).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${ago(selStatus.lastLoad)}` : '—' },
                  ...(sel.slaHours ? [{ label: 'Freshness target', value: sel.slaHours >= 24 ? `${sel.slaHours / 24} d` : `${sel.slaHours} h` }] : []),
                  {
                    label: 'Upstream',
                    value: LINEAGE_EDGES.filter((e) => e.to === sel.id).map((e) => LINEAGE_NODES.find((n) => n.id === e.from)?.label).join(', ') || '—',
                  },
                  {
                    label: 'Downstream',
                    value: LINEAGE_EDGES.filter((e) => e.from === sel.id).map((e) => LINEAGE_NODES.find((n) => n.id === e.to)?.label).join(', ') || '—',
                  },
                ]}
              />
              {selStatus?.note ? <Note tone={selStatus.tone === 'bad' ? 'bad' : 'info'}>{selStatus.note}</Note> : null}
              <div className="flex flex-wrap gap-2">
                {sel.kind === 'consumer' && sel.route ? (
                  <Button variant="outline" appearance="secondary" leadingIcon={<GitBranch />} onClick={() => navigate(sel.route as string)}>
                    Open {sel.label}
                  </Button>
                ) : null}
                {sel.kind === 'pipeline' && !sel.native ? (
                  <>
                    {toolButton('datafusion')}
                    {toolButton('data-integration')}
                  </>
                ) : null}
                {sel.kind === 'source' ? toolButton('file-explorer') : null}
                {sel.kind === 'entity' ? toolButton('lakehouse') : null}
              </div>
            </div>
          ) : (
            <p className="m-0 text-sm text-[var(--ec-fg-2)]">Select a node in the lineage to see its loads and links.</p>
          )}
        </SectionCard>
        <SectionCard title="C3 native data tools">
          <div className="flex flex-col">
            {(
              [
                ['datafusion', 'Feeds, canonical types, transforms and validation rules'],
                ['data-integration', 'Load runs, throughput, failed files and source status'],
                ['file-explorer', 'Inbox / archive files behind each feed'],
                ['lakehouse', 'Query entity tables with SQL'],
              ] as Array<[NativeTool, string]>
            ).map(([tool, text]) => (
              <a
                key={tool}
                href={nativeToolUrl(tool)}
                target="_blank"
                rel="noreferrer"
                className="-mx-2 flex items-center justify-between gap-3 rounded-md border-b border-[var(--ec-line)] px-2 py-3 last:border-b-0 hover:bg-[var(--ec-card)]"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-[var(--ec-fg-hi)]">{NATIVE_TOOL_LABEL[tool]}</span>
                  <span className="block text-[13px] text-[var(--ec-fg-2)]">{text}</span>
                </span>
                <ExternalLink className="size-4 shrink-0 text-[var(--ec-fg-2)]" aria-hidden />
              </a>
            ))}
          </div>
        </SectionCard>
      </div>
    </PageFrame>
  );
}
