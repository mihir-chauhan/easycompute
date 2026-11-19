/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/**
 * DEV-ONLY in-memory backend for the lab pages, loaded only when `VITE_LAB_STUBS=1` (see `labCall` in api.ts).
 * Shapes follow SPEC.md/API.md; it lets layout work proceed before the C3 backend is live. Delete once the
 * integrator confirms the live backend.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type {
  ActionLog,
  Alert,
  ExtractedConstraint,
  Job,
  JobMetric,
  LabSummary,
  Policy,
  RuleCheck,
  RunPlan,
  RunRequest,
} from './types';

let seed = 42;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const NOW = Date.now();
const iso = (msOffset: number) => new Date(NOW + msOffset).toISOString();
const H = 3600000;
const D = 24 * H;

const labs = [
  { id: 'lab-vision', name: 'Visual Intelligence Lab', piName: 'Prof. Ana Reyes', piEmail: 'areyes@purdue.edu', department: 'Computer Science', researchArea: 'Computer vision, multimodal LLMs', slurmAccounts: 'reyes,reyes-gpu', fairShareTarget: 0.12, preferredClusters: 'gautschi,gilbreth', notes: '', contextDump: 'We own 4 H100 GPUs on Gautschi (bought 2025) and 6 A100-80GB on Gilbreth. NeurIPS 2026 camera-ready is due Dec 12; CVPR 2027 submission Nov 14. Thesis runs must never go on preemptible. Keep total cloud spend under $2,000 per month. Students should not use more than 8 GPUs at once without asking me. No jobs during the Dec 1-3 maintenance window.' },
  { id: 'lab-climate', name: 'Climate Modeling Group', piName: 'Prof. David Okafor', piEmail: 'dokafor@purdue.edu', department: 'Earth, Atmospheric & Planetary Sciences', researchArea: 'Regional climate simulation', slurmAccounts: 'okafor', fairShareTarget: 0.08, preferredClusters: 'anvil,negishi', notes: '', contextDump: '' },
  { id: 'lab-bio', name: 'Protein Design Lab', piName: 'Prof. Mei Lin', piEmail: 'mlin@purdue.edu', department: 'Biological Sciences', researchArea: 'Protein structure prediction', slurmAccounts: 'linlab', fairShareTarget: 0.06, preferredClusters: 'gilbreth', notes: '', contextDump: '' },
];

const clusters: Record<string, { name: string; unit: string; usd: number; billing: string }> = {
  gautschi: { name: 'Gautschi', unit: 'GPU-hour', usd: 2.1, billing: 'IN_HOUSE_NODE_SHARE' },
  gilbreth: { name: 'Gilbreth', unit: 'GPU-hour', usd: 1.4, billing: 'IN_HOUSE_NODE_SHARE' },
  anvil: { name: 'Anvil', unit: 'SU', usd: 0.08, billing: 'ACCESS_SU' },
  'aws-p4d': { name: 'AWS p4d', unit: 'USD', usd: 1, billing: 'THIRD_PARTY_HOURLY' },
};

const gpuTypes = [
  { id: 'H100-80GB', name: 'NVIDIA H100 80GB', memoryGb: 80 },
  { id: 'A100-80GB', name: 'NVIDIA A100 80GB', memoryGb: 80 },
  { id: 'A100-40GB', name: 'NVIDIA A100 40GB', memoryGb: 40 },
  { id: 'L40S', name: 'NVIDIA L40S', memoryGb: 48 },
  { id: 'A30', name: 'NVIDIA A30', memoryGb: 24 },
];

const ref = (id: string, name?: string) => ({ id, name: name ?? clusters[id]?.name ?? id });

const allocations = (labId: string) => [
  { id: `${labId}-alloc-1`, cluster: ref('gautschi'), source: 'GRANT', grantName: 'NSF IIS-2412345', totalUnits: 35040, usedUnits: 24310, unitName: 'GPU-hour', startDate: iso(-200 * D), endDate: iso(165 * D) },
  { id: `${labId}-alloc-2`, cluster: ref('gilbreth'), source: 'DEPARTMENT', grantName: 'CS dept. node share', totalUnits: 20000, usedUnits: 8120, unitName: 'GPU-hour', startDate: iso(-140 * D), endDate: iso(225 * D) },
  { id: `${labId}-alloc-3`, cluster: ref('anvil'), source: 'ACCESS', grantName: 'ACCESS Explore CIS250117', totalUnits: 400000, usedUnits: 371000, unitName: 'SU', startDate: iso(-300 * D), endDate: iso(40 * D) },
  { id: `${labId}-alloc-4`, cluster: ref('aws-p4d'), source: 'CLOUD_CREDITS', grantName: 'AWS Cloud Credit for Research', totalUnits: 15000, usedUnits: 6420, unitName: 'USD', startDate: iso(-90 * D), endDate: iso(90 * D) },
];

const projects = [
  { id: 'p-cvpr', name: 'Video-language grounding', description: 'Temporal grounding with a 7B video LLM', deadline: iso(9 * D + 5 * H), deadlineLabel: 'CVPR 2027 rebuttal', priority: 1, workloadType: 'FINETUNE' },
  { id: 'p-neurips', name: 'Efficient ViT distillation', description: 'Camera-ready experiments', deadline: iso(23 * D), deadlineLabel: 'NeurIPS 2026 camera-ready', priority: 1, workloadType: 'TRAINING' },
  { id: 'p-thesis', name: 'Thesis: robust segmentation', description: 'Maya Chen PhD thesis', deadline: iso(118 * D), deadlineLabel: 'Thesis defense', priority: 2, workloadType: 'TRAINING' },
  { id: 'p-demo', name: 'Open-house demo', description: 'Interactive inference demo', deadline: iso(-3 * D), deadlineLabel: 'Engineering open house', priority: 3, workloadType: 'INFERENCE' },
];

const members = [
  { id: 'm1', name: 'Ana Reyes', username: 'user_101', role: 'PI' },
  { id: 'm2', name: 'Jonah Patel', username: 'user_214', role: 'POSTDOC' },
  { id: 'm3', name: 'Maya Chen', username: 'user_377', role: 'STUDENT' },
  { id: 'm4', name: 'Luis Ortega', username: 'user_412', role: 'STUDENT' },
  { id: 'm5', name: 'Priya Nair', username: 'user_455', role: 'STUDENT' },
];

let policies: Policy[] = [
  { id: 'U-01', scope: 'UNIVERSITY', kind: 'EXPORT_CONTROL', severity: 'BLOCK', title: 'Export-controlled data only on Weber', active: true },
  { id: 'U-04', scope: 'UNIVERSITY', kind: 'DATA_RESIDENCY', severity: 'WARN', title: 'Patient data must stay on Purdue-owned resources', active: true },
  { id: 'C-GA-01', scope: 'CLUSTER', kind: 'MAX_WALLTIME', severity: 'BLOCK', title: 'Gautschi ai normal QOS: 4-day max walltime', limitValue: 96, active: true },
  { id: 'C-GA-02', scope: 'CLUSTER', kind: 'FAIRSHARE_CAP', severity: 'BLOCK', title: 'Gautschi ai: concurrent GPUs ≤ max(2, 2× purchased)', limitValue: 8, active: true },
  { id: 'P-GI-A100', scope: 'PARTITION', kind: 'MAX_WALLTIME', severity: 'BLOCK', title: 'Gilbreth a100-80gb: 14-day max walltime', limitValue: 336, active: true },
  { id: 'P-GI-STBY', scope: 'PARTITION', kind: 'MAX_WALLTIME', severity: 'WARN', title: 'Gilbreth standby: 4-hour max, no start guarantee', limitValue: 4, active: true },
  { id: 'L-VIS-01', scope: 'LAB', kind: 'PREEMPTIBLE_ONLY', severity: 'BLOCK', title: 'Thesis runs never on preemptible QOS', lab: { id: 'lab-vision' }, limitText: 'project=thesis', active: true },
  { id: 'L-VIS-02', scope: 'LAB', kind: 'MAX_GPUS_PER_JOB', severity: 'WARN', title: 'Students: ≤ 8 GPUs per job without PI approval', lab: { id: 'lab-vision' }, limitValue: 8, active: true },
  { id: 'L-VIS-03', scope: 'LAB', kind: 'BUDGET_REMAINING', severity: 'WARN', title: 'Cloud spend ≤ $2,000 / month', lab: { id: 'lab-vision' }, limitValue: 2000, active: true },
  { id: 'L-VIS-04', scope: 'LAB', kind: 'QUIET_HOURS', severity: 'INFO', title: 'No submissions during Dec 1-3 maintenance', lab: { id: 'lab-vision' }, limitText: 'Dec 1-3', active: false },
];

const autopilot: Record<string, any> = {};

/* ---- live jobs + metrics ---- */

type Scenario = 'healthy' | 'idle' | 'oom' | 'walltime' | 'stale' | 'budget' | 'pending';
const liveDefs: [string, string, string, string, string, number, Scenario, number, number][] = [
  // name, user, cluster, partition, gpuType, gpus, scenario, elapsedH, limitH
  ['llava-ft-lora-r64', 'user_377', 'gautschi', 'ai', 'H100-80GB', 4, 'healthy', 9.5, 24],
  ['vit-distill-s3', 'user_214', 'gautschi', 'ai', 'H100-80GB', 8, 'idle', 3.2, 48],
  ['seg-sweep-07', 'user_412', 'gilbreth', 'a100-80gb', 'A100-80GB', 2, 'oom', 5.1, 12],
  ['videollm-7b-pretrain', 'user_214', 'gilbreth', 'a100-80gb', 'A100-80GB', 4, 'walltime', 22.4, 24],
  ['clip-eval-standby', 'user_455', 'gilbreth', 'a100-40gb', 'A100-40GB', 1, 'stale', 2.8, 4],
  ['diffusion-xl-aws', 'user_377', 'aws-p4d', 'p4d.24xlarge', 'A100-40GB', 8, 'budget', 14.0, 72],
  ['dino-v3-probe', 'user_412', 'gautschi', 'ai', 'H100-80GB', 2, 'pending', 0, 12],
];

const jobs: Job[] = [];
const metrics: Record<string, JobMetric[]> = {};
const alerts: Alert[] = [];
const actions: ActionLog[] = [];

function sample(s: Scenario, i: number, n: number): Partial<JobMetric> {
  const t = i / n;
  const noise = () => (rnd() - 0.5) * 8;
  const base = { cpuUtilPct: 55 + noise(), memPct: 48 + noise(), ioReadMBps: 220 + noise() * 10, ioWriteMBps: 18 + noise(), powerW: 560 + noise() * 6, gpuMemPct: 72 + noise() / 2, gpuUtilPct: 88 + noise() };
  if (s === 'idle') Object.assign(base, { gpuUtilPct: t > 0.55 ? 2 + rnd() * 3 : 74 + noise(), powerW: t > 0.55 ? 95 : 520, ioReadMBps: t > 0.55 ? 1 : 180 });
  if (s === 'oom') Object.assign(base, { gpuMemPct: Math.min(99, 70 + t * 29 + noise() / 4), gpuUtilPct: 81 + noise() });
  if (s === 'stale') Object.assign(base, { gpuUtilPct: 62 + noise() });
  if (s === 'budget') Object.assign(base, { gpuUtilPct: 34 + noise(), powerW: 260 + noise() * 4 });
  return { ...base, checkpointAgeMin: s === 'stale' ? 40 + i * 2.5 : ((i * 5) % 45), trainingLoss: 2.4 * Math.exp(-2 * t) + 0.3 + rnd() * 0.04 };
}

liveDefs.forEach(([name, user, cl, part, gpu, gpus, sc, el, lim], k) => {
  const id = `${cl}-${8241900 + k * 7}`;
  const running = sc !== 'pending';
  const rate = clusters[cl].usd * (cl === 'aws-p4d' ? 4.1 : 1);
  jobs.push({
    id, slurmJobId: String(8241900 + k * 7), lab: { id: 'lab-vision' }, user, jobName: name, state: running ? 'RUNNING' : 'PENDING',
    workloadType: k % 3 === 0 ? 'FINETUNE' : 'TRAINING', cluster: ref(cl), partition: ref(`${cl}-${part}`, part), qos: sc === 'stale' ? 'standby' : 'normal',
    allocGpus: gpus, allocNodes: gpus > 4 ? 2 : 1, allocCpus: gpus * 14, gpuType: ref(gpu, gpu), timelimitHours: lim, elapsedHours: el,
    gpuUtilAvg: running ? 0 : undefined, costUsd: +(el * gpus * rate).toFixed(2), costUnits: el * gpus, submitTime: iso(-(el + 0.4 + k * 0.1) * H),
    startTime: running ? iso(-el * H) : undefined, project: ref(k % 2 ? 'p-neurips' : 'p-cvpr', k % 2 ? 'Efficient ViT distillation' : 'Video-language grounding'), isLive: true, account: 'reyes-gpu',
    nodeList: running ? `${cl === 'gautschi' ? 'h' : 'k'}0${10 + k}` : '(Priority)', reqMemGb: gpus * 120,
  });
  const n = running ? 48 : 0;
  metrics[id] = Array.from({ length: n }, (_, i) => ({ id: `${id}-m${i}`, ts: iso(-(n - 1 - i) * 5 * 60000), ...sample(sc, i, n) }) as JobMetric);
  const util = metrics[id].map((m) => m.gpuUtilPct ?? 0);
  if (util.length) jobs[jobs.length - 1].gpuUtilAvg = util.reduce((a, b) => a + b, 0) / util.length;
  const alertFor: Partial<Record<Scenario, [Alert['type'], Alert['severity'], string, Alert['recommendedAction']]>> = {
    idle: ['IDLE_GPU', 'CRITICAL', '8 of 8 GPUs under 5% for 85 min after the dataloader stalled; burning ≈ $34/h.', 'CANCEL'],
    oom: ['OOM_RISK', 'WARNING', 'GPU memory at 98% and rising 1.2%/10 min; OOM expected in ~25 min.', 'CHECKPOINT_NOW'],
    walltime: ['WALLTIME_RISK', 'CRITICAL', 'ETA 3.1 h at current step rate, only 1.6 h of walltime left.', 'EXTEND_WALLTIME'],
    stale: ['STALE_CHECKPOINT', 'WARNING', 'Last checkpoint 157 min ago on a standby (preemptible) job.', 'CHECKPOINT_NOW'],
    budget: ['BUDGET_BURN', 'WARNING', 'AWS burn rate $134/h would exhaust cloud credits 11 days before NeurIPS camera-ready.', 'SCALE_DOWN'],
  };
  const a = alertFor[sc];
  if (a) alerts.push({ id: `al-${id}`, job: { id, name }, lab: { id: 'lab-vision' }, alertType: a[0], severity: a[1], status: 'OPEN', detectedAt: iso(-(20 + k * 7) * 60000), message: a[2], recommendedAction: a[3], autoActionTaken: false });
  actions.push({ id: `act-${id}-0`, lab: { id: 'lab-vision' }, job: { id, name }, actionType: 'SUBMIT', actor: 'USER', actedAt: iso(-(el + 0.4) * H), detail: `Submitted ${name} (${gpus}× ${gpu}, ${lim} h) to ${cl}/${part}`, outcome: 'DONE' });
  if (sc === 'stale') actions.push({ id: `act-${id}-1`, lab: { id: 'lab-vision' }, job: { id, name }, actionType: 'NOTIFY_PI', actor: 'AUTOPILOT', actedAt: iso(-12 * 60000), detail: 'Emailed user_455 and PI: checkpoint is stale on a preemptible job.', outcome: 'DONE' });
});

/* ---- history ---- */
const history: Job[] = Array.from({ length: 420 }, (_, i) => {
  const users = ['user_101', 'user_214', 'user_377', 'user_412', 'user_455'];
  const cl = ['gautschi', 'gilbreth', 'gilbreth', 'anvil', 'aws-p4d'][i % 5];
  const gpus = [1, 2, 4, 8][Math.floor(rnd() * 4)];
  const lim = [4, 12, 24, 48][Math.floor(rnd() * 4)];
  const el = Math.min(lim, lim * (0.15 + rnd() * 0.9));
  const r = rnd();
  const state = r < 0.72 ? 'COMPLETED' : r < 0.82 ? 'FAILED' : r < 0.9 ? 'TIMEOUT' : r < 0.95 ? 'OUT_OF_MEMORY' : 'CANCELLED';
  const util = Math.max(1, Math.min(99, 20 + rnd() * 80 - (i % 7 === 0 ? 50 : 0)));
  const end = iso(-(i * 0.2 + 0.5) * D);
  return {
    id: `h-${i}`, user: users[i % 5], jobName: ['train', 'sweep', 'eval', 'ft'][i % 4] + `-${i}`, state, workloadType: (['TRAINING', 'FINETUNE', 'INFERENCE', 'DATA_PROCESSING'] as const)[i % 4],
    cluster: ref(cl), allocGpus: gpus, allocCpus: gpus * 12, timelimitHours: lim, elapsedHours: el, gpuUtilAvg: util, cpuEfficiency: 0.1 + rnd() * 0.8,
    memEfficiency: 0.05 + rnd() * 0.85, costUsd: el * gpus * clusters[cl].usd * (cl === 'anvil' ? 20 : 1), endTime: end, startTime: new Date(new Date(end).getTime() - el * H).toISOString(),
    project: ref(projects[i % 4].id, projects[i % 4].name),
  } as Job;
});

/* ---- run requests ---- */
const runRequests: Record<string, RunRequest> = {};
const checks: Record<string, RuleCheck[]> = {};
const plans: Record<string, RunPlan[]> = {};

function summary(labId: string): LabSummary {
  const live = jobs.filter((j) => j.lab?.id === labId || labId === 'lab-vision');
  const burn = Array.from({ length: 60 }, (_, i) => ({ date: iso(-(59 - i) * D).slice(0, 10), usedUsd: 38000 + i * 520 + Math.round(rnd() * 400) + (i > 45 ? (i - 45) * 380 : 0), planUsd: 38000 + i * 610 }));
  return {
    labId, allocationUsd: 128400, usedUsd: burn[59].usedUsd, remainingUsd: 128400 - burn[59].usedUsd, burnRateUsdPerDay: 902, projectedExhaustDate: iso(52 * D),
    runningJobs: live.filter((j) => j.state === 'RUNNING').length, pendingJobs: live.filter((j) => j.state === 'PENDING').length,
    liveGpus: live.reduce((s, j) => s + (j.state === 'RUNNING' ? (j.allocGpus ?? 0) : 0), 0),
    openAlerts: alerts.filter((a) => a.status === 'OPEN').length, criticalAlerts: alerts.filter((a) => a.status === 'OPEN' && a.severity === 'CRITICAL').length,
    efficiencyScore: 68, efficiencyScorePrev: 61, gpuHours30d: 9120, wastedGpuHours30d: 1874, spend30dUsd: 23950, burn,
  };
}

const filterVal = (spec: any, field: string): string | undefined => {
  const m = new RegExp(`${field.replace('.', '\\.')} == '([^']+)'`).exec(spec?.filter ?? '');
  return m?.[1];
};

function page<T>(rows: T[], spec: any) {
  const objs = rows.slice(spec?.offset ?? 0, (spec?.offset ?? 0) + (spec?.limit ?? 100));
  return { objs, count: objs.length, hasMore: false };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function tick() {
  let added = 0;
  jobs.filter((j) => j.isLive && j.state === 'RUNNING').forEach((j) => {
    const ms = metrics[j.id];
    const last = ms[ms.length - 1];
    for (let k = 1; k <= 3; k++) {
      const next = { ...last, id: `${j.id}-m${ms.length}`, ts: new Date(new Date(last.ts).getTime() + k * 5 * 60000).toISOString(), gpuUtilPct: Math.max(0, Math.min(100, (last.gpuUtilPct ?? 50) + (rnd() - 0.5) * 6)), checkpointAgeMin: (last.checkpointAgeMin ?? 0) + 5 };
      ms.push(next);
      added++;
    }
    j.elapsedHours = (j.elapsedHours ?? 0) + 0.25;
    j.costUsd = (j.costUsd ?? 0) + 0.25 * (j.allocGpus ?? 1) * 2.1;
  });
  const pend = jobs.find((j) => j.state === 'PENDING');
  if (pend) {
    pend.state = 'RUNNING';
    pend.startTime = new Date().toISOString();
    metrics[pend.id] = Array.from({ length: 3 }, (_, i) => ({ id: `${pend.id}-m${i}`, ts: iso(-(2 - i) * 5 * 60000), ...sample('healthy', i, 48) }) as JobMetric);
  }
  return { jobsAdvanced: jobs.filter((j) => j.state === 'RUNNING').length, metricsAdded: added, alertsRaised: 0, actionsTaken: 0, simulatedAt: new Date().toISOString() };
}

function extract(text: string): ExtractedConstraint[] {
  const out: ExtractedConstraint[] = [];
  const sentences = text.split(/(?<=[.;])\s+/);
  sentences.forEach((s, i) => {
    const gpus = /(\d+)\s*GPUs?\s*at once/i.exec(s);
    const usd = /\$([\d,]+)/.exec(s);
    if (/preemptible/i.test(s)) out.push({ key: `c${i}`, kind: 'PREEMPTIBLE_ONLY', severity: 'BLOCK', title: 'Never run on preemptible QOS', limitText: /thesis/i.test(s) ? 'project=thesis' : null, sourceText: s });
    if (gpus) out.push({ key: `c${i}g`, kind: 'MAX_GPUS_PER_JOB', severity: 'WARN', title: `≤ ${gpus[1]} GPUs per job without PI approval`, limitValue: Number(gpus[1]), sourceText: s });
    if (usd) out.push({ key: `c${i}u`, kind: 'BUDGET_REMAINING', severity: 'WARN', title: `Spend cap $${usd[1]}`, limitValue: Number(usd[1].replace(/,/g, '')), sourceText: s });
    if (/due|deadline|submission/i.test(s)) out.push({ key: `c${i}d`, kind: 'DEADLINE_FEASIBLE', severity: 'INFO', title: s.replace(/\.$/, '').slice(0, 60), limitText: s, sourceText: s });
    if (/maintenance|no jobs/i.test(s)) out.push({ key: `c${i}q`, kind: 'QUIET_HOURS', severity: 'INFO', title: 'Quiet window', limitText: s, sourceText: s });
  });
  return out;
}

export async function stubCall(type: string, action: string, thisArg: any, args: any[]): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 250 + rnd() * 350));
  const spec = args[0];
  const key = `${type}.${action}`;
  switch (key) {
    case 'Lab.fetch': return page(labs, spec);
    case 'Lab.get': return clone(labs.find((l) => l.id === thisArg.id) ?? null);
    case 'Lab.merge': Object.assign(labs.find((l) => l.id === thisArg.id) ?? {}, thisArg); return thisArg;
    case 'Allocation.fetch': return page(allocations(filterVal(spec, 'lab.id') ?? ''), spec);
    case 'Project.fetch': return page(projects, spec);
    case 'LabMember.fetch': return page(members, spec);
    case 'Policy.fetch': return page(policies.filter((p) => p.scope === 'LAB' && p.lab?.id === filterVal(spec, 'lab.id')), spec);
    case 'Policy.create': policies.push(thisArg); return thisArg;
    case 'Policy.merge': Object.assign(policies.find((p) => p.id === thisArg.id) ?? {}, thisArg); return thisArg;
    case 'Policy.remove': policies = policies.filter((p) => p.id !== thisArg.id); return true;
    case 'AutopilotPolicy.get': return autopilot[thisArg.id] ?? (autopilot[thisArg.id] = { id: thisArg.id, lab: { id: thisArg.id }, enabled: true, cancelIdleAfterMin: 60, checkpointBeforeTimeoutMin: 30, autoExtendWalltime: false, requeueToStandbyOnLowPriority: true, notifyPiOnCritical: true, budgetAlertPct: 0.8 });
    case 'AutopilotPolicy.merge': autopilot[thisArg.id] = { ...autopilot[thisArg.id], ...thisArg }; return autopilot[thisArg.id];
    case 'Advisor.extractConstraints': return extract(args[1] ?? '');
    case 'Insights.labSummary': return summary(args[0]);
    case 'Insights.predictDuration': return { estGpuHours: Math.round(((args[3] ?? 7) * 3.1 + 6) * 10) / 10, estDurationHours: 0, basis: 'stub' };
    case 'Job.fetch': return page(clone(/isLive == true/.test(spec.filter) ? jobs : history), spec);
    case 'Job.get': return clone(jobs.find((j) => j.id === thisArg.id) ?? history.find((j) => j.id === thisArg.id) ?? null);
    case 'JobMetric.fetch': {
      const jobId = filterVal(spec, 'job.id');
      const rows = jobId ? (metrics[jobId] ?? []).map((m) => ({ ...m, job: { id: jobId } })) : Object.entries(metrics).flatMap(([id, ms]) => ms.map((m) => ({ ...m, job: { id } })));
      return page(clone(rows).sort((a, b) => b.ts.localeCompare(a.ts)), spec);
    }
    case 'JobAlert.fetch': {
      const jobId = filterVal(spec, 'job.id');
      return page(clone(alerts.filter((a) => (jobId ? a.job?.id === jobId : a.status === 'OPEN' || a.status === 'ACKED'))), spec);
    }
    case 'JobAlert.merge': Object.assign(alerts.find((a) => a.id === thisArg.id) ?? {}, thisArg); return thisArg;
    case 'ActionLogEntry.fetch': {
      const jobId = filterVal(spec, 'job.id');
      return page(clone(actions.filter((a) => !jobId || a.job?.id === jobId).sort((a, b) => b.actedAt.localeCompare(a.actedAt))), spec);
    }
    case 'Job.applyAction': {
      const j = jobs.find((x) => x.id === thisArg.id);
      if (!j) throw new Error('Job not found');
      const [act] = args;
      let detail = '';
      if (act === 'CANCEL') { j.state = 'CANCELLED'; j.isLive = true; detail = `scancel ${j.slurmJobId}`; }
      if (act === 'EXTEND_WALLTIME') { j.timelimitHours = (j.timelimitHours ?? 0) + 4; detail = `scontrol update JobId=${j.slurmJobId} TimeLimit=+4:00:00 (admin approval requested)`; }
      if (act === 'CHECKPOINT_NOW') { metrics[j.id].at(-1)!.checkpointAgeMin = 0; detail = `scancel --signal=USR1 ${j.slurmJobId}`; }
      if (act === 'SCALE_DOWN') { j.allocGpus = Math.max(1, Math.floor((j.allocGpus ?? 2) / 2)); detail = `Requeued with ${j.allocGpus} GPUs from last checkpoint`; }
      if (act === 'REQUEUE_STANDBY') { j.qos = 'standby'; detail = 'Requeued to standby QOS'; }
      if (act === 'NOTIFY_PI') detail = 'Emailed PI with alert summary';
      alerts.filter((a) => a.job?.id === j.id && a.status === 'OPEN' && a.recommendedAction === act).forEach((a) => { a.status = 'RESOLVED'; });
      const log: ActionLog = { id: `act-${Date.now()}`, lab: { id: 'lab-vision' }, job: { id: j.id, name: j.jobName }, actionType: act, actor: 'USER', actedAt: new Date().toISOString(), detail, outcome: act === 'EXTEND_WALLTIME' ? 'PENDING_APPROVAL' : 'DONE' };
      actions.push(log);
      return log;
    }
    case 'RunMonitor.tick': return tick();
    case 'GpuType.fetch': return page(gpuTypes, spec);
    case 'ComputeCluster.fetch': return page(Object.entries(clusters).map(([id, c]) => ({ id, name: c.name, billing: c.billing })), spec);
    case 'RunRequest.create': runRequests[thisArg.id] = thisArg; return thisArg;
    case 'RunRequest.merge': runRequests[thisArg.id] = { ...runRequests[thisArg.id], ...thisArg }; return thisArg;
    case 'RunRequest.checkRules': {
      const rr = runRequests[thisArg.id];
      const gpus = rr.requestedGpus ?? 4;
      const wall = rr.requestedWalltimeHours ?? 24;
      const mk = (p: Policy, outcome: RuleCheck['outcome'], message: string): RuleCheck => ({ id: `${rr.id}-${p.id}`, policy: p, outcome, message });
      const pol = (id: string) => policies.find((p) => p.id === id) as Policy;
      checks[rr.id] = [
        mk(pol('U-01'), 'PASS', 'No export-controlled data declared.'),
        mk(pol('U-04'), rr.description?.match(/clinical|patient/i) ? 'WARN' : 'PASS', rr.description?.match(/clinical|patient/i) ? 'Description mentions clinical data: AWS plans are excluded.' : 'No regulated data mentioned.'),
        mk(pol('C-GA-01'), wall > 96 ? 'FAIL' : 'PASS', wall > 96 ? `Requested ${wall} h exceeds the 96 h limit on Gautschi normal QOS (since 2026-11-02). Plans split into checkpointed chunks or use preemptible.` : `${wall} h is within the 96 h limit.`),
        mk(pol('C-GA-02'), gpus > 8 ? 'FAIL' : gpus > 4 ? 'WARN' : 'PASS', gpus > 8 ? `${gpus} GPUs exceeds the lab cap of 8 concurrent H100s.` : `Lab is using 4 of 8 allowed H100s; this run needs ${gpus}.`),
        mk(pol('P-GI-A100'), 'PASS', 'Within the 14-day limit.'),
        mk(pol('L-VIS-01'), rr.project?.id === 'p-thesis' ? 'WARN' : 'PASS', rr.project?.id === 'p-thesis' ? 'Thesis project: preemptible plans removed.' : 'Not a thesis run.'),
        mk(pol('L-VIS-02'), gpus > 8 ? 'WARN' : 'PASS', gpus > 8 ? 'Needs PI approval (> 8 GPUs).' : `${gpus} GPUs is within the student cap.`),
        mk(pol('L-VIS-03'), 'WARN', 'Cloud spend this month is $1,640 of $2,000; AWS plans would exceed the cap.'),
        mk({ id: 'X-BUDGET', scope: 'LAB', kind: 'BUDGET_REMAINING', severity: 'WARN', title: 'Allocation balance covers estimate' }, 'PASS', '10,730 GPU-h left on Gautschi; estimate is 64 GPU-h.'),
        mk({ id: 'X-DEADLINE', scope: 'LAB', kind: 'DEADLINE_FEASIBLE', severity: 'WARN', title: 'Deadline feasible' }, 'PASS', 'At least one plan finishes 6 days before the deadline.'),
      ];
      rr.status = 'CHECKED';
      return checks[rr.id];
    }
    case 'RuleCheck.fetch': return page(checks[filterVal(spec, 'runRequest.id') ?? ''] ?? [], spec);
    case 'RunRequest.recommendPlans': {
      const rr = runRequests[thisArg.id];
      const gh = rr.estGpuHours ?? 64;
      const sb = (part: string, qos: string, g: number, w: number, cl: string) => `#!/bin/bash\n#SBATCH --job-name=${rr.name.replace(/\s+/g, '-').toLowerCase()}\n#SBATCH --account=reyes-gpu\n#SBATCH --partition=${part}\n#SBATCH --qos=${qos}\n#SBATCH --nodes=${g > 4 ? 2 : 1}\n#SBATCH --gpus-per-node=${g > 4 ? g / 2 : g}\n#SBATCH --cpus-per-task=14\n#SBATCH --time=${String(Math.floor(w)).padStart(2, '0')}:00:00\n#SBATCH --signal=B:USR1@600\n#SBATCH --requeue\n\nmodule load ${cl === 'gautschi' ? 'cuda/12.6 anaconda' : 'cuda/12.1 anaconda'}\nconda activate vision\nsrun torchrun --nproc-per-node=${g > 4 ? g / 2 : g} train.py --config configs/${rr.name.replace(/\s+/g, '_').toLowerCase()}.yaml --ckpt-every 30m`;
      const deadlineH = rr.deadline ? (new Date(rr.deadline).getTime() - Date.now()) / H : 999;
      const mk = (rank: number, label: string, cl: string, part: string, gpu: string, g: number, thr: number, wait: number, factor: number, rationale: string, qos: string): RunPlan => {
        const dur = gh / (g * thr);
        const wall = Math.ceil(dur * 1.25);
        return { id: `${rr.id}-plan-${rank}`, rank, label, cluster: ref(cl), partition: ref(`${cl}-${part}`, part), gpuType: ref(gpu, gpu), gpus: g, nodes: g > 4 ? 2 : 1, walltimeHours: wall, estWaitHours: wait, estDurationHours: dur, estCostUnits: gh * factor / thr, estCostUsd: (gh * factor / thr) * clusters[cl].usd, meetsDeadline: wait + dur < deadlineH, score: 0.9 - rank * 0.1, rationale, sbatchScript: sb(part, qos, g, wall, cl) };
      };
      plans[rr.id] = [
        mk(1, 'Balanced', 'gilbreth', 'a100-80gb', 'A100-80GB', 4, 1.6, 0.4, 1, 'Uses the lab’s owned A100-80GB share, so nothing is charged against the Gautschi GPU-hour bank; finishes 6 days before the deadline with a 25% walltime buffer.', 'normal'),
        mk(2, 'Fastest', 'gautschi', 'ai', 'H100-80GB', 8, 3.1, 1.2, 2, 'Burst QOS on 8× H100 preempts only preemptible work and starts within ~1 h; costs 2 GPU-hours per GPU-hour.', 'burst'),
        mk(3, 'Cheapest', 'gautschi', 'ai', 'H100-80GB', 4, 3.1, 0.2, 0.25, 'Preemptible QOS is charged 0.25× and can run 30 days; checkpoints every 30 min with a USR1 handler so a preemption loses < 10 min.', 'preemptible'),
      ];
      rr.status = 'PLANNED';
      return plans[rr.id];
    }
    case 'RunPlan.fetch': return page(plans[filterVal(spec, 'runRequest.id') ?? ''] ?? [], spec);
    case 'RunRequest.submit': {
      const rr = runRequests[thisArg.id];
      const plan = plans[rr.id].find((p) => p.id === args[0]) as RunPlan;
      const id = `${plan.cluster?.id}-${8242100 + jobs.length}`;
      const job: Job = { id, slurmJobId: id.split('-').pop(), lab: { id: 'lab-vision' }, user: 'user_377', jobName: rr.name, state: 'PENDING', cluster: plan.cluster, partition: plan.partition, qos: plan.label === 'Cheapest' ? 'preemptible' : 'normal', allocGpus: plan.gpus, allocNodes: plan.nodes, gpuType: plan.gpuType, timelimitHours: plan.walltimeHours, elapsedHours: 0, costUsd: 0, submitTime: new Date().toISOString(), isLive: true, workloadType: rr.workloadType, nodeList: '(Priority)' };
      jobs.unshift(job);
      metrics[id] = [];
      actions.push({ id: `act-${Date.now()}`, lab: { id: 'lab-vision' }, job: { id, name: rr.name }, actionType: 'SUBMIT', actor: 'USER', actedAt: new Date().toISOString(), detail: `Submitted plan "${plan.label}" (${plan.gpus}× ${plan.gpuType?.id})`, outcome: 'DONE' });
      rr.status = 'SUBMITTED';
      return job;
    }
    default:
      throw new Error(`stub: no handler for ${key}`);
  }
}
