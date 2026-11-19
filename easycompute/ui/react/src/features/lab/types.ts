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
}

export interface RuleCheck {
  id: string;
  runRequest?: Ref;
  policy?: Policy;
  outcome: CheckOutcome;
  message?: string;
  checkedAt?: string;
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
  estWaitHours?: number;
  estDurationHours?: number;
  estCostUnits?: number;
  estCostUsd?: number;
  meetsDeadline?: boolean;
  score?: number;
  label?: 'Fastest' | 'Cheapest' | 'Balanced' | string;
  rationale?: string;
  sbatchScript?: string;
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
  job?: Ref;
  lab?: Ref;
  alertType: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  detectedAt?: string;
  message?: string;
  recommendedAction?: ActionType;
  autoActionTaken?: boolean;
}

export interface ActionLog {
  id: string;
  lab?: Ref;
  job?: Ref;
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

/** One day of the allocation burn-down (cumulative spend vs the straight-line plan). */
export interface BurnPoint {
  date: string;
  usedUsd: number;
  planUsd?: number;
}

/** `Insights.labSummary(labId)` — numbers for the Lab Home tiles and burn chart. */
export interface LabSummary {
  labId?: string;
  allocationUsd?: number;
  usedUsd?: number;
  remainingUsd?: number;
  burnRateUsdPerDay?: number;
  projectedExhaustDate?: string | null;
  runningJobs?: number;
  pendingJobs?: number;
  liveGpus?: number;
  openAlerts?: number;
  criticalAlerts?: number;
  efficiencyScore?: number;
  efficiencyScorePrev?: number;
  gpuHours30d?: number;
  wastedGpuHours30d?: number;
  spend30dUsd?: number;
  burn?: BurnPoint[];
}

/** `RunMonitor.tick()` summary. */
export interface TickSummary {
  jobsAdvanced?: number;
  metricsAdded?: number;
  alertsRaised?: number;
  actionsTaken?: number;
  simulatedAt?: string;
  [key: string]: unknown;
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
