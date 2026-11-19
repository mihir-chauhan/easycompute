/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import { c3Call } from '@/c3Action';
import { filterLiteral } from '@/lib/format';
import type {
  ActionLog,
  ActionType,
  Alert,
  Allocation,
  AutopilotPolicy,
  ExtractedConstraint,
  FetchResult,
  LabConstraints,
  Job,
  JobMetric,
  Lab,
  LabMember,
  LabSummary,
  Policy,
  Project,
  RuleCheck,
  RunPlan,
  RunRequest,
  TickSummary,
} from './types';

/** Every lab-view backend call goes through `labCall` (= `c3Call`, typed). */
async function labCall<T>(type: string, action: string, thisArg?: unknown, args?: unknown[]): Promise<T> {
  return (await c3Call(type, action, thisArg, args)) as T;
}

/** Methods returning `json` may arrive Boxed (`{ type, value }`) depending on the declared return type. */
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
  offset?: number;
}

async function fetchObjs<T>(type: string, spec: Spec): Promise<T[]> {
  const res = await labCall<FetchResult<T>>(type, 'fetch', null, [{ offset: 0, ...spec }]);
  return res?.objs ?? [];
}

const eq = (field: string, value: string) => `${field} == ${filterLiteral(value)}`;

/* ---------- Lab context ---------- */

export const fetchLabs = () =>
  fetchObjs<Lab>('Lab', { include: 'id, name, piName, department, researchArea', order: 'ascending(name)', limit: 50 });

export const getLab = (labId: string) =>
  labCall<Lab | null>('Lab', 'get', { id: labId }, [
    'id, name, piName, piEmail, department, researchArea, contextDump, slurmAccounts, fairShareTarget, preferredClusters, notes, meta.updated',
  ]);

export const saveContextDump = (labId: string, contextDump: string) =>
  labCall<Lab>('Lab', 'merge', { id: labId, contextDump }, [{ include: 'id' }]);

export const fetchAllocations = (labId: string) =>
  fetchObjs<Allocation>('Allocation', {
    include: 'id, source, grantName, totalUnits, usedUnits, unitName, startDate, endDate, cluster.id, cluster.name',
    filter: eq('lab.id', labId),
    order: 'ascending(endDate)',
    limit: 50,
  });

export const fetchProjects = (labId: string) =>
  fetchObjs<Project>('Project', {
    include: 'id, name, description, deadline, deadlineLabel, priority, workloadType',
    filter: eq('lab.id', labId),
    order: 'ascending(deadline)',
    limit: 50,
  });

export const fetchMembers = (labId: string) =>
  fetchObjs<LabMember>('LabMember', {
    include: 'id, name, username, role',
    filter: eq('lab.id', labId),
    order: 'ascending(name)',
    limit: 100,
  });

export const fetchLabPolicies = (labId: string) =>
  fetchObjs<Policy>('Policy', {
    include: 'id, scope, kind, severity, title, description, limitValue, limitText, active',
    filter: `scope == 'LAB' && ${eq('lab.id', labId)}`,
    order: 'ascending(id)',
    limit: 100,
  });

export const createLabPolicy = (labId: string, c: ExtractedConstraint) =>
  labCall<Policy>('Policy', 'create', {
    id: `${labId}-${c.kind}-${Date.now().toString(36)}`,
    scope: 'LAB',
    kind: c.kind,
    severity: c.severity,
    title: c.title,
    description: c.sourceText ? `From lab context: "${c.sourceText}"` : undefined,
    lab: { id: labId },
    limitValue: c.limitValue ?? undefined,
    limitText: c.limitText ?? undefined,
    active: true,
  });

export const setPolicyActive = (id: string, active: boolean) => labCall<Policy>('Policy', 'merge', { id, active });

export const removePolicy = (id: string) => labCall<boolean>('Policy', 'remove', { id });

export const getAutopilot = (labId: string) =>
  labCall<AutopilotPolicy | null>('AutopilotPolicy', 'get', { id: labId }, ['this']);

export const saveAutopilot = (p: AutopilotPolicy) =>
  labCall<AutopilotPolicy>('AutopilotPolicy', 'merge', { ...p, lab: { id: p.lab?.id ?? p.id } });

/** Advisor: parse the lab's free-text context (text, or the stored contextDump when null) into structured constraints. */
export const extractConstraints = async (labId: string, text: string | null) =>
  unbox<LabConstraints>(await labCall('Advisor', 'extractConstraints', null, [labId, text]));

/* ---------- Insights ---------- */

export const getLabSummary = async (labId: string) => unbox<LabSummary>(await labCall('Insights', 'labSummary', null, [labId]));

/* ---------- Jobs / monitor ---------- */

const JOB_LIST_INCLUDE =
  'id, slurmJobId, user, jobName, state, workloadType, cluster.id, cluster.name, partition.id, partition.name, partition.slurmPartition, qos, allocGpus, allocNodes, allocCpus, gpuType.id, gpuType.name, timelimitHours, elapsedHours, gpuUtilAvg, costUsd, costUnits, submitTime, startTime, endTime, project.id, project.name, isLive';

export const fetchLiveJobs = (labId: string) =>
  fetchObjs<Job>('Job', {
    include: JOB_LIST_INCLUDE,
    filter: `${eq('lab.id', labId)} && isLive == true`,
    order: 'descending(submitTime)',
    limit: 100,
  });

/** Most recent jobs of the lab (live and finished), for the Runs list. */
export const fetchRecentJobs = (labId: string, limit = 60) =>
  fetchObjs<Job>('Job', {
    include: `${JOB_LIST_INCLUDE}, cpuEfficiency, gpuHours`,
    filter: eq('lab.id', labId),
    order: 'descending(submitTime)',
    limit,
  });

export const fetchHistoryJobs = (labId: string, limit = 2000) =>
  fetchObjs<Job>('Job', {
    include:
      'id, user, jobName, state, workloadType, cluster.id, cluster.name, partition.id, allocGpus, allocCpus, gpuType.id, timelimitHours, elapsedHours, gpuUtilAvg, cpuEfficiency, memEfficiency, reqMemGb, maxRssGb, costUsd, submitTime, startTime, endTime, project.id, project.name',
    filter: `${eq('lab.id', labId)} && isLive != true`,
    order: 'descending(endTime)',
    limit,
  });

export const getJob = (id: string) =>
  labCall<Job | null>('Job', 'get', { id }, [
    `this, ${JOB_LIST_INCLUDE}, lab.id, lab.name, runRequest.id, gpuType.memoryGb`,
  ]);

/** Recent metric samples for the lab's live jobs (newest first), for list sparklines. */
export const fetchLiveMetrics = (labId: string) =>
  fetchObjs<JobMetric>('JobMetric', {
    include: 'id, job.id, ts, gpuUtilPct',
    filter: `${eq('job.lab.id', labId)} && job.isLive == true`,
    order: 'descending(ts)',
    limit: 1500,
  });

export const fetchJobMetrics = async (jobId: string) =>
  (
    await fetchObjs<JobMetric>('JobMetric', {
      include:
        'id, ts, gpuUtilPct, gpuMemPct, cpuUtilPct, memPct, ioReadMBps, ioWriteMBps, powerW, checkpointAgeMin, trainingLoss',
      filter: eq('job.id', jobId),
      order: 'descending(ts)',
      limit: 500,
    })
  ).reverse();

export const fetchOpenAlerts = (labId: string) =>
  fetchObjs<Alert>('JobAlert', {
    include: 'id, job.id, job.jobName, job.user, alertType, severity, status, detectedAt, message, recommendedAction, autoActionTaken',
    filter: `${eq('lab.id', labId)} && (status == 'OPEN' || status == 'ACKED')`,
    order: 'descending(detectedAt)',
    limit: 200,
  });

export const fetchJobAlerts = (jobId: string) =>
  fetchObjs<Alert>('JobAlert', {
    include: 'id, alertType, severity, status, detectedAt, message, recommendedAction, autoActionTaken',
    filter: eq('job.id', jobId),
    order: 'descending(detectedAt)',
    limit: 100,
  });

export const fetchJobActions = (jobId: string) =>
  fetchObjs<ActionLog>('ActionLogEntry', {
    include: 'id, actionType, actor, actedAt, detail, outcome',
    filter: eq('job.id', jobId),
    order: 'descending(actedAt)',
    limit: 100,
  });

export const fetchLabActions = (labId: string, limit = 20) =>
  fetchObjs<ActionLog>('ActionLogEntry', {
    include: 'id, actionType, actor, actedAt, detail, outcome, job.id, job.jobName',
    filter: eq('lab.id', labId),
    order: 'descending(actedAt)',
    limit,
  });

export const applyJobAction = (jobId: string, actionType: ActionType, actor: 'USER' | 'ADMIN' | 'AUTOPILOT' = 'USER') =>
  labCall<ActionLog>('Job', 'applyAction', { id: jobId }, [actionType, actor]);

export const ackAlert = (id: string) => labCall<Alert>('JobAlert', 'merge', { id, status: 'ACKED' });

export const monitorTick = async () => unbox<TickSummary>(await labCall('RunMonitor', 'tick', null, []));

/* ---------- Plan a run ---------- */

export type NewRunRequest = Omit<RunRequest, 'id' | 'status' | 'createdAt'>;

export const createRunRequest = async (req: NewRunRequest): Promise<RunRequest> => {
  const id = `rr-${Date.now().toString(36)}`;
  const body = { ...req, id, status: 'DRAFT', createdAt: new Date().toISOString() };
  await labCall('RunRequest', 'create', body);
  return body as RunRequest;
};

export const updateRunRequest = (req: Partial<RunRequest> & { id: string }) =>
  labCall<RunRequest>('RunRequest', 'merge', { ...req, status: 'DRAFT' });

/** Runs the rule engine; rows carry title/scope/severity/ruleKind (sorted FAIL, WARN, PASS). */
export const checkRules = async (runRequestId: string): Promise<RuleCheck[]> =>
  (await labCall<RuleCheck[]>('RunRequest', 'checkRules', { id: runRequestId }, [])) ?? [];

export const getRunRequestStatus = async (id: string) =>
  (await labCall<RunRequest | null>('RunRequest', 'get', { id }, ['id, status']))?.status;

export const recommendPlans = async (runRequestId: string): Promise<RunPlan[]> => {
  await labCall('RunRequest', 'recommendPlans', { id: runRequestId }, []);
  return fetchObjs<RunPlan>('RunPlan', {
    include:
      'this, cluster.id, cluster.name, partition.id, partition.name, gpuType.id, gpuType.name',
    filter: eq('runRequest.id', runRequestId),
    order: 'ascending(rank)',
    limit: 3,
  });
};

export interface DurationPrediction {
  gpuHours?: number;
  explanation?: string;
  recommendedWalltimeHours?: number;
  estGpuHours?: number;
  estDurationHours?: number;
  basis?: string;
  [key: string]: unknown;
}

export const predictDuration = async (workloadType: string, gpuTypeId: string | null, gpus: number, modelParamsB: number) =>
  unbox<DurationPrediction>(await labCall('Insights', 'predictDuration', null, [workloadType, gpuTypeId, gpus, modelParamsB]));

export const submitPlan = (runRequestId: string, planId: string) =>
  labCall<Job>('RunRequest', 'submit', { id: runRequestId }, [planId]);

export const fetchGpuTypes = () =>
  fetchObjs<{ id: string; name: string; memoryGb?: number }>('GpuType', {
    include: 'id, name, memoryGb',
    order: 'descending(memoryGb)',
    limit: 50,
  });

export const fetchClusters = () =>
  fetchObjs<{ id: string; name: string; billing?: string }>('ComputeCluster', {
    include: 'id, name, billing, status',
    order: 'ascending(name)',
    limit: 50,
  });
