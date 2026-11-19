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

export interface MemberRow {
  id: string;
  name: string;
  username: string;
  role: string;
  lab?: { id: string; name?: string };
  meta?: { created?: string; updated?: string };
}

export const listMembers = (labId?: string | null): Promise<MemberRow[]> =>
  fetchObjs<MemberRow>('LabMember', {
    include: 'id, name, username, role, lab.id, lab.name, meta.created, meta.updated',
    ...(labId ? { filter: `lab.id == ${filterLiteral(labId)}` } : {}),
    order: 'name',
    limit: 500,
  });

export const createMember = (m: { id: string; name: string; username: string; role: string; labId: string }) =>
  adminCall<MemberRow>('LabMember', 'create', { id: m.id, name: m.name, username: m.username, role: m.role, lab: { id: m.labId } });

export const updateMemberRole = (id: string, role: string) => adminCall<MemberRow>('LabMember', 'merge', { id, role });

export const removeMember = (id: string) => adminCall<boolean>('LabMember', 'remove', { id });

export interface ApprovalRow {
  id: string;
  actionType: string;
  actor: string;
  actedAt?: string;
  detail?: string;
  outcome: string;
  lab?: { id: string; name?: string };
  job?: { id: string; user?: string; jobName?: string; state?: string };
}

export const listPendingApprovals = (labId?: string | null): Promise<ApprovalRow[]> =>
  fetchObjs<ApprovalRow>('ActionLogEntry', {
    include: 'id, actionType, actor, actedAt, detail, outcome, lab.id, lab.name, job.id, job.user, job.jobName, job.state',
    filter: `outcome == 'PENDING_APPROVAL'${labId ? ` && lab.id == ${filterLiteral(labId)}` : ''}`,
    order: 'descending(actedAt)',
    limit: 200,
  });

/** Approve: run the action as ADMIN on a still-running job (best effort), then close the request as DONE. */
export async function approveRequest(a: ApprovalRow, approver: string): Promise<void> {
  if (a.job?.id && a.job.state === 'RUNNING' && a.actionType !== 'NOTIFY_PI') {
    try {
      await adminCall('Job', 'applyAction', { id: a.job.id }, [a.actionType, 'ADMIN']);
    } catch {
      // The job may have moved on; the request is still recorded as approved.
    }
  }
  await adminCall('ActionLogEntry', 'merge', { id: a.id, outcome: 'DONE', detail: `${a.detail ?? ''} · Approved by ${approver}`.trim() });
}

export const denyRequest = (a: ApprovalRow, approver: string) =>
  adminCall('ActionLogEntry', 'merge', { id: a.id, outcome: 'FAILED', detail: `${a.detail ?? ''} · Denied by ${approver}`.trim() });

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
    const fsc = await fetchObjs<{ id: string; name?: string }>('FileSourceCollection', { include: 'id, name', filter: `name == ${lit} || id == ${lit}`, limit: 1 });
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
