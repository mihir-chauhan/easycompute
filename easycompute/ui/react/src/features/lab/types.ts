/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/**
 * Lab-view entity and response shapes (SPEC.md "Entities" + API.md). Reference fields are
 * `{ id, name? }` stubs unless the fetch `include` names more of the referenced fields.
 */

export interface Ref {
  id: string;
  name?: string;
  /** Partition refs: the Slurm `-p` value (e.g. `ai`, `a100-80gb`). */
  slurmPartition?: string;
}

/** Job reference as included on alerts/actions (`job.jobName`). */
export interface JobRef extends Ref {
  jobName?: string;
  user?: string;
}

export type ClusterBilling = 'IN_HOUSE_NODE_SHARE' | 'ACCESS_SU' | 'THIRD_PARTY_HOURLY';
export type RuleScope = 'UNIVERSITY' | 'CLUSTER' | 'PARTITION' | 'LAB';
export type RuleSeverity = 'BLOCK' | 'WARN' | 'INFO';
export type WorkloadType = 'TRAINING' | 'FINETUNE' | 'INFERENCE' | 'SIMULATION' | 'DATA_PROCESSING' | 'INTERACTIVE';
export type RunRequestStatus = 'DRAFT' | 'CHECKED' | 'PLANNED' | 'SUBMITTED' | 'REJECTED';
export type JobState =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'OUT_OF_MEMORY'
  | 'PREEMPTED';
export type CheckOutcome = 'PASS' | 'WARN' | 'FAIL';
export type AlertType =
  | 'IDLE_GPU'
  | 'LOW_GPU_UTIL'
  | 'OOM_RISK'
  | 'WALLTIME_RISK'
  | 'BUDGET_BURN'
  | 'HUNG_JOB'
  | 'NODE_FAILURE'
  | 'PREEMPTION_RISK'
  | 'STALE_CHECKPOINT';
export type AlertSeverity = 'CRITICAL' | 'WARNING' | 'INFO';
export type AlertStatus = 'OPEN' | 'ACKED' | 'RESOLVED' | 'AUTO_RESOLVED';
export type ActionType =
  | 'SUBMIT'
  | 'CANCEL'
  | 'EXTEND_WALLTIME'
  | 'REQUEUE_STANDBY'
  | 'CHECKPOINT_NOW'
  | 'SCALE_DOWN'
  | 'NOTIFY_PI'
  | 'HOLD';
export type Actor = 'USER' | 'AUTOPILOT' | 'ADMIN';

export interface Lab {
  id: string;
  name: string;
  piName?: string;
  piEmail?: string;
  department?: string;
  researchArea?: string;
  contextDump?: string;
  slurmAccounts?: string;
  fairShareTarget?: number;
  preferredClusters?: string;
  notes?: string;
}

export interface LabMember {
  id: string;
  name: string;
  username?: string;
  role?: 'PI' | 'POSTDOC' | 'STUDENT' | 'STAFF';
  lab?: Ref;
}

export interface Cluster {
  id: string;
  name: string;
  operator?: string;
  billing?: ClusterBilling;
  unitName?: string;
  usdPerUnit?: number;
  status?: string;
}

export interface Allocation {
  id: string;
  lab?: Ref;
  cluster?: Ref;
  source?: string;
  grantName?: string;
  totalUnits?: number;
  usedUnits?: number;
  unitName?: string;
  startDate?: string;
  endDate?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  deadline?: string;
  deadlineLabel?: string;
  priority?: number;
  workloadType?: WorkloadType;
  lab?: Ref;
}

export interface Policy {
  id: string;
  scope: RuleScope;
  kind?: string;
  severity: RuleSeverity;
  title: string;
  description?: string;
  cluster?: Ref;
  partition?: Ref;
  lab?: Ref;
  limitValue?: number;
  limitText?: string;
  sourceUrl?: string;
  active?: boolean;
}

export interface AutopilotPolicy {
  id: string;
  lab?: Ref;
  enabled?: boolean;
  cancelIdleAfterMin?: number;
  checkpointBeforeTimeoutMin?: number;
  autoExtendWalltime?: boolean;
  requeueToStandbyOnLowPriority?: boolean;
  notifyPiOnCritical?: boolean;
  budgetAlertPct?: number;
}

export interface Partition {
  id: string;
  name?: string;
  cluster?: Ref;
  gpuType?: Ref;
  maxWalltimeHours?: number;
  preemptible?: boolean;
}

export interface GpuTypeRef extends Ref {
  memoryGb?: number;
}

export interface RunRequest {
  id: string;
  lab?: Ref;
  project?: Ref;
  submittedBy?: Ref;
  name: string;
  description?: string;
  workloadType?: WorkloadType;
  modelParamsB?: number;
  datasetGb?: number;
  estGpuHours?: number;
  requestedGpus?: number;
  requestedGpuType?: Ref;
  requestedWalltimeHours?: number;
  requestedCluster?: Ref;
  deadline?: string;
  status?: RunRequestStatus;
  createdAt?: string;
  /** PI approval gate (policy e.g. > 500 GPU-hours): NOT_REQUIRED | PENDING | APPROVED | REJECTED. */
  approvalStatus?: string;
  approvalReason?: string;
}

export interface RuleCheck {
  id: string;
  runRequest?: Ref;
  policy?: Policy;
  outcome: CheckOutcome;
  message?: string;
  checkedAt?: string;
  title?: string;
  ruleKind?: string;
  severity?: RuleSeverity;
  scope?: RuleScope;
}

export interface RunPlan {
  id: string;
  runRequest?: Ref;
  rank?: number;
  cluster?: Ref;
  partition?: Ref;
  gpuType?: Ref;
  gpus?: number;
  nodes?: number;
  walltimeHours?: number;
  estDurationHours?: number;
  estCostUnits?: number;
  estCostUsd?: number;
  meetsDeadline?: boolean;
  score?: number;
  label?: 'Fastest' | 'Cheapest' | 'Balanced' | string;
  rationale?: string;
  sbatchScript?: string;
  qos?: string;
  account?: string;
  slurmPartition?: string;
  chainedJobs?: number;
  preemptionRisk?: number;
  gpuMemNeedGb?: number;
  costPerGpuHourUsd?: number;
  finishBy?: string;
  deadlineSlackHours?: number | null;
  ruleWarnings?: number;
  /** AnvilRuntimeQ50Q90 P90 (estDurationHours is the P50). */
  estDurationP90Hours?: number;
  /** AnvilHostMemoryQ50Q90 sized --mem. */
  memRequestGb?: number;
  cpuEvidence?: unknown;
  /** GPUShapeAdvisor explanation. */
  shapeReason?: string;
  provenance?: unknown;
}

export interface Job {
  id: string;
  slurmJobId?: string;
  lab?: Ref;
  project?: Ref;
  runRequest?: Ref;
  user?: string;
  cluster?: Ref;
  partition?: Ref;
  account?: string;
  qos?: string;
  jobName?: string;
  workloadType?: WorkloadType;
  state?: JobState;
  submitTime?: string;
  startTime?: string;
  endTime?: string;
  timelimitHours?: number;
  elapsedHours?: number;
  allocCpus?: number;
  allocNodes?: number;
  allocGpus?: number;
  gpuType?: Ref;
  reqMemGb?: number;
  maxRssGb?: number;
  cpuEfficiency?: number;
  memEfficiency?: number;
  gpuUtilAvg?: number;
  costUnits?: number;
  costUsd?: number;
  exitCode?: string;
  nodeList?: string;
  isLive?: boolean;
  gpuHours?: number;
  wastedGpuHours?: number;
}

export interface JobMetric {
  id: string;
  job?: Ref;
  ts: string;
  gpuUtilPct?: number;
  gpuMemPct?: number;
  cpuUtilPct?: number;
  memPct?: number;
  ioReadMBps?: number;
  ioWriteMBps?: number;
  powerW?: number;
  checkpointAgeMin?: number;
  trainingLoss?: number;
}

export interface Alert {
  id: string;
  job?: JobRef;
  lab?: Ref;
  alertType: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  detectedAt?: string;
  message?: string;
  recommendedAction?: ActionType;
  autoActionTaken?: boolean;
  /** GuardrailRuleEngine: the rule / transition that fired. */
  firedRule?: string;
  /** Metric values, enter/exit thresholds, window. */
  evidence?: unknown;
  provenance?: unknown;
}

export interface ActionLog {
  id: string;
  lab?: Ref;
  job?: JobRef;
  runRequest?: Ref;
  actionType: ActionType;
  actor: Actor;
  actedAt: string;
  detail?: string;
  outcome?: 'DONE' | 'FAILED' | 'PENDING_APPROVAL' | string;
}

export interface FetchResult<T> {
  objs?: T[];
  count?: number;
  hasMore?: boolean;
}

export interface SummaryAllocation {
  id: string;
  name?: string;
  clusterId?: string;
  clusterName?: string;
  source?: string;
  grantName?: string;
  unitName?: string;
  totalUnits?: number;
  usedUnits?: number;
  remainingUnits?: number;
  pctUsed?: number;
  remainingUsd?: number;
  startDate?: string;
  endDate?: string;
  daysLeft?: number;
  burnPerDay?: number;
  projectedRunOut?: string | null;
  runsOutBeforeEnd?: boolean;
  /** AllocationBurnForecaster scenarios. */
  scenarios?: Partial<Record<'baseline' | 'low' | 'high', { perDay?: number; runOut?: string | null }>>;
}

export interface SummaryDeadline {
  projectId: string;
  name: string;
  deadline: string;
  deadlineLabel?: string;
  daysLeft?: number;
  priority?: number;
  workloadType?: WorkloadType;
}

export interface UserUsage {
  user: string;
  jobs: number;
  gpuHours: number;
  costUsd: number;
  avgGpuUtil?: number | null;
  wastedGpuHours?: number;
  avgCpuEfficiency?: number | null;
  timeEfficiency?: number | null;
}

export interface Recommendation {
  kind: string;
  title: string;
  detail?: string;
  impact?: string;
}

/** `Insights.labSummary(labId)` (API.md section 4). */
export interface LabSummary {
  asOf?: string;
  lab?: Lab;
  kpis: {
    liveJobs?: number;
    runningJobs?: number;
    runningGpus?: number;
    openAlerts?: number;
    criticalAlerts?: number;
    jobs?: number;
    gpuHours?: number;
    costUsd?: number;
    wastedGpuHours?: number;
    wastePct?: number;
    avgGpuUtil?: number;
    failedJobs?: number;
    failRate?: number;
    gpuHours30d?: number;
    costUsd30d?: number;
    allocationRemainingUsd?: number;
  };
  allocations: SummaryAllocation[];
  deadlines: SummaryDeadline[];
  usageByCluster?: { clusterId: string; name: string; jobs: number; gpuHours: number; costUsd: number }[];
  usageByUser?: UserUsage[];
  usageByWorkload?: { workloadType: string; jobs: number; gpuHours: number; avgGpuUtil?: number }[];
  stateMix?: { state: string; count: number }[];
  efficiency?: { avgCpuEfficiency?: number; avgMemEfficiency?: number; avgGpuUtil?: number; timeEfficiency?: number };
  weekly?: { week: string; jobs: number; gpuHours: number; costUsd: number }[];
  recommendations?: Recommendation[];
  provenance?: unknown;
}

/** `RunMonitor.tick()` summary. */
export interface TickSummary {
  simulatedTo?: string;
  stepMinutes?: number;
  advanced?: number;
  started?: string[];
  finished?: { jobId: string; state: string }[];
  newAlerts?: { id: string; jobId: string; alertType: string; severity: string; message?: string }[];
  resolvedAlerts?: string[];
  actions?: { id: string; jobId: string; actionType: string; outcome?: string; detail?: string }[];
  openAlerts?: number;
  liveJobs?: number;
}

/** Evidence span returned by LabContextExtractor: exact quote of the lab text and its offsets (older replies: a string). */
export type EvidenceSpan = string | { quote: string; start?: number; end?: number };

/** `Advisor.extractConstraints(labId, text)` (advisor agent; see pages/Assistant/types.ts `LabConstraints`). */
export interface LabConstraints {
  component?: string;
  version?: string;
  status?: 'UNCONFIRMED' | 'CONFIRMED' | string;
  validation?: { valid?: boolean; errors?: string[]; dropped?: unknown[] };
  provenance?: unknown;
  source: string;
  cached?: boolean;
  llmError?: string;
  summary?: string;
  warnings?: string[];
  budgets: { kind: string; amount: number; period?: string; scope?: string | null; evidence?: EvidenceSpan }[];
  deadlines: { label: string; date: string; daysAway?: number | null; evidence?: EvidenceSpan }[];
  preferences: {
    clusters?: string[];
    gpuTypes?: string[];
    avoid?: string[];
    preemptibleOk?: boolean | null;
    maxWalltimeHours?: number | null;
    quietHours?: string | null;
    notes?: string[];
    evidence?: { quote: string; start?: number; end?: number; field: string; value?: unknown }[];
  };
  dataRestrictions: { kind: string; description?: string; evidence?: EvidenceSpan }[];
  memberCaps?: { who: string; pct: number; evidence?: EvidenceSpan }[];
  approvals?: { threshold: number; unit: string; evidence?: EvidenceSpan }[];
}

/** A constraint the advisor parsed out of the lab's context dump; editable before saving as a LAB Policy. */
export interface ExtractedConstraint {
  key: string;
  kind: string;
  severity: RuleSeverity;
  title: string;
  limitValue?: number | null;
  limitText?: string | null;
  sourceText?: string;
}

/** One live job in `RunMonitor.liveSnapshot`. */
export interface SnapJob {
  id: string;
  jobName?: string;
  user?: string;
  labId?: string;
  clusterId?: string;
  partitionId?: string;
  qos?: string;
  state?: JobState;
  workloadType?: WorkloadType;
  gpus?: number;
  gpuTypeId?: string;
  nodeList?: string;
  submitTime?: string;
  startTime?: string;
  endTime?: string;
  elapsedHours?: number;
  timelimitHours?: number;
  remainingHours?: number;
  costUnits?: number;
  costUsd?: number;
  /** elapsedHours gained per real second. */
  progressPerRealSec?: number;
  latest?: Omit<JobMetric, 'id'> | null;
  alerts?: { id: string; alertType: AlertType; severity: AlertSeverity; status: AlertStatus }[];
}

/** `RunMonitor.liveSnapshot(labId)`: cheap live state, polled every 5-10 s. */
export interface LiveSnapshot {
  serverTime?: string;
  simulator?: { enabled?: boolean; demoTimeScale?: number; lastTickAt?: string; nextTickInSec?: number };
  counts?: { running?: number; openAlerts?: number; criticalAlerts?: number; awaitingConfirmation?: number };
  jobs?: SnapJob[];
  partitions?: { id: string; clusterId?: string; utilizationPct?: number; currentQueueDepth?: number; avgWaitHours?: number }[];
  clusters?: { id: string; status?: string; healthPct?: number; liveUtilizationPct?: number }[];
  allocations?: { id: string; clusterId?: string; usedUnits?: number; totalUnits?: number; unitName?: string }[];
  provenance?: unknown;
}
