/*
 * Research Computing (admin) view types — shapes from /project/API.md (Insights.universityOverview, entities).
 */

import type { Billing } from '@/components/app';

export interface Ref {
  id: string;
  name?: string;
}

export interface FetchResult<T> {
  objs?: T[];
  count?: number;
}

export interface OverviewKpis {
  clusters: number;
  onlineClusters: number;
  totalGpus: number;
  totalCores: number;
  storageTb: number;
  labs: number;
  liveJobs: number;
  runningJobs: number;
  pendingJobs: number;
  busyGpus: number;
  idleGpus: number;
  gpuUtilizationPct: number;
  idleGpuHoursPerDay: number;
  idleUsdPerDay: number;
  totalCostUsd: number;
  totalGpuHours: number;
  wastedGpuHours: number;
  openAlerts: number;
  criticalAlerts: number;
}

export interface OverviewCluster {
  id: string;
  name: string;
  operator: string;
  billing: Billing;
  status: string;
  totalGpus: number;
  totalCores: number;
  storageTb: number;
  unitName: string;
  usdPerUnit: number;
  gpuUtilizationPct: number;
  busyGpus: number;
  idleGpus: number;
  queueDepth: number;
  avgWaitHours: number;
  pendingGpuHours: number;
  jobs: number;
  gpuHours: number;
  costUsd: number;
  liveJobs: number;
}

export interface CostByBilling {
  billing: Billing;
  jobs: number;
  gpuHours: number;
  costUsd: number;
  pct: number;
}

export interface FairnessRow {
  labId: string;
  name: string;
  department?: string;
  fairShareTarget: number;
  usageShare: number;
  ratio: number;
  status: 'OVER' | 'UNDER' | 'BALANCED';
  gpuHours: number;
  costUsd: number;
}

export interface IdlePartition {
  partitionId: string;
  name: string;
  clusterId: string;
  gpuTypeId?: string;
  gpus: number;
  idleGpus: number;
  utilizationPct: number;
}

export interface UniversityOverview {
  asOf: string;
  kpis: OverviewKpis;
  clusters: OverviewCluster[];
  costByBilling: CostByBilling[];
  fairness: FairnessRow[];
  idle: {
    idleGpusNow: number;
    idleGpuHoursPerDay: number;
    wastedGpuHours: number;
    byPartition: IdlePartition[];
    topWasteLabs: Array<{ labId: string; name: string; wastedGpuHours: number; wastePct: number }>;
    idleLiveJobs: Array<{ jobId: string; labId: string; user: string; gpus: number; gpuUtilPct: number; idleMinutes: number }>;
  };
  demand: {
    weekly: Array<{ week: string; gpuHours: number; jobs: number; forecast: boolean }>;
    trendPctPerWeek: number;
    partitions: Array<{
      partitionId: string;
      name: string;
      clusterId: string;
      gpuTypeId?: string;
      utilizationPct: number;
      queueDepth: number;
      avgWaitHours: number;
      pendingGpuHours: number;
      forecastUtilizationPct: number;
      pressure: 'HIGH' | 'MEDIUM' | 'LOW';
      recommendation?: string;
    }>;
  };
  needsMoreResources: Array<{ gpuTypeId: string; pressure: 'HIGH' | 'MEDIUM' | 'LOW'; reason: string }>;
}

export interface ComputeCluster {
  id: string;
  name: string;
  operator?: string;
  billing?: Billing;
  description?: string;
  totalNodes?: number;
  totalGpus?: number;
  totalCores?: number;
  storageTb?: number;
  unitName?: string;
  usdPerUnit?: number;
  status?: string;
}

export interface Partition {
  id: string;
  name: string;
  cluster?: Ref;
  gpuType?: Ref | null;
  gpusPerNode?: number;
  coresPerNode?: number;
  memPerNodeGb?: number;
  maxWalltimeHours?: number;
  maxNodesPerJob?: number;
  maxGpusPerJob?: number;
  maxJobsPerUser?: number;
  preemptible?: boolean;
  chargeFactor?: number;
  currentQueueDepth?: number;
  avgWaitHours?: number;
  utilizationPct?: number;
  nodeCount?: number;
  qos?: string;
  slurmPartition?: string;
}

export interface Policy {
  id: string;
  name?: string;
  scope: 'UNIVERSITY' | 'CLUSTER' | 'PARTITION' | 'LAB';
  kind: string;
  severity: 'BLOCK' | 'WARN' | 'INFO';
  title: string;
  description?: string;
  cluster?: Ref | null;
  partition?: Ref | null;
  lab?: Ref | null;
  limitValue?: number | null;
  limitText?: string | null;
  sourceUrl?: string | null;
  active?: boolean;
}

export interface Lab {
  id: string;
  name: string;
  piName?: string;
  piEmail?: string;
  department?: string;
  researchArea?: string;
  fairShareTarget?: number;
  preferredClusters?: string;
  slurmAccounts?: string;
}

export interface LabAllocationSummary {
  id: string;
  name?: string;
  clusterId: string;
  clusterName?: string;
  source?: string;
  grantName?: string;
  unitName?: string;
  totalUnits: number;
  usedUnits: number;
  remainingUnits?: number;
  pctUsed?: number;
  remainingUsd?: number;
  startDate?: string;
  endDate?: string;
  daysLeft?: number;
  burnPerDay?: number;
  projectedRunOut?: string | null;
  runsOutBeforeEnd?: boolean;
}

/** Subset of Insights.labSummary used by the admin Labs table. */
export interface LabSummaryLite {
  lab: Lab;
  kpis: {
    liveJobs: number;
    runningGpus: number;
    openAlerts: number;
    criticalAlerts: number;
    jobs: number;
    gpuHours: number;
    costUsd: number;
    wastedGpuHours: number;
    wastePct: number;
    avgGpuUtil: number;
    failRate: number;
    gpuHours30d: number;
    costUsd30d: number;
  };
  allocations: LabAllocationSummary[];
  efficiency?: { avgCpuEfficiency: number; avgMemEfficiency: number; avgGpuUtil: number; timeEfficiency: number };
}

export interface JobLite {
  id: string;
  user?: string;
  lab?: Ref;
  partition?: Ref;
  state: string;
  allocGpus?: number;
  gpuUtilAvg?: number;
  elapsedHours?: number;
  timelimitHours?: number;
  jobName?: string;
}
