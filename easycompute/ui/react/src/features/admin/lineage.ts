/*
 * EasyCompute data lineage: sources -> pipelines -> entities -> consumers. Pipeline names follow the native-data
 * agent's C3 Data Fusion build (STATUS.md "native-data"): FileSourceSystem EasyComputeFeeds with feeds
 * SlurmSacctFeed, JobTelemetryFeed, AllocationLedgerFeed, ClusterStatusFeed (Source* -> Canonical* -> entity, rejects
 * -> IngestRejection). Live stats come from features/admin/api.ts (feedStat / entityStat).
 */

export type LineageKind = 'source' | 'pipeline' | 'entity' | 'model' | 'consumer';

export interface LineageNode {
  id: string;
  kind: LineageKind;
  label: string;
  /** One line under the label. */
  sub: string;
  /** Longer description for the detail panel. */
  detail: string;
  /** pipeline: FileSourceCollection name to query; entity: C3 type name. */
  ref?: string;
  /** pipeline: canonical + transform chain shown in the detail panel. */
  chain?: string[];
  /** consumer: in-app route. */
  route?: string;
  /** Pipelines that are app code, not C3 Data Fusion feeds (no FileSourceCollection). */
  native?: boolean;
  /** Freshness expectation in hours (warn after 1x, bad after 4x). */
  slaHours?: number;
  /** model: MODEL_MAP component name (provenance chip, catalogue). */
  component?: string;
}

export interface LineageEdge {
  from: string;
  to: string;
}

export const LINEAGE_NODES: LineageNode[] = [
  // Sources
  { id: 'src-sacct', kind: 'source', label: 'Slurm sacct exports', sub: 'Anvil · Gilbreth · Gautschi · .psv', detail: 'Pipe-separated `sacct` accounting exports per cluster (JobID, account, partition, TRES, elapsed, state, MaxRSS). Users and paths are pseudonymized before load.' },
  { id: 'src-dcgm', kind: 'source', label: 'DCGM / node telemetry', sub: 'GPU util, memory, power · 10 s samples', detail: 'NVIDIA DCGM exporter and node metrics (GPU SM utilization, GPU memory, power, CPU, RAM, I/O, checkpoint age) for running jobs.' },
  { id: 'src-ledger', kind: 'source', label: 'Allocation & billing ledger', sub: 'Node shares · ACCESS SUs · cloud USD', detail: 'Purchased node shares and GPU-hour banks (RCAC), NSF ACCESS SU awards and third-party cloud credits, with usage to date.' },
  { id: 'src-status', kind: 'source', label: 'Cluster status snapshots', sub: 'sinfo / showpartitions / squeue', detail: 'Partition limits, idle/total nodes, queue depth and wait estimates per partition, plus cluster state (online, degraded, retired).' },
  { id: 'src-context', kind: 'source', label: 'Lab context dumps', sub: 'Free text pasted by labs', detail: 'What is unique to each lab: funding, deadlines, data restrictions, preferences. Parsed into constraints and lab rules.' },
  { id: 'src-sim', kind: 'source', label: 'Live Slurm + DCGM stream', sub: 'squeue / sstat / DCGM · every minute', detail: 'Streaming job state and GPU telemetry for running jobs: advances job state, appends metric samples, feeds the guardrail engine.' },
  // Pipelines
  { id: 'p-sacct', kind: 'pipeline', label: 'SlurmSacctFeed', sub: 'SourceSlurmSacct → CanonicalSlurmJob', detail: 'C3 Data Fusion feed: parses sacct rows, aggregates job steps, computes efficiency and cost units, rejects malformed rows to IngestRejection.', ref: 'SlurmSacctFeed', chain: ['SourceSlurmSacct', 'CanonicalSlurmJob', 'Transform CanonicalSlurmJob-Job', 'Job'], slaHours: 24 },
  { id: 'p-telemetry', kind: 'pipeline', label: 'JobTelemetryFeed', sub: 'SourceJobTelemetry → CanonicalJobTelemetry', detail: 'C3 Data Fusion feed: one sample per job per interval into JobMetric.', ref: 'JobTelemetryFeed', chain: ['SourceJobTelemetry', 'CanonicalJobTelemetry', 'Transform CanonicalJobTelemetry-JobMetric', 'JobMetric'], slaHours: 1 },
  { id: 'p-ledger', kind: 'pipeline', label: 'AllocationLedgerFeed', sub: 'SourceAllocationLedger → CanonicalAllocationLedger', detail: 'C3 Data Fusion feed: allocation totals, used units and periods into Allocation.', ref: 'AllocationLedgerFeed', chain: ['SourceAllocationLedger', 'CanonicalAllocationLedger', 'Transform CanonicalAllocationLedger-Allocation', 'Allocation'], slaHours: 24 },
  { id: 'p-status', kind: 'pipeline', label: 'ClusterStatusFeed', sub: 'SourcePartitionStatus → CanonicalPartitionStatus', detail: 'C3 Data Fusion feed: partition limits, queue depth, wait and utilization into Partition; cluster state into ComputeCluster.', ref: 'ClusterStatusFeed', chain: ['SourcePartitionStatus', 'CanonicalPartitionStatus', 'Transforms → Partition, ComputeCluster'], slaHours: 6 },
  { id: 'p-context', kind: 'pipeline', label: 'Advisor.extractConstraints', sub: 'LLM + rules parser', detail: 'App code: the AI Advisor parses each lab context dump into deadlines, budget limits and lab rules (Policy scope LAB).', native: true, slaHours: 168 },
  { id: 'p-monitor', kind: 'pipeline', label: 'RunMonitor.tick', sub: 'Ingest · evaluateHealth · guardrails', detail: 'App code (CronJob EasyComputeMonitorTick): appends JobMetric samples, raises JobAlert rows, logs guardrail actions to ActionLogEntry.', native: true, slaHours: 1 },
  // Entities
  { id: 'e-job', kind: 'entity', label: 'Job', sub: 'History + live runs', detail: 'One row per Slurm job (history) or live run.', ref: 'Job', slaHours: 24 },
  { id: 'e-metric', kind: 'entity', label: 'JobMetric', sub: 'Time series per live job', detail: 'GPU/CPU/memory/I/O/power samples.', ref: 'JobMetric', slaHours: 1 },
  { id: 'e-alert', kind: 'entity', label: 'JobAlert · ActionLogEntry', sub: 'Alerts and guardrail actions', detail: 'Health alerts and every action taken or awaiting approval.', ref: 'JobAlert', slaHours: 24 },
  { id: 'e-alloc', kind: 'entity', label: 'Allocation', sub: 'Budgets per lab and cluster', detail: 'Allocation balances used for budget checks and burn alerts.', ref: 'Allocation', slaHours: 24 },
  { id: 'e-part', kind: 'entity', label: 'Partition · ComputeCluster', sub: 'Limits, queues, capacity', detail: 'Partition limits and queue state; cluster capacity and billing.', ref: 'Partition', slaHours: 24 },
  { id: 'e-lab', kind: 'entity', label: 'Lab · Policy', sub: 'Context and rules', detail: 'Labs with their context dump; university, cluster, partition and lab rules.', ref: 'Policy', slaHours: 168 },
  // Models & engines (MODEL_MAP.md)
  { id: 'm-runtime', kind: 'model', label: 'AnvilRuntimeQ50Q90', sub: 'Quantile regression · P50/P90 runtime', detail: 'LinearQuantileRegressor (pinball loss) trained on completed Anvil parent jobs from the sacct history, temporal holdout. Historical only.', component: 'AnvilRuntimeQ50Q90' },
  { id: 'm-wait', kind: 'model', label: 'AnvilQueueWaitQ50Q90', sub: 'Quantile regression · queue wait', detail: 'LinearQuantileRegressor on started Anvil parent jobs. Low confidence: the archive has no backlog snapshots.', component: 'AnvilQueueWaitQ50Q90' },
  { id: 'm-cpu', kind: 'model', label: 'AnvilTaskCPUQ50Q90', sub: 'Quantile regression · CPU demand', detail: 'Per-task core-equivalent from parent requests + batch-step AveCPU; right-sizing evidence only.', component: 'AnvilTaskCPUQ50Q90' },
  { id: 'm-mem', kind: 'model', label: 'AnvilHostMemoryQ50Q90', sub: 'Quantile regression · host memory', detail: 'Host memory P50/P90 from parent requests + batch-step TRES memory (no GPU VRAM in the archive).', component: 'AnvilHostMemoryQ50Q90' },
  { id: 'm-policy', kind: 'model', label: 'ClusterPolicyEngine', sub: 'Versioned deterministic rules', detail: 'Exact, explainable checks of every plan against Purdue, cluster, partition and lab rules.', component: 'ClusterPolicyEngine' },
  { id: 'm-underuse', kind: 'model', label: 'GPUUnderuseDetector', sub: 'EWMA / CUSUM on telemetry', detail: 'Detects persistent GPU underuse against the run’s own baseline from DCGM telemetry.', component: 'GPUUnderuseDetector' },
  { id: 'm-guard', kind: 'model', label: 'GuardrailRuleEngine', sub: 'State machine with hysteresis', detail: 'Memory, walltime, checkpoint and failure guardrails; records why it fired; consequential actions need confirmation.', component: 'GuardrailRuleEngine' },
  { id: 'm-rag', kind: 'model', label: 'PolicyRAGAdvisor', sub: 'RAG over policy docs, cited', detail: 'Retrieval over versioned Purdue docs, lab rules and context with source citations. Explains; never submits or overrides rules.', component: 'PolicyRAGAdvisor' },
  // Consumers
  { id: 'c-plan', kind: 'consumer', label: 'Launch planner', sub: 'checkRules · recommendPlans', detail: 'Checks a planned run against every rule and ranks configurations by time, cost and deadline.', route: '/plan' },
  { id: 'c-monitor', kind: 'consumer', label: 'Live monitor & guardrails', sub: 'evaluateHealth · applyAction', detail: 'Watches live runs, raises alerts and takes or proposes actions.', route: '/runs' },
  { id: 'c-advisor', kind: 'consumer', label: 'AI Advisor', sub: 'Agent tools over the same methods', detail: 'Answers lab questions and drafts plans using the app methods as tools.', route: '/assistant' },
  { id: 'c-dash', kind: 'consumer', label: 'Dashboards', sub: 'Insights.labSummary · universityOverview', detail: 'Lab overview, allocations & usage, and the Research Computing views.', route: '/admin' },
];

export const LINEAGE_EDGES: LineageEdge[] = [
  { from: 'src-sacct', to: 'p-sacct' },
  { from: 'src-dcgm', to: 'p-telemetry' },
  { from: 'src-ledger', to: 'p-ledger' },
  { from: 'src-status', to: 'p-status' },
  { from: 'src-context', to: 'p-context' },
  { from: 'src-sim', to: 'p-monitor' },
  { from: 'p-sacct', to: 'e-job' },
  { from: 'p-telemetry', to: 'e-metric' },
  { from: 'p-ledger', to: 'e-alloc' },
  { from: 'p-status', to: 'e-part' },
  { from: 'p-context', to: 'e-lab' },
  { from: 'p-monitor', to: 'e-metric' },
  { from: 'p-monitor', to: 'e-alert' },
  { from: 'p-monitor', to: 'e-job' },
  { from: 'e-job', to: 'm-runtime' },
  { from: 'e-job', to: 'm-wait' },
  { from: 'e-job', to: 'm-cpu' },
  { from: 'e-job', to: 'm-mem' },
  { from: 'e-lab', to: 'm-policy' },
  { from: 'e-part', to: 'm-policy' },
  { from: 'e-alloc', to: 'm-policy' },
  { from: 'e-metric', to: 'm-underuse' },
  { from: 'e-metric', to: 'm-guard' },
  { from: 'e-job', to: 'm-guard' },
  { from: 'e-lab', to: 'm-rag' },
  { from: 'm-runtime', to: 'c-plan' },
  { from: 'm-wait', to: 'c-plan' },
  { from: 'm-cpu', to: 'c-plan' },
  { from: 'm-mem', to: 'c-plan' },
  { from: 'm-policy', to: 'c-plan' },
  { from: 'm-underuse', to: 'c-monitor' },
  { from: 'm-guard', to: 'c-monitor' },
  { from: 'e-alert', to: 'c-monitor' },
  { from: 'm-rag', to: 'c-advisor' },
  { from: 'e-alloc', to: 'c-advisor' },
  { from: 'e-alert', to: 'c-advisor' },
  { from: 'e-job', to: 'c-dash' },
  { from: 'e-alloc', to: 'c-dash' },
  { from: 'e-part', to: 'c-dash' },
  { from: 'e-lab', to: 'c-dash' },
  { from: 'e-alert', to: 'c-dash' },
];

/** Entity types counted per entity node (secondary types summed into the same node). */
export const ENTITY_TYPES: Record<string, string[]> = {
  'e-job': ['Job'],
  'e-metric': ['JobMetric'],
  'e-alert': ['JobAlert', 'ActionLogEntry'],
  'e-alloc': ['Allocation'],
  'e-part': ['Partition', 'ComputeCluster'],
  'e-lab': ['Lab', 'Policy'],
};

/** All nodes upstream and downstream of a node (for path highlighting). */
export function connected(id: string): Set<string> {
  const out = new Set<string>([id]);
  const walk = (cur: string, dir: 'up' | 'down') => {
    LINEAGE_EDGES.forEach((e) => {
      const next = dir === 'down' ? (e.from === cur ? e.to : null) : e.to === cur ? e.from : null;
      if (next && !out.has(next)) {
        out.add(next);
        walk(next, dir);
      }
    });
  };
  walk(id, 'up');
  walk(id, 'down');
  return out;
}
