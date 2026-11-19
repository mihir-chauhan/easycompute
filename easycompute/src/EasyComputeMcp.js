/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('EasyComputeMcp');

/** Tool methods and their parameters, in declaration order (a stored tool whose schema differs is recreated). */
var MCP_TOOLS = {
  labSummary: ['labId'],
  planRun: ['labId', 'description', 'workloadType', 'gpus', 'gpuTypeId', 'walltimeHours', 'modelParamsB'],
  jobHealth: ['jobId'],
  liveJobs: ['labId'],
};

var WORKLOAD_TYPES = ['TRAINING', 'FINETUNE', 'INFERENCE', 'SIMULATION', 'DATA_PROCESSING', 'INTERACTIVE'];

// --------------------------------------------------------------------------------------------------------- helpers

/** C3 arrays, JS arrays and index-keyed objects (how Rhino serializes some Java lists) to a plain JS array. */
function arr(x) {
  var res = [];
  if (x === null || x === undefined) return res;
  if (x.length !== undefined) {
    for (var i = 0; i < x.length; i++) res.push(x[i]);
    return res;
  }
  if (typeof x === 'object') {
    Object.keys(x)
      .filter(function (k) {
        return /^\d+$/.test(k);
      })
      .sort(function (a, b) {
        return Number(a) - Number(b);
      })
      .forEach(function (k) {
        res.push(x[k]);
      });
  }
  return res;
}

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function round(v, d) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  var f = Math.pow(10, d === undefined ? 1 : d);
  return Math.round(v * f) / f;
}

function iso(v) {
  return v === null || v === undefined || v === '' ? null : String(v);
}

function ref(v) {
  return v && v.id ? String(v.id) : null;
}

/** Plain JSON data of a C3 value. */
function plain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  try {
    if (typeof v.toJson === 'function') return v.toJson();
  } catch (e) {
    // fall through
  }
  return JSON.parse(JSON.stringify(v));
}

function requireLab(labId) {
  var id = str(labId);
  if (!id) throw new Error('labId is required.');
  var found = Lab.fetch({ filter: Filter.eq('id', id), include: 'id, name', limit: 1 }).objs;
  if (!found || found.length === 0) {
    var ids = arr(Lab.fetch({ include: 'id', limit: 50 }).objs).map(function (l) {
      return l.id;
    });
    throw new Error('Unknown lab "' + id + '". Known labs: ' + ids.join(', '));
  }
  return found[0];
}

function metricRow(m) {
  if (!m) return null;
  return {
    ts: iso(m.ts),
    gpuUtilPct: round(num(m.gpuUtilPct), 1),
    gpuMemPct: round(num(m.gpuMemPct), 1),
    cpuUtilPct: round(num(m.cpuUtilPct), 1),
    memPct: round(num(m.memPct), 1),
    ioReadMBps: round(num(m.ioReadMBps), 1),
    ioWriteMBps: round(num(m.ioWriteMBps), 1),
    powerW: round(num(m.powerW), 0),
    checkpointAgeMin: round(num(m.checkpointAgeMin), 0),
    trainingLoss: round(num(m.trainingLoss), 4),
  };
}

function latestMetric(jobId) {
  var m = JobMetric.fetch({
    filter: Filter.eq('job.id', jobId),
    include: 'ts, gpuUtilPct, gpuMemPct, cpuUtilPct, memPct, ioReadMBps, ioWriteMBps, powerW, checkpointAgeMin, trainingLoss',
    order: 'descending(ts)',
    limit: 1,
  }).objs;
  return m && m.length ? m[0] : null;
}

function alertRow(a) {
  return {
    alertId: a.id,
    alertType: str(a.alertType),
    severity: str(a.severity),
    status: str(a.status),
    detectedAt: iso(a.detectedAt),
    message: str(a.message),
    recommendedAction: str(a.recommendedAction) || null,
    firedRule: str(a.firedRule) || null,
  };
}

var ALERT_INCLUDE = 'id, job.id, alertType, severity, status, detectedAt, message, recommendedAction, firedRule';

var JOB_INCLUDE =
  'id, slurmJobId, jobName, user, lab.id, project.id, cluster.id, partition.id, qos, state, workloadType, submitTime, ' +
  'startTime, endTime, allocGpus, allocNodes, gpuType.id, elapsedHours, timelimitHours, costUsd, gpuUtilAvg, isLive';

function jobRow(j) {
  var left = num(j.timelimitHours) !== null && num(j.elapsedHours) !== null ? round(num(j.timelimitHours) - num(j.elapsedHours), 1) : null;
  return {
    jobId: j.id,
    slurmJobId: str(j.slurmJobId) || null,
    name: str(j.jobName),
    user: str(j.user),
    labId: ref(j.lab),
    projectId: ref(j.project),
    cluster: ref(j.cluster),
    partition: ref(j.partition),
    qos: str(j.qos) || null,
    state: str(j.state),
    workloadType: str(j.workloadType) || null,
    isLive: j.isLive === true,
    gpus: num(j.allocGpus),
    nodes: num(j.allocNodes),
    gpuType: ref(j.gpuType),
    submitTime: iso(j.submitTime),
    startTime: iso(j.startTime),
    endTime: iso(j.endTime),
    elapsedHours: round(num(j.elapsedHours), 1),
    timelimitHours: num(j.timelimitHours),
    walltimeLeftHours: left,
    gpuUtilAvg: round(num(j.gpuUtilAvg), 1),
    costUsd: round(num(j.costUsd), 2),
  };
}

// ------------------------------------------------------------------------------------------------------------ tools

function labSummary(labId) {
  requireLab(labId);
  var d = Insights.labSummary(str(labId)) || {};
  var allocations = arr(d.allocations).map(function (a) {
    return {
      id: a.id,
      clusterId: a.clusterId,
      clusterName: a.clusterName,
      source: a.source,
      grantName: a.grantName,
      unitName: a.unitName,
      totalUnits: a.totalUnits,
      usedUnits: a.usedUnits,
      remainingUnits: a.remainingUnits,
      pctUsed: a.pctUsed,
      remainingUsd: a.remainingUsd,
      endDate: a.endDate || null,
    };
  });
  return {
    asOf: d.asOf || null,
    lab: d.lab ? { id: d.lab.id, name: d.lab.name, piName: d.lab.piName, department: d.lab.department, preferredClusters: d.lab.preferredClusters } : null,
    kpis: d.kpis || null,
    allocations: allocations,
    deadlines: arr(d.deadlines).slice(0, 5),
    usageByCluster: arr(d.usageByCluster),
    efficiency: d.efficiency || null,
    recommendations: arr(d.recommendations)
      .slice(0, 5)
      .map(function (r) {
        return { kind: r.kind, title: r.title, detail: r.detail, impact: r.impact };
      }),
  };
}

// c3-analysis-disable c3-excessive-method-params -- mirrors the flat MCP tool signature.
function planRun(labId, description, workloadType, gpus, gpuTypeId, walltimeHours, modelParamsB) {
  var lab = requireLab(labId);
  var desc = str(description);
  if (!desc) throw new Error('description is required.');
  var wt = str(workloadType).toUpperCase().replace(/[\s-]+/g, '_') || 'TRAINING';
  if (WORKLOAD_TYPES.indexOf(wt) < 0) throw new Error('Unknown workloadType "' + workloadType + '". Use one of: ' + WORKLOAD_TYPES.join(', '));
  var name = 'MCP: ' + (desc.length > 80 ? desc.substring(0, 77) + '...' : desc);
  var spec = {
    lab: { id: lab.id },
    name: name,
    description: desc,
    workloadType: wt,
    status: 'DRAFT',
    createdAt: DateTime.now(),
  };
  if (num(gpus) !== null && num(gpus) > 0) spec.requestedGpus = Math.round(num(gpus));
  if (str(gpuTypeId)) {
    var gt = GpuType.fetch({ filter: Filter.eq('id', str(gpuTypeId)), include: 'id', limit: 1 }).objs;
    if (!gt || gt.length === 0) throw new Error('Unknown gpuTypeId "' + gpuTypeId + '", e.g. H100-80GB or A100-40GB.');
    spec.requestedGpuType = { id: str(gpuTypeId) };
  }
  if (num(walltimeHours) !== null && num(walltimeHours) > 0) spec.requestedWalltimeHours = num(walltimeHours);
  if (num(modelParamsB) !== null) spec.modelParamsB = num(modelParamsB);

  var rrId = RunRequest.make(spec).create().id;
  RunRequest.forId(rrId).get().checkRules();
  var planError = null;
  try {
    RunRequest.forId(rrId).get().recommendPlans();
  } catch (e) {
    planError = String(e && e.message ? e.message : e);
    log.warn('recommendPlans failed for {}: {}', rrId, planError);
  }

  var order = { FAIL: 0, WARN: 1, PASS: 2 };
  var counts = { pass: 0, warn: 0, fail: 0 };
  var checks = arr(
    RuleCheck.fetch({
      filter: Filter.eq('runRequest.id', rrId),
      include: 'id, outcome, message, title, ruleKind, severity, scope, policy.id',
      limit: 500,
    }).objs
  );
  checks.forEach(function (c) {
    var o = str(c.outcome).toLowerCase();
    if (counts[o] !== undefined) counts[o]++;
  });
  var items = checks
    .sort(function (a, b) {
      return (order[str(a.outcome)] === undefined ? 3 : order[str(a.outcome)]) - (order[str(b.outcome)] === undefined ? 3 : order[str(b.outcome)]);
    })
    .map(function (c) {
      return {
        outcome: str(c.outcome),
        ruleId: ref(c.policy) || 'builtin:' + str(c.ruleKind),
        rule: str(c.title),
        kind: str(c.ruleKind),
        severity: str(c.severity) || null,
        scope: str(c.scope) || null,
        message: str(c.message),
      };
    });

  var plans = arr(
    RunPlan.fetch({
      filter: Filter.eq('runRequest.id', rrId),
      include:
        'id, rank, label, cluster.id, partition.id, gpuType.id, gpus, nodes, walltimeHours, estDurationHours, ' +
        'estCostUnits, estCostUsd, meetsDeadline, score, rationale, finishBy, deadlineSlackHours, qos, account, slurmPartition, ' +
        'chainedJobs, preemptionRisk, sbatchScript',
      order: 'ascending(rank)',
      limit: 3,
    }).objs
  ).map(function (p) {
    return {
      planId: p.id,
      rank: num(p.rank),
      label: str(p.label),
      cluster: ref(p.cluster),
      partition: ref(p.partition),
      slurmPartition: str(p.slurmPartition) || null,
      qos: str(p.qos) || null,
      account: str(p.account) || null,
      gpuType: ref(p.gpuType),
      gpus: num(p.gpus),
      nodes: num(p.nodes),
      walltimeHours: num(p.walltimeHours),
      chainedJobs: num(p.chainedJobs),
      estDurationHours: round(num(p.estDurationHours), 1),
      finishBy: iso(p.finishBy),
      estCostUnits: round(num(p.estCostUnits), 1),
      estCostUsd: round(num(p.estCostUsd), 2),
      meetsDeadline: p.meetsDeadline === true,
      deadlineSlackHours: round(num(p.deadlineSlackHours), 1),
      preemptionRisk: round(num(p.preemptionRisk), 2),
      score: round(num(p.score), 3),
      rationale: str(p.rationale),
      sbatchScript: str(p.sbatchScript),
    };
  });

  var rr = RunRequest.fetch({ filter: Filter.eq('id', rrId), include: 'id, name, status, approvalStatus, approvalReason', limit: 1 }).objs[0];
  return {
    runRequestId: rrId,
    name: str(rr.name),
    labId: lab.id,
    workloadType: wt,
    status: str(rr.status),
    approvalStatus: str(rr.approvalStatus) || null,
    approvalReason: str(rr.approvalReason) || null,
    checks: { pass: counts.pass, warn: counts.warn, fail: counts.fail, items: items },
    plans: plans,
    planError: planError,
    note: 'DRAFT only; nothing was submitted. Launch it from the EasyCompute Launch planner (/plan?runRequest=' + rrId + ').',
  };
}
// c3-analysis-enable c3-excessive-method-params

function jobHealth(jobId) {
  var id = str(jobId);
  if (!id) throw new Error('jobId is required (see liveJobs).');
  var found = Job.fetch({ filter: Filter.eq('id', id), include: JOB_INCLUDE, limit: 1 }).objs;
  if (!found || found.length === 0) throw new Error('No job with id "' + id + '". Use liveJobs to list job ids.');
  var job = jobRow(found[0]);

  var alerts = arr(
    JobAlert.fetch({
      filter: Filter.eq('job.id', id).and().eq('status', 'OPEN'),
      include: ALERT_INCLUDE,
      order: 'descending(detectedAt)',
      limit: 50,
    }).objs
  ).map(alertRow);

  var pred = JobPrediction.fetch({
    filter: Filter.eq('job.id', id),
    include: 'id, predictedHours, timelimitHours, walltimeRisk, modelId, scoredAt',
    order: 'descending(scoredAt)',
    limit: 1,
  }).objs;
  var prediction =
    pred && pred.length
      ? {
          id: pred[0].id,
          predictedHours: round(num(pred[0].predictedHours), 2),
          timelimitHours: num(pred[0].timelimitHours),
          walltimeRisk: pred[0].walltimeRisk === true,
          modelId: str(pred[0].modelId) || null,
          scoredAt: iso(pred[0].scoredAt),
        }
      : null;

  var tri = GuardrailTriage.fetch({
    filter: Filter.eq('job.id', id),
    include: 'id, alert.id, severity, rootCause, recommendedAction, rationale, actionLogEntry.id, workflowExecutionId, triagedAt',
    order: 'descending(triagedAt)',
    limit: 1,
  }).objs;
  var triage =
    tri && tri.length
      ? {
          id: tri[0].id,
          alertId: ref(tri[0].alert),
          severity: str(tri[0].severity) || null,
          rootCause: str(tri[0].rootCause),
          recommendedAction: str(tri[0].recommendedAction) || null,
          rationale: str(tri[0].rationale),
          actionLogEntryId: ref(tri[0].actionLogEntry),
          workflowExecutionId: str(tri[0].workflowExecutionId) || null,
          triagedAt: iso(tri[0].triagedAt),
        }
      : null;

  return {
    job: job,
    latestMetric: metricRow(latestMetric(id)),
    openAlerts: alerts,
    prediction: prediction,
    triage: triage,
  };
}

function liveJobs(labId) {
  var lab = requireLab(labId);
  var jobs = arr(
    Job.fetch({
      filter: Filter.eq('isLive', true).and().eq('lab.id', lab.id),
      include: JOB_INCLUDE,
      order: 'descending(submitTime)',
      limit: 100,
    }).objs
  );
  var openByJob = {};
  arr(
    JobAlert.fetch({
      filter: Filter.eq('lab.id', lab.id).and().eq('status', 'OPEN').and().eq('job.isLive', true),
      include: 'id, job.id',
      limit: 500,
    }).objs
  ).forEach(function (a) {
    var jid = ref(a.job);
    openByJob[jid] = (openByJob[jid] || 0) + 1;
  });
  var rows = jobs.map(function (j) {
    var r = jobRow(j);
    var m = latestMetric(j.id);
    r.latestGpuUtilPct = m ? round(num(m.gpuUtilPct), 1) : null;
    r.latestGpuMemPct = m ? round(num(m.gpuMemPct), 1) : null;
    r.checkpointAgeMin = m ? round(num(m.checkpointAgeMin), 0) : null;
    r.latestMetricAt = m ? iso(m.ts) : null;
    r.openAlerts = openByJob[j.id] || 0;
    return r;
  });
  return {
    labId: lab.id,
    count: rows.length,
    withOpenAlerts: rows.filter(function (r) {
      return r.openAlerts > 0;
    }).length,
    jobs: rows,
  };
}

// --------------------------------------------------------------------------------------------------- registration

var PROMPTS = [
  {
    id: 'easycompute-lab-briefing',
    name: 'easycompute-lab-briefing',
    displayName: 'EasyCompute lab briefing',
    description: 'Briefing on one research lab: allocations left, next deadlines, live jobs with issues and what to do next.',
    descriptionForLlm:
      'Use when the user wants a status briefing of an EasyCompute research lab (budget, deadlines, live runs, problems).',
    arguments: [{ name: 'labId', description: 'EasyCompute lab id, e.g. lab-nlp', required: true }],
    content:
      'You are briefing a Purdue research lab on its GPU compute. Lab id: {labId}.\n\n' +
      '1. Call the EasyCompute labSummary tool with labId "{labId}". Report each allocation (cluster, remaining units and ' +
      'remaining dollars, percent used), the next project deadlines with days left, and the 30-day spend.\n' +
      '2. Call liveJobs with labId "{labId}". List the running and pending jobs; for every job with open alerts call jobHealth ' +
      'and explain the alert, the latest GPU utilization and checkpoint age, any walltime-risk prediction and the triage ' +
      'recommendation.\n' +
      '3. Finish with at most three concrete next steps (for example: cancel or scale down an idle job, move work to a ' +
      'cheaper partition, plan the deadline run now). Use only numbers returned by the tools; say when data is missing.',
  },
  {
    id: 'easycompute-plan-run',
    name: 'easycompute-plan-run',
    displayName: 'EasyCompute plan a run',
    description: 'Plans a GPU run for a lab against cluster, partition and lab rules and recommends the best launch plan.',
    descriptionForLlm:
      'Use when the user wants to know where and how to run a job on Purdue clusters, what it costs or whether rules allow it.',
    arguments: [
      { name: 'labId', description: 'EasyCompute lab id, e.g. lab-nlp', required: true },
      { name: 'description', description: 'What the run does, e.g. "4-GPU LoRA fine-tune of a 7B model for 12 hours"', required: true },
    ],
    content:
      'Plan this run for EasyCompute lab {labId}: "{description}".\n\n' +
      '1. Infer workloadType (TRAINING, FINETUNE, INFERENCE, SIMULATION, DATA_PROCESSING or INTERACTIVE), GPU count, GPU type, ' +
      'walltime hours and model size in billions of parameters from the description; leave out what is not stated.\n' +
      '2. Call the EasyCompute planRun tool with labId "{labId}", the description and those values. It only creates a DRAFT ' +
      'request and never submits anything.\n' +
      '3. Explain every FAIL and WARN rule check (rule id and message), then compare the Fastest, Cheapest and Balanced plans ' +
      '(cluster, partition, GPUs, walltime, duration, cost, deadline fit) and recommend one with a one-sentence reason.\n' +
      '4. Show the sbatch script of the recommended plan in a code block and remind the user to launch it from the ' +
      'EasyCompute Launch planner.',
  },
];

function schemaMatches(tool, method) {
  try {
    var schema = plain(tool.argsSchema) || {};
    var props = Object.keys(schema.properties || {}).sort();
    return JSON.stringify(props) === JSON.stringify(MCP_TOOLS[method].slice().sort());
  } catch (e) {
    return false;
  }
}

function ensureTool(method) {
  var existing = arr(
    GenaiCore.Tool.C3Method.fetch({
      filter: Filter.startsWith('id', 'EasyComputeMcp_' + method + '_').and().eq('name', method),
      include: 'id, name, argsSchema, enabledInMcpServer',
      order: 'descending(meta.created)',
      limit: 1,
    }).objs
  );
  var created = false;
  var tool;
  if (existing.length && schemaMatches(existing[0], method)) {
    tool = existing[0];
  } else {
    tool = GenaiCore.Tool.C3Method.createFromMethodName(EasyComputeMcp, method);
    created = true;
  }
  if (tool.enabledInMcpServer !== true) {
    GenaiCore.Tool.C3Method.forId(tool.id).get().withEnabledInMcpServer(true).merge();
  }
  var check = GenaiCore.Tool.C3Method.fetch({ filter: Filter.eq('id', tool.id), include: 'id, name, enabledInMcpServer', limit: 1 }).objs[0];
  return { id: check.id, name: str(check.name), enabledInMcpServer: check.enabledInMcpServer === true, created: created };
}

function ensurePrompt(p) {
  var obj = {
    id: p.id,
    name: p.name,
    displayName: p.displayName,
    description: p.description,
    descriptionForLlm: p.descriptionForLlm,
    content: p.content,
    arguments: p.arguments,
    enabledInMcpServer: true,
  };
  Mcp.Prompt.make(obj).upsert();
  var check = Mcp.Prompt.fetch({ filter: Filter.eq('id', p.id), include: 'id, name, enabledInMcpServer', limit: 1 }).objs[0];
  return { id: check.id, name: str(check.name), enabledInMcpServer: check.enabledInMcpServer === true };
}

function ensureMcpTools() {
  var toolRows = Object.keys(MCP_TOOLS).map(ensureTool);
  var promptRows = PROMPTS.map(ensurePrompt);
  return { tools: toolRows, prompts: promptRows };
}
