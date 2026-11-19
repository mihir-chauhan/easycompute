/*
 * Research Computing (admin) data access. Every call goes through `c3Call` (live backend verified 18:49 UTC).
 */

import { c3Call } from '@/c3Action';
import { filterLiteral } from '@/lib/format';

import type { ComputeCluster, FetchResult, JobLite, Lab, LabSummaryLite, Partition, Policy, UniversityOverview } from './types';

async function adminCall<T>(type: string, action: string, thisArg?: unknown, args?: unknown[]): Promise<T> {
  return (await c3Call(type, action, thisArg, args)) as T;
}

/** `json` methods may come back Boxed (`{ type, value }`) depending on the declared return type. */
function unbox<T>(v: unknown): T {
  if (v && typeof v === 'object' && 'value' in v && 'type' in v && Object.keys(v).length <= 3) {
    return (v as { value: T }).value;
  }
  return v as T;
}

interface Spec {
  include: string;
  filter?: string;
  order?: string;
  limit: number;
}

async function fetchObjs<T>(type: string, spec: Spec): Promise<T[]> {
  const res = await adminCall<FetchResult<T>>(type, 'fetch', null, [{ offset: 0, ...spec }]);
  return res?.objs ?? [];
}

const CLUSTER_INCLUDE = 'id, name, operator, billing, description, totalNodes, totalGpus, totalCores, storageTb, unitName, usdPerUnit, status';
const PARTITION_INCLUDE =
  'id, name, cluster.id, cluster.name, gpuType.id, gpuType.name, gpusPerNode, coresPerNode, memPerNodeGb, maxWalltimeHours, maxNodesPerJob, maxGpusPerJob, maxJobsPerUser, preemptible, chargeFactor, currentQueueDepth, avgWaitHours, utilizationPct, nodeCount, qos, slurmPartition';

export const getUniversityOverview = async (): Promise<UniversityOverview> =>
  unbox<UniversityOverview>(await adminCall('Insights', 'universityOverview', null, []));

export const listClusters = (): Promise<ComputeCluster[]> =>
  fetchObjs<ComputeCluster>('ComputeCluster', { include: CLUSTER_INCLUDE, order: 'name', limit: 50 });

export async function getClusterDetail(id: string): Promise<{ cluster: ComputeCluster | null; partitions: Partition[]; liveJobs: JobLite[] }> {
  const lit = filterLiteral(id);
  const [clusters, partitions, liveJobs] = await Promise.all([
    fetchObjs<ComputeCluster>('ComputeCluster', { include: CLUSTER_INCLUDE, filter: `id == ${lit}`, limit: 1 }),
    fetchObjs<Partition>('Partition', { include: PARTITION_INCLUDE, filter: `cluster.id == ${lit}`, order: 'name', limit: 100 }),
    fetchObjs<JobLite>('Job', {
      include: 'id, user, lab.id, lab.name, partition.id, partition.name, state, allocGpus, gpuUtilAvg, elapsedHours, timelimitHours, jobName',
      filter: `cluster.id == ${lit} && isLive == true`,
      order: 'descending(allocGpus)',
      limit: 100,
    }),
  ]);
  return { cluster: clusters[0] ?? null, partitions, liveJobs };
}

export const listPolicies = (): Promise<Policy[]> =>
  fetchObjs<Policy>('Policy', {
    include: 'id, scope, kind, severity, title, description, cluster.id, cluster.name, partition.id, partition.name, lab.id, lab.name, limitValue, limitText, sourceUrl, active',
    order: 'id',
    limit: 500,
  });

export const listLabs = (): Promise<Lab[]> =>
  fetchObjs<Lab>('Lab', {
    include: 'id, name, piName, piEmail, department, researchArea, fairShareTarget, preferredClusters, slurmAccounts',
    order: 'name',
    limit: 100,
  });

export const getLabSummary = async (labId: string): Promise<LabSummaryLite> =>
  unbox<LabSummaryLite>(await adminCall('Insights', 'labSummary', null, [labId]));

/** Labs with their summaries (one labSummary call per lab, in parallel; ~8 labs). */
export async function listLabSummaries(): Promise<LabSummaryLite[]> {
  const labs = await listLabs();
  return Promise.all(labs.map(async (lab) => ({ ...(await getLabSummary(lab.id)), lab })));
}

export const listPartitions = (): Promise<Partition[]> =>
  fetchObjs<Partition>('Partition', { include: PARTITION_INCLUDE, order: 'name', limit: 200 });

/** FAIL rule checks (for "Blocks (30d)" per policy). */
export const listFailedChecks = (): Promise<Array<{ id: string; policy?: { id: string } | null; checkedAt?: string }>> =>
  fetchObjs('RuleCheck', { include: 'id, policy.id, checkedAt', filter: "outcome == 'FAIL'", order: 'descending(checkedAt)', limit: 2000 });

/* ------------------------------------------------------------ users & approvals ------------------------------------------------------------ */
/*
 * Contract: API.md section 5 (UserAdmin + AppUser). Until UserAdmin is deployed in the workspace ("Missing TypeMeta"),
 * the same shapes are derived from LabMember / ActionLogEntry so the page works either way.
 */

export type AppRole = 'UNIVERSITY_ADMIN' | 'PI' | 'STUDENT' | 'STAFF';

export interface AppUserRow {
  id: string;
  name: string;
  email?: string | null;
  username?: string | null;
  role: AppRole;
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
  labId?: string | null;
  labName?: string | null;
  lastActive?: string | null;
  invitedBy?: string | null;
  invitedAt?: string | null;
  jobs30d?: number | null;
  gpuHours30d?: number | null;
}

export interface ApprovalItem {
  id: string;
  kind: 'WALLTIME_EXTENSION' | 'RUN_APPROVAL' | string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  labId?: string | null;
  labName?: string | null;
  jobId?: string | null;
  runRequestId?: string | null;
  requestedBy?: string | null;
  requestedAt?: string | null;
  title: string;
  detail?: string | null;
  amount?: number | null;
  unit?: string | null;
}

const missingType = (e: unknown) => e instanceof Error && /Missing TypeMeta|Missing type/i.test(e.message);
let userAdminDeployed: boolean | null = null;

/** Calls UserAdmin.<method>; returns undefined when the type is not deployed yet (fallback path). */
async function userAdmin<T>(method: string, args: unknown[]): Promise<T | undefined> {
  if (userAdminDeployed === false) return undefined;
  try {
    const r = unbox<T>(await adminCall('UserAdmin', method, null, args));
    userAdminDeployed = true;
    return r;
  } catch (e) {
    if (missingType(e)) {
      userAdminDeployed = false;
      return undefined;
    }
    throw e;
  }
}

/** True once a UserAdmin call succeeded; false when the type is missing; null before the first call. */
export const isUserAdminDeployed = () => userAdminDeployed;

const RCAC_ADMINS: AppUserRow[] = [
  { id: 'admin-rcac-ops', name: 'RCAC research computing staff', username: 'rcac-ops', role: 'UNIVERSITY_ADMIN', status: 'ACTIVE', labId: null, labName: null },
  { id: 'admin-rcac-alloc', name: 'RCAC allocations desk', username: 'rcac-alloc', role: 'UNIVERSITY_ADMIN', status: 'ACTIVE', labId: null, labName: null },
];

export async function listUsers(labId?: string | null): Promise<AppUserRow[]> {
  const r = await userAdmin<{ users: AppUserRow[] }>('listUsers', [labId ?? null]);
  if (r) return r.users ?? [];
  const members = await fetchObjs<{ id: string; name: string; username: string; role: string; lab?: { id: string; name?: string }; meta?: { created?: string } }>('LabMember', {
    include: 'id, name, username, role, lab.id, lab.name, meta.created',
    ...(labId ? { filter: `lab.id == ${filterLiteral(labId)}` } : {}),
    order: 'name',
    limit: 500,
  });
  const rows: AppUserRow[] = members.map((m) => ({
    id: m.id,
    name: m.name,
    username: m.username,
    role: m.role === 'PI' ? 'PI' : m.role === 'STUDENT' ? 'STUDENT' : 'STAFF',
    status: 'ACTIVE',
    labId: m.lab?.id ?? null,
    labName: m.lab?.name ?? null,
    invitedAt: m.meta?.created ?? null,
  }));
  return labId ? rows : [...RCAC_ADMINS, ...rows];
}

export async function inviteUser(email: string, name: string, role: AppRole, labId: string | null): Promise<void> {
  const r = await userAdmin('inviteUser', [email, name, role, labId]);
  if (r !== undefined) return;
  if (!labId) throw new Error('University Admins can be invited once UserAdmin is deployed.');
  const username = email.split('@')[0].toLowerCase();
  await adminCall('LabMember', 'create', { id: `m-${labId.replace(/^lab-/, '')}-${username}`, name, username, role: role === 'STAFF' ? 'STAFF' : role, lab: { id: labId } });
}

export async function setUserRole(userId: string, role: AppRole): Promise<void> {
  const r = await userAdmin('setRole', [userId, role]);
  if (r === undefined) await adminCall('LabMember', 'merge', { id: userId, role });
}

export async function removeUser(userId: string): Promise<void> {
  const r = await userAdmin('removeUser', [userId]);
  if (r === undefined) await adminCall('LabMember', 'remove', { id: userId });
}

export async function pendingApprovals(labId?: string | null): Promise<ApprovalItem[]> {
  const r = await userAdmin<{ items: ApprovalItem[] }>('pendingApprovals', [labId ?? null]);
  if (r) return (r.items ?? []).filter((i) => i.status === 'PENDING');
  const rows = await fetchObjs<{ id: string; actionType: string; actor: string; actedAt?: string; detail?: string; lab?: { id: string; name?: string }; job?: { id: string; user?: string; jobName?: string } }>(
    'ActionLogEntry',
    {
      include: 'id, actionType, actor, actedAt, detail, lab.id, lab.name, job.id, job.user, job.jobName',
      filter: `outcome == 'PENDING_APPROVAL'${labId ? ` && lab.id == ${filterLiteral(labId)}` : ''}`,
      order: 'descending(actedAt)',
      limit: 200,
    },
  );
  return rows.map((a) => ({
    id: `ALE:${a.id}`,
    kind: a.actionType === 'EXTEND_WALLTIME' ? 'WALLTIME_EXTENSION' : a.actionType,
    status: 'PENDING',
    labId: a.lab?.id,
    labName: a.lab?.name,
    jobId: a.job?.id,
    requestedBy: a.job?.user ?? a.actor,
    requestedAt: a.actedAt,
    title: `${a.actionType.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())} for ${a.job?.jobName ?? a.job?.id ?? 'a run'}`,
    detail: a.detail,
  }));
}

export async function decideApproval(item: ApprovalItem, approve: boolean, note: string): Promise<void> {
  const r = await userAdmin(approve ? 'approve' : 'reject', [item.id, note]);
  if (r !== undefined) return;
  const aleId = item.id.replace(/^ALE:/, '');
  await adminCall('ActionLogEntry', 'merge', { id: aleId, outcome: approve ? 'DONE' : 'FAILED', detail: `${item.detail ?? ''} · ${approve ? 'Approved' : 'Denied'}: ${note}`.trim() });
}

/** Tell the server which app user the demo role switch acts as (null = clear). Best effort. */
export async function setDemoUser(appUserId: string | null): Promise<void> {
  try {
    await userAdmin('setDemoUser', [appUserId]);
  } catch {
    // Older backend or no permission: the UI role switch still works client-side.
  }
}

/* ---------------------------------------------------------------- data fusion ---------------------------------------------------------------- */

export interface EntityStat {
  type: string;
  count: number | null;
  lastUpdated: string | null;
  error?: string;
}

/** Row count + latest load time of an entity type (null when the type is not reachable). */
export async function entityStat(type: string): Promise<EntityStat> {
  try {
    const [count, latest] = await Promise.all([
      adminCall<number>(type, 'fetchCount', null, [{}]),
      fetchObjs<{ id: string; meta?: { updated?: string } }>(type, { include: 'id, meta.updated', order: 'descending(meta.updated)', limit: 1 }),
    ]);
    return { type, count: typeof count === 'number' ? count : null, lastUpdated: latest[0]?.meta?.updated ?? null };
  } catch (e) {
    return { type, count: null, lastUpdated: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface FeedStat {
  feed: string;
  deployed: boolean;
  files: number;
  failedFiles: number;
  lastLoad: string | null;
  rejected: number | null;
  error?: string;
}

/** Native ingestion stats for a FileSourceCollection (C3 Data Fusion): files, failures, last load, rejections. */
export async function feedStat(feed: string): Promise<FeedStat> {
  const lit = filterLiteral(feed);
  try {
    const fsc = await fetchObjs<{ name?: string }>('FileSourceCollection', { include: 'name', filter: `name == ${lit}`, limit: 1 });
    if (!fsc.length) return { feed, deployed: false, files: 0, failedFiles: 0, lastLoad: null, rejected: null };
    const [files, rejected] = await Promise.all([
      fetchObjs<{ id: string; status?: { state?: string }; meta?: { updated?: string } }>('SourceFile', {
        include: 'id, status.state, meta.updated',
        filter: `sourceCollectionName == ${lit}`,
        order: 'descending(meta.updated)',
        limit: 200,
      }).catch(() => []),
      adminCall<number>('IngestRejection', 'fetchCount', null, [{ filter: `feed == ${lit}` }]).catch(() => null),
    ]);
    return {
      feed,
      deployed: true,
      files: files.length,
      failedFiles: files.filter((f) => /fail|reject|error/i.test(f.status?.state ?? '')).length,
      lastLoad: files[0]?.meta?.updated ?? null,
      rejected: typeof rejected === 'number' ? rejected : null,
    };
  } catch (e) {
    return { feed, deployed: false, files: 0, failedFiles: 0, lastLoad: null, rejected: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Completed Anvil jobs in the history = candidate training rows for the Anvil quantile models. */
export const anvilTrainingRows = async (): Promise<number | null> => {
  try {
    const n = await adminCall<number>('Job', 'fetchCount', null, [{ filter: "cluster.id == 'anvil' && state == 'COMPLETED' && isLive == false" }]);
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
};

/* ---------------------------------------------------------------- live snapshot ---------------------------------------------------------------- */
/*
 * RunMonitor.liveSnapshot (SPEC "LIVE CLUSTER SIMULATION"; contract in API.md once published). Parsed leniently: any of
 * the fields below may be present. Returns null while the method is not deployed, and pages fall back to re-polling
 * Insights.universityOverview / labSummary (which already reflect the simulator's writes).
 */

/** RunMonitor.liveSnapshot (API.md section 8). */
export interface LiveJob {
  id: string;
  jobName?: string;
  user?: string;
  labId?: string;
  clusterId?: string;
  partitionId?: string;
  qos?: string;
  state: string;
  workloadType?: string;
  gpus?: number;
  gpuTypeId?: string;
  nodeList?: string | null;
  submitTime?: string;
  startTime?: string | null;
  endTime?: string | null;
  elapsedHours?: number;
  timelimitHours?: number;
  remainingHours?: number;
  costUnits?: number;
  costUsd?: number;
  /** elapsedHours gained per real second (demoTimeScale). */
  progressPerRealSec?: number;
  latest?: { ts?: string; gpuUtilPct?: number; gpuMemPct?: number; cpuUtilPct?: number; memPct?: number; ioReadMBps?: number; ioWriteMBps?: number; powerW?: number; checkpointAgeMin?: number; trainingLoss?: number } | null;
  alerts?: Array<{ id: string; alertType: string; severity: string; status: string }>;
}

export interface LiveSnapshot {
  serverTime?: string;
  simulator?: { enabled?: boolean; demoTimeScale?: number; lastTickAt?: string | null; nextTickInSec?: number };
  counts?: { running?: number; openAlerts?: number; criticalAlerts?: number; awaitingConfirmation?: number };
  jobs?: LiveJob[];
  partitions?: Array<{ id: string; clusterId?: string; utilizationPct?: number; currentQueueDepth?: number; avgWaitHours?: number }>;
  clusters?: Array<{ id: string; status?: string; healthPct?: number; liveUtilizationPct?: number }>;
  allocations?: Array<{ id: string; clusterId?: string; usedUnits?: number; totalUnits?: number; unitName?: string }>;
  provenance?: unknown;
}

let liveSnapshotDeployed: boolean | null = null;
let liveSnapshotMissingAt = 0;

export async function getLiveSnapshot(labId?: string | null): Promise<LiveSnapshot | null> {
  // Not deployed: re-probe every 2 min so a backend pull is picked up without a reload.
  if (liveSnapshotDeployed === false && Date.now() - liveSnapshotMissingAt < 120000) return null;
  try {
    const r = unbox<LiveSnapshot>(await adminCall('RunMonitor', 'liveSnapshot', null, labId ? [labId] : []));
    liveSnapshotDeployed = true;
    return r ?? null;
  } catch (e) {
    if (e instanceof Error && /Missing|not found|no implementation|Unknown method|is not a function/i.test(e.message)) {
      liveSnapshotDeployed = false;
      liveSnapshotMissingAt = Date.now();
      return null;
    }
    throw e;
  }
}

/** Overlay live cluster utilization / status from the snapshot onto overview cluster rows (busy/idle GPUs recomputed). */
export function mergeLiveClusters<T extends { id: string; gpuUtilizationPct?: number; busyGpus?: number; idleGpus?: number; totalGpus?: number; status?: string; liveJobs?: number; queueDepth?: number; avgWaitHours?: number }>(
  rows: T[],
  snap: LiveSnapshot | null,
): T[] {
  if (!snap?.clusters?.length) return rows;
  const by = new Map(snap.clusters.map((c) => [c.id, c]));
  const liveByCluster = new Map<string, number>();
  (snap.jobs ?? []).forEach((j) => j.clusterId && j.state === 'RUNNING' && liveByCluster.set(j.clusterId, (liveByCluster.get(j.clusterId) ?? 0) + 1));
  return rows.map((r) => {
    const l = by.get(r.id);
    if (!l) return r;
    const parts = (snap.partitions ?? []).filter((p) => p.clusterId === r.id);
    const queue = parts.length ? parts.reduce((a, p) => a + (p.currentQueueDepth ?? 0), 0) : r.queueDepth;
    const wait = parts.length ? parts.reduce((a, p) => a + (p.avgWaitHours ?? 0), 0) / parts.length : r.avgWaitHours;
    const util = l.liveUtilizationPct ?? r.gpuUtilizationPct;
    const total = r.totalGpus ?? 0;
    const busy = util != null && total ? Math.round((total * util) / 100) : r.busyGpus;
    return {
      ...r,
      gpuUtilizationPct: util,
      busyGpus: busy,
      idleGpus: busy != null && total ? total - busy : r.idleGpus,
      status: l.status ?? r.status,
      liveJobs: liveByCluster.get(r.id) ?? r.liveJobs,
      ...(r.queueDepth !== undefined ? { queueDepth: queue } : {}),
      ...(r.avgWaitHours !== undefined ? { avgWaitHours: wait } : {}),
    };
  });
}

/** Overlay live partition numbers (utilization, queue depth, wait) onto partition rows. */
export function mergeLivePartitions(rows: Partition[], snap: LiveSnapshot | null): Partition[] {
  if (!snap?.partitions?.length) return rows;
  const by = new Map(snap.partitions.map((p) => [p.id, p]));
  return rows.map((r) => {
    const l = by.get(r.id);
    if (!l) return r;
    return {
      ...r,
      utilizationPct: l.utilizationPct ?? r.utilizationPct,
      currentQueueDepth: l.currentQueueDepth ?? r.currentQueueDepth,
      avgWaitHours: l.avgWaitHours ?? r.avgWaitHours,
    };
  });
}
