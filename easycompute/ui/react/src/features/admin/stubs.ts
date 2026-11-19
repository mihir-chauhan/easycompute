/*
 * DEV-ONLY stubs for the admin view (loaded only when VITE_ADMIN_STUBS=1). Shapes follow /project/API.md so pages
 * can be laid out before the backend is live. Never imported statically; delete once the live backend is verified.
 */

import type { ComputeCluster, JobLite, Lab, LabSummaryLite, Partition, Policy, UniversityOverview } from './types';

const CLUSTERS: ComputeCluster[] = [
  { id: 'anvil', name: 'Anvil', operator: 'NSF ACCESS', billing: 'ACCESS_SU', description: 'NSF ACCESS national resource: CPU, A100 and H100 nodes', totalNodes: 1037, totalGpus: 148, totalCores: 132608, storageTb: 10000, unitName: 'SU', usdPerUnit: 0.012, status: 'ONLINE' },
  { id: 'gilbreth', name: 'Gilbreth', operator: 'RCAC', billing: 'IN_HOUSE_NODE_SHARE', description: 'Purdue community GPU cluster with many GPU generations', totalNodes: 152, totalGpus: 412, totalCores: 7296, storageTb: 3200, unitName: 'GPU-hour', usdPerUnit: 1.1, status: 'ONLINE' },
  { id: 'gautschi', name: 'Gautschi', operator: 'RCAC', billing: 'IN_HOUSE_NODE_SHARE', description: 'Flagship CPU + H100 AI cluster (2024)', totalNodes: 356, totalGpus: 172, totalCores: 68352, storageTb: 6000, unitName: 'GPU-hour', usdPerUnit: 1.6, status: 'ONLINE' },
  { id: 'negishi', name: 'Negishi', operator: 'RCAC', billing: 'IN_HOUSE_NODE_SHARE', description: 'CPU cluster for tightly coupled MPI, small MI210 partition', totalNodes: 461, totalGpus: 15, totalCores: 58368, storageTb: 2500, unitName: 'core-hour', usdPerUnit: 0.009, status: 'DEGRADED' },
  { id: 'bell', name: 'Bell', operator: 'RCAC', billing: 'IN_HOUSE_NODE_SHARE', description: 'Decommissioned Oct 31, 2026; successor Gautschi', totalNodes: 0, totalGpus: 0, totalCores: 0, storageTb: 0, unitName: 'core-hour', usdPerUnit: 0.008, status: 'MAINTENANCE' },
  { id: 'aws-p4d', name: 'AWS p4d', operator: 'AWS', billing: 'THIRD_PARTY_HOURLY', description: 'On-demand A100 burst capacity (p4d.24xlarge)', totalNodes: 8, totalGpus: 64, totalCores: 768, storageTb: 200, unitName: 'USD', usdPerUnit: 1, status: 'ONLINE' },
];

const p = (o: Partial<Partition> & { id: string; name: string; cid: string; gpu?: string }): Partition => ({
  cluster: { id: o.cid, name: CLUSTERS.find((c) => c.id === o.cid)?.name },
  gpuType: o.gpu ? { id: o.gpu, name: o.gpu } : null,
  preemptible: false,
  chargeFactor: 1,
  ...o,
});

const PARTITIONS: Partition[] = [
  p({ id: 'gilbreth-a100-80gb', name: 'a100-80gb', cid: 'gilbreth', gpu: 'A100-80GB', gpusPerNode: 2, coresPerNode: 64, memPerNodeGb: 512, maxWalltimeHours: 336, maxNodesPerJob: 8, maxGpusPerJob: 16, maxJobsPerUser: 32, currentQueueDepth: 41, avgWaitHours: 6.4, utilizationPct: 93, nodeCount: 57, qos: 'normal', slurmPartition: 'a100-80gb' }),
  p({ id: 'gilbreth-a100-40gb', name: 'a100-40gb', cid: 'gilbreth', gpu: 'A100-40GB', gpusPerNode: 4, coresPerNode: 128, memPerNodeGb: 512, maxWalltimeHours: 336, maxNodesPerJob: 8, maxGpusPerJob: 16, maxJobsPerUser: 32, currentQueueDepth: 12, avgWaitHours: 1.8, utilizationPct: 78, nodeCount: 32, qos: 'normal', slurmPartition: 'a100-40gb' }),
  p({ id: 'gilbreth-a30', name: 'a30', cid: 'gilbreth', gpu: 'A30-24GB', gpusPerNode: 3, coresPerNode: 48, memPerNodeGb: 190, maxWalltimeHours: 336, maxNodesPerJob: 4, maxGpusPerJob: 12, maxJobsPerUser: 32, currentQueueDepth: 2, avgWaitHours: 0.2, utilizationPct: 41, nodeCount: 24, qos: 'normal', slurmPartition: 'a30' }),
  p({ id: 'gilbreth-standby', name: 'standby', cid: 'gilbreth', gpu: 'A100-40GB', gpusPerNode: 4, coresPerNode: 128, memPerNodeGb: 512, maxWalltimeHours: 4, maxNodesPerJob: 4, maxGpusPerJob: 16, maxJobsPerUser: 16, preemptible: true, chargeFactor: 0, currentQueueDepth: 9, avgWaitHours: 3.1, utilizationPct: 64, nodeCount: 32, qos: 'standby', slurmPartition: 'a100-40gb' }),
  p({ id: 'gautschi-ai', name: 'ai', cid: 'gautschi', gpu: 'H100-80GB', gpusPerNode: 8, coresPerNode: 112, memPerNodeGb: 1024, maxWalltimeHours: 96, maxNodesPerJob: 4, maxGpusPerJob: 32, maxJobsPerUser: 16, currentQueueDepth: 58, avgWaitHours: 11.2, utilizationPct: 97, nodeCount: 20, qos: 'normal', slurmPartition: 'ai' }),
  p({ id: 'gautschi-ai-preempt', name: 'ai (preemptible)', cid: 'gautschi', gpu: 'H100-80GB', gpusPerNode: 8, coresPerNode: 112, memPerNodeGb: 1024, maxWalltimeHours: 720, maxNodesPerJob: 4, maxGpusPerJob: 32, maxJobsPerUser: 16, preemptible: true, chargeFactor: 0.25, currentQueueDepth: 6, avgWaitHours: 2.2, utilizationPct: 88, nodeCount: 20, qos: 'preemptible', slurmPartition: 'ai' }),
  p({ id: 'gautschi-smallgpu', name: 'smallgpu', cid: 'gautschi', gpu: 'L40S-48GB', gpusPerNode: 2, coresPerNode: 64, memPerNodeGb: 384, maxWalltimeHours: 24, maxNodesPerJob: 1, maxGpusPerJob: 2, maxJobsPerUser: 8, currentQueueDepth: 1, avgWaitHours: 0.1, utilizationPct: 36, nodeCount: 6, qos: 'normal', slurmPartition: 'smallgpu' }),
  p({ id: 'anvil-gpu', name: 'gpu', cid: 'anvil', gpu: 'A100-40GB', gpusPerNode: 4, coresPerNode: 128, memPerNodeGb: 512, maxWalltimeHours: 48, maxNodesPerJob: 4, maxGpusPerJob: 12, maxJobsPerUser: 12, currentQueueDepth: 14, avgWaitHours: 2.6, utilizationPct: 82, nodeCount: 16, qos: 'normal', slurmPartition: 'gpu' }),
  p({ id: 'anvil-ai', name: 'ai', cid: 'anvil', gpu: 'H100-80GB', gpusPerNode: 4, coresPerNode: 96, memPerNodeGb: 1024, maxWalltimeHours: 48, maxNodesPerJob: 4, maxGpusPerJob: 12, maxJobsPerUser: 12, currentQueueDepth: 22, avgWaitHours: 5.9, utilizationPct: 91, nodeCount: 21, qos: 'normal', slurmPartition: 'ai' }),
  p({ id: 'anvil-wholenode', name: 'wholenode', cid: 'anvil', gpusPerNode: 0, coresPerNode: 128, memPerNodeGb: 256, maxWalltimeHours: 96, maxNodesPerJob: 16, maxGpusPerJob: 0, maxJobsPerUser: 64, currentQueueDepth: 120, avgWaitHours: 1.4, utilizationPct: 74, nodeCount: 750, qos: 'normal', slurmPartition: 'wholenode' }),
  p({ id: 'negishi-gpu', name: 'gpu', cid: 'negishi', gpu: 'MI210-64GB', gpusPerNode: 3, coresPerNode: 128, memPerNodeGb: 512, maxWalltimeHours: 24, maxNodesPerJob: 1, maxGpusPerJob: 2, maxJobsPerUser: 8, currentQueueDepth: 0, avgWaitHours: 0, utilizationPct: 18, nodeCount: 5, qos: 'normal', slurmPartition: 'gpu' }),
  p({ id: 'aws-p4d-ondemand', name: 'p4d-ondemand', cid: 'aws-p4d', gpu: 'A100-40GB', gpusPerNode: 8, coresPerNode: 96, memPerNodeGb: 1152, maxWalltimeHours: 168, maxNodesPerJob: 4, maxGpusPerJob: 32, maxJobsPerUser: 8, chargeFactor: 1, currentQueueDepth: 0, avgWaitHours: 0.3, utilizationPct: 55, nodeCount: 8, qos: 'normal', slurmPartition: 'p4d' }),
];

const LABS: Lab[] = [
  { id: 'lab-chen', name: 'Chen Vision Lab', piName: 'Wei Chen', department: 'Computer Science', fairShareTarget: 0.18 },
  { id: 'lab-okafor', name: 'Okafor Climate Modeling', piName: 'Ngozi Okafor', department: 'Earth, Atmospheric & Planetary Sci.', fairShareTarget: 0.14 },
  { id: 'lab-ramirez', name: 'Ramirez NLP Group', piName: 'Elena Ramirez', department: 'Computer Science', fairShareTarget: 0.16 },
  { id: 'lab-patel', name: 'Patel Computational Biology', piName: 'Anjali Patel', department: 'Biological Sciences', fairShareTarget: 0.12 },
  { id: 'lab-nguyen', name: 'Nguyen Robotics', piName: 'Minh Nguyen', department: 'Mechanical Engineering', fairShareTarget: 0.1 },
  { id: 'lab-schmidt', name: 'Schmidt Materials', piName: 'Lukas Schmidt', department: 'Materials Engineering', fairShareTarget: 0.1 },
  { id: 'lab-kim', name: 'Kim Quantum Chemistry', piName: 'Soo-ah Kim', department: 'Chemistry', fairShareTarget: 0.1 },
  { id: 'lab-brooks', name: 'Brooks Health Analytics', piName: 'Dana Brooks', department: 'Public Health', fairShareTarget: 0.1 },
];

const USAGE = [0.27, 0.09, 0.21, 0.13, 0.06, 0.08, 0.11, 0.05];

const weeks = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 16));
    d.setUTCDate(d.getUTCDate() - 7 * (n - 1 - i) + 7 * offset);
    return d.toISOString().slice(0, 10);
  });

function overview(): UniversityOverview {
  const util: Record<string, number> = { anvil: 86, gilbreth: 81, gautschi: 95, negishi: 18, bell: 0, 'aws-p4d': 55 };
  const cost: Record<string, number> = { anvil: 38200, gilbreth: 121400, gautschi: 96800, negishi: 4100, bell: 0, 'aws-p4d': 47300 };
  const clusters = CLUSTERS.map((c) => {
    const g = c.totalGpus ?? 0;
    const busy = Math.round((g * util[c.id]) / 100);
    const parts = PARTITIONS.filter((x) => x.cluster?.id === c.id);
    return {
      id: c.id, name: c.name, operator: c.operator ?? '', billing: c.billing ?? 'IN_HOUSE_NODE_SHARE', status: c.status ?? 'ONLINE',
      totalGpus: g, totalCores: c.totalCores ?? 0, storageTb: c.storageTb ?? 0, unitName: c.unitName ?? '', usdPerUnit: c.usdPerUnit ?? 0,
      gpuUtilizationPct: util[c.id], busyGpus: busy, idleGpus: g - busy,
      queueDepth: parts.reduce((s, x) => s + (x.currentQueueDepth ?? 0), 0),
      avgWaitHours: parts.length ? parts.reduce((s, x) => s + (x.avgWaitHours ?? 0), 0) / parts.length : 0,
      pendingGpuHours: parts.reduce((s, x) => s + (x.currentQueueDepth ?? 0) * 18, 0),
      jobs: Math.round(cost[c.id] / 31), gpuHours: Math.round(cost[c.id] / 1.3), costUsd: cost[c.id], liveJobs: Math.round(util[c.id] / 30),
    };
  });
  const totalGpus = clusters.reduce((s, c) => s + c.totalGpus, 0);
  const busyGpus = clusters.reduce((s, c) => s + c.busyGpus, 0);
  const actual = [8200, 8650, 8400, 9100, 9550, 9300, 10100, 10600, 10450, 11200, 11800, 12350];
  return {
    asOf: new Date().toISOString(),
    kpis: {
      clusters: 6, onlineClusters: 4, totalGpus, totalCores: 335392, storageTb: 21900, labs: 8, liveJobs: 12, runningJobs: 10, pendingJobs: 2,
      busyGpus, idleGpus: totalGpus - busyGpus, gpuUtilizationPct: Math.round((busyGpus / totalGpus) * 100), idleGpuHoursPerDay: 1310, idleUsdPerDay: 1720,
      totalCostUsd: 307800, totalGpuHours: 236700, wastedGpuHours: 41200, openAlerts: 9, criticalAlerts: 3,
    },
    clusters,
    costByBilling: [
      { billing: 'IN_HOUSE_NODE_SHARE', jobs: 7240, gpuHours: 171000, costUsd: 222300, pct: 0.72 },
      { billing: 'ACCESS_SU', jobs: 1230, gpuHours: 29400, costUsd: 38200, pct: 0.12 },
      { billing: 'THIRD_PARTY_HOURLY', jobs: 310, gpuHours: 36300, costUsd: 47300, pct: 0.15 },
    ],
    fairness: LABS.map((l, i) => {
      const ratio = USAGE[i] / (l.fairShareTarget ?? 0.1);
      return {
        labId: l.id, name: l.name, department: l.department, fairShareTarget: l.fairShareTarget ?? 0.1, usageShare: USAGE[i], ratio,
        status: ratio > 1.25 ? 'OVER' : ratio < 0.75 ? 'UNDER' : 'BALANCED', gpuHours: Math.round(236700 * USAGE[i]), costUsd: Math.round(307800 * USAGE[i]),
      };
    }),
    idle: {
      idleGpusNow: totalGpus - busyGpus, idleGpuHoursPerDay: 1310, wastedGpuHours: 41200,
      byPartition: PARTITIONS.filter((x) => x.gpuType).map((x) => {
        const gpus = (x.nodeCount ?? 0) * (x.gpusPerNode ?? 0);
        return { partitionId: x.id, name: x.name, clusterId: x.cluster?.id ?? '', gpuTypeId: x.gpuType?.id, gpus, idleGpus: Math.round(gpus * (1 - (x.utilizationPct ?? 0) / 100)), utilizationPct: x.utilizationPct ?? 0 };
      }),
      topWasteLabs: [
        { labId: 'lab-chen', name: 'Chen Vision Lab', wastedGpuHours: 12900, wastePct: 0.2 },
        { labId: 'lab-kim', name: 'Kim Quantum Chemistry', wastedGpuHours: 8100, wastePct: 0.31 },
        { labId: 'lab-ramirez', name: 'Ramirez NLP Group', wastedGpuHours: 6400, wastePct: 0.13 },
        { labId: 'lab-nguyen', name: 'Nguyen Robotics', wastedGpuHours: 4200, wastePct: 0.29 },
        { labId: 'lab-patel', name: 'Patel Computational Biology', wastedGpuHours: 3500, wastePct: 0.11 },
      ],
      idleLiveJobs: [
        { jobId: 'gilbreth-8812731', labId: 'lab-kim', user: 'user_214', gpus: 4, gpuUtilPct: 2, idleMinutes: 95 },
        { jobId: 'gautschi-512094', labId: 'lab-chen', user: 'user_031', gpus: 8, gpuUtilPct: 4, idleMinutes: 40 },
      ],
    },
    demand: {
      weekly: [
        ...weeks(12).map((w, i) => ({ week: w, gpuHours: actual[i], jobs: Math.round(actual[i] / 14), forecast: false })),
        ...weeks(4, 4).map((w, i) => ({ week: w, gpuHours: Math.round(12350 * Math.pow(1.031, i + 1)), jobs: 0, forecast: true })),
      ],
      trendPctPerWeek: 3.1,
      partitions: [
        { partitionId: 'gautschi-ai', name: 'ai', clusterId: 'gautschi', gpuTypeId: 'H100-80GB', utilizationPct: 97, queueDepth: 58, avgWaitHours: 11.2, pendingGpuHours: 4100, forecastUtilizationPct: 100, pressure: 'HIGH', recommendation: 'Queue wait above 11 h at 97% utilization; H100 demand grows ~4%/week. Add 2 H100 nodes (16 GPUs) or steer fine-tunes to A100-80GB.' },
        { partitionId: 'gilbreth-a100-80gb', name: 'a100-80gb', clusterId: 'gilbreth', gpuTypeId: 'A100-80GB', utilizationPct: 93, queueDepth: 41, avgWaitHours: 6.4, pendingGpuHours: 2600, forecastUtilizationPct: 98, pressure: 'HIGH', recommendation: 'Sustained >90% utilization with a 6 h wait. Shift short jobs to standby; plan 8 more A100-80GB nodes.' },
        { partitionId: 'anvil-ai', name: 'ai', clusterId: 'anvil', gpuTypeId: 'H100-80GB', utilizationPct: 91, queueDepth: 22, avgWaitHours: 5.9, pendingGpuHours: 1300, forecastUtilizationPct: 94, pressure: 'MEDIUM', recommendation: 'ACCESS H100 queue busy; labs with ACCESS credits can absorb Gautschi overflow.' },
        { partitionId: 'gilbreth-a30', name: 'a30', clusterId: 'gilbreth', gpuTypeId: 'A30-24GB', utilizationPct: 41, queueDepth: 2, avgWaitHours: 0.2, pendingGpuHours: 40, forecastUtilizationPct: 39, pressure: 'LOW', recommendation: 'Underused: route inference and small fine-tunes here.' },
        { partitionId: 'negishi-gpu', name: 'gpu', clusterId: 'negishi', gpuTypeId: 'MI210-64GB', utilizationPct: 18, queueDepth: 0, avgWaitHours: 0, pendingGpuHours: 0, forecastUtilizationPct: 16, pressure: 'LOW', recommendation: 'MI210 nodes mostly idle; publicise ROCm images or repurpose.' },
      ],
    },
    needsMoreResources: [
      { gpuTypeId: 'H100-80GB', pressure: 'HIGH', reason: 'Gautschi ai 97% busy, 11.2 h average wait, 4,100 pending GPU-hours' },
      { gpuTypeId: 'A100-80GB', pressure: 'HIGH', reason: 'Gilbreth a100-80gb 93% busy, 6.4 h wait' },
      { gpuTypeId: 'A100-40GB', pressure: 'MEDIUM', reason: 'Anvil gpu 82% busy; AWS burst used 3 weeks of 4' },
      { gpuTypeId: 'L40S-48GB', pressure: 'LOW', reason: '36% utilization' },
    ],
  };
}

const POLICIES: Policy[] = [
  { id: 'U-01', scope: 'UNIVERSITY', kind: 'MIN_GPU_UTIL', severity: 'WARN', title: 'GPUs must be used', description: 'RCAC samples GPU power, memory and utilization every 10 s and flags jobs that hold GPUs below 20% utilization.', limitValue: 20, limitText: '20% average GPU utilization', active: true, sourceUrl: 'https://www.rcac.purdue.edu/' },
  { id: 'U-02', scope: 'UNIVERSITY', kind: 'EXPORT_CONTROL', severity: 'BLOCK', title: 'Export-controlled data only on approved clusters', description: 'CUI / ITAR data must run on Rossmann or Weber.', active: true },
  { id: 'U-03', scope: 'UNIVERSITY', kind: 'QUIET_HOURS', severity: 'INFO', title: 'Maintenance window', description: 'Second Tuesday of the month, 06:00-18:00 ET; jobs crossing it are held.', active: true },
  { id: 'C-GA-01', scope: 'CLUSTER', kind: 'MAX_WALLTIME', severity: 'BLOCK', title: 'Gautschi ai: 4-day walltime', description: 'Normal QOS on the ai partition is limited to 4 days since 2026-11-02.', cluster: { id: 'gautschi', name: 'Gautschi' }, limitValue: 96, limitText: '96 h', active: true },
  { id: 'C-AN-01', scope: 'CLUSTER', kind: 'MAX_GPUS_PER_JOB', severity: 'BLOCK', title: 'Anvil: 12 GPUs per user', description: 'Maximum of 12 GPUs in use per user; 32 per allocation.', cluster: { id: 'anvil', name: 'Anvil' }, limitValue: 12, active: true },
  { id: 'P-GI-01', scope: 'PARTITION', kind: 'PREEMPTIBLE_ONLY', severity: 'WARN', title: 'Standby jobs may be preempted', description: 'Standby runs up to 4 h with no start-time guarantee.', cluster: { id: 'gilbreth', name: 'Gilbreth' }, partition: { id: 'gilbreth-standby', name: 'standby' }, limitValue: 4, active: true },
  { id: 'P-GA-02', scope: 'PARTITION', kind: 'MAX_GPUS_PER_JOB', severity: 'BLOCK', title: 'smallgpu: max 2 GPUs', description: 'L40S bonus partition allows 2 GPUs in use.', cluster: { id: 'gautschi', name: 'Gautschi' }, partition: { id: 'gautschi-smallgpu', name: 'smallgpu' }, limitValue: 2, active: true },
  { id: 'L-CH-01', scope: 'LAB', kind: 'BUDGET_REMAINING', severity: 'WARN', title: 'Chen lab: keep 10% reserve', description: 'Warn when a run would leave less than 10% of the NSF grant allocation.', lab: { id: 'lab-chen', name: 'Chen Vision Lab' }, limitValue: 0.1, active: true },
  { id: 'L-OK-01', scope: 'LAB', kind: 'DATA_RESIDENCY', severity: 'BLOCK', title: 'Okafor lab: NOAA data stays on campus', description: 'Licensed reanalysis data cannot be copied to third-party cloud.', lab: { id: 'lab-okafor', name: 'Okafor Climate Modeling' }, active: false },
];

function labSummary(labId: string): LabSummaryLite {
  const i = Math.max(0, LABS.findIndex((l) => l.id === labId));
  const lab = LABS[i];
  const used = [0.82, 0.41, 0.66, 0.55, 0.93, 0.3, 0.71, 0.48][i];
  return {
    lab,
    kpis: {
      liveJobs: [3, 1, 2, 2, 1, 0, 2, 1][i], runningGpus: [12, 4, 8, 4, 2, 0, 4, 1][i], openAlerts: [3, 0, 2, 1, 1, 0, 2, 0][i], criticalAlerts: [1, 0, 1, 0, 0, 0, 1, 0][i],
      jobs: 400 + i * 37, gpuHours: Math.round(236700 * USAGE[i]), costUsd: Math.round(307800 * USAGE[i]), wastedGpuHours: 1200 * (i + 1),
      wastePct: [0.2, 0.08, 0.13, 0.11, 0.29, 0.06, 0.31, 0.09][i], avgGpuUtil: [68, 81, 74, 77, 52, 85, 44, 79][i], failRate: 0.04 + i * 0.01,
      gpuHours30d: Math.round(236700 * USAGE[i] * 0.3), costUsd30d: Math.round(307800 * USAGE[i] * 0.3),
    },
    allocations: [
      { id: `${labId}-a1`, clusterId: 'gilbreth', clusterName: 'Gilbreth', source: 'GRANT', grantName: 'NSF award', unitName: 'GPU-hour', totalUnits: 50000, usedUnits: Math.round(50000 * used), startDate: '2026-07-01T00:00:00Z', endDate: '2027-06-30T00:00:00Z', daysLeft: 223, runsOutBeforeEnd: used > 0.6 },
    ],
  };
}

const LIVE_JOBS: JobLite[] = [
  { id: 'gilbreth-8812731', user: 'user_214', lab: { id: 'lab-kim', name: 'Kim Quantum Chemistry' }, partition: { id: 'gilbreth-a100-80gb', name: 'a100-80gb' }, state: 'RUNNING', allocGpus: 4, gpuUtilAvg: 3, elapsedHours: 6.2, timelimitHours: 48, jobName: 'dft-relax' },
  { id: 'gilbreth-8812990', user: 'user_031', lab: { id: 'lab-chen', name: 'Chen Vision Lab' }, partition: { id: 'gilbreth-a100-40gb', name: 'a100-40gb' }, state: 'RUNNING', allocGpus: 8, gpuUtilAvg: 88, elapsedHours: 20.5, timelimitHours: 24, jobName: 'vit-l-pretrain' },
  { id: 'gilbreth-8813102', user: 'user_118', lab: { id: 'lab-ramirez', name: 'Ramirez NLP Group' }, partition: { id: 'gilbreth-a100-80gb', name: 'a100-80gb' }, state: 'PENDING', allocGpus: 4, elapsedHours: 0, timelimitHours: 12, jobName: 'llama-8b-lora' },
];

export async function stubCall(type: string, action: string, _thisArg: unknown, args: unknown[]): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 250));
  const spec = (args[0] ?? {}) as { filter?: string };
  const idIn = (f?: string) => /'([^']+)'/.exec(f ?? '')?.[1];
  if (type === 'Insights' && action === 'universityOverview') return overview();
  if (type === 'Insights' && action === 'labSummary') return labSummary(String(args[0]));
  if (action === 'fetch') {
    const id = idIn(spec.filter);
    if (type === 'ComputeCluster') return { objs: id ? CLUSTERS.filter((c) => c.id === id) : CLUSTERS };
    if (type === 'Partition') return { objs: id ? PARTITIONS.filter((x) => x.cluster?.id === id) : PARTITIONS };
    if (type === 'Policy') return { objs: POLICIES };
    if (type === 'Lab') return { objs: LABS };
    if (type === 'Job') return { objs: id === 'gilbreth' ? LIVE_JOBS : [] };
  }
  throw new Error(`No stub for ${type}.${action}`);
}
