/*
 * Research Computing (admin) data access. Every call goes through `adminCall` = `c3Call`, unless the dev server runs
 * with `VITE_ADMIN_STUBS=1` (layout work without a backend; the stub module is lazy-loaded and never used otherwise).
 */

import { c3Call } from '@/c3Action';
import { filterLiteral } from '@/lib/format';

import type { ComputeCluster, FetchResult, JobLite, Lab, LabSummaryLite, Partition, Policy, UniversityOverview } from './types';

async function adminCall<T>(type: string, action: string, thisArg?: unknown, args?: unknown[]): Promise<T> {
  if (import.meta.env.VITE_ADMIN_STUBS === '1') {
    const { stubCall } = await import('./stubs');
    return stubCall(type, action, thisArg, args ?? []) as T;
  }
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
