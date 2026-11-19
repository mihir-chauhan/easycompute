/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('RunRequest');

var HOUR_MS = 3600 * 1000;
/** Workloads that checkpoint, so a run longer than the walltime limit can be split into chained jobs. */
var CHECKPOINTABLE = ['TRAINING', 'FINETUNE', 'SIMULATION'];
var SEVERITY_ORDER = { FAIL: 0, WARN: 1, PASS: 2 };

// ---------------------------------------------------------------- small helpers

function ms(v) {
  return v == null ? null : Date.parse(String(v));
}

function toDt(millis) {
  return DateTime.fromString(new Date(millis).toISOString());
}

function round(v, digits) {
  var f = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(Number(v || 0) * f) / f;
}

function num(v, dflt) {
  return v == null || isNaN(Number(v)) ? dflt : Number(v);
}

function list(arr) {
  var out = [];
  if (arr == null) return out;
  for (var i = 0; i < arr.length; i++) out.push(arr[i]);
  return out;
}

function cellValue(tuple, idx) {
  var c = tuple.cells[idx];
  return c == null ? null : c.value();
}

function fmtHours(h) {
  if (h == null) return 'n/a';
  if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min';
  if (h < 48) return round(h, 1) + ' h';
  return round(h / 24, 1) + ' days';
}

function waitBucket(h) {
  if (h < 0.25) return '<15 min';
  if (h < 2) return '15 min-2 h';
  if (h < 12) return '2-12 h';
  return '>12 h';
}

function slug(s) {
  var out = String(s || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out.substring(0, 40) || 'run';
}

function slurmTime(hours) {
  var totalMin = Math.max(1, Math.round(hours * 60));
  var d = Math.floor(totalMin / 1440);
  var h = Math.floor((totalMin % 1440) / 60);
  var m = totalMin % 60;
  function p(n) {
    return n < 10 ? '0' + n : String(n);
  }
  return (d > 0 ? d + '-' : '') + p(h) + ':' + p(m) + ':00';
}

/** US Eastern hour (Purdue West Lafayette), with the US daylight-saving rule. */
function easternHour(millis) {
  var d = new Date(millis);
  var y = d.getUTCFullYear();
  function nthSunday(month, n) {
    var first = new Date(Date.UTC(y, month, 1));
    var day = 1 + ((7 - first.getUTCDay()) % 7) + (n - 1) * 7;
    return Date.UTC(y, month, day, 7);
  }
  var dst = millis >= nthSunday(2, 2) && millis < nthSunday(10, 1);
  return (d.getUTCHours() + (dst ? -4 : -5) + 24) % 24;
}

function inHourRange(hour, text) {
  var m = String(text || '').match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (!m) return false;
  var a = Number(m[1]);
  var b = Number(m[2]);
  return a <= b ? hour >= a && hour < b : hour >= a || hour < b;
}

function csv(text) {
  return String(text || '')
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.length > 0;
    });
}

// ---------------------------------------------------------------- context loading

/** Everything the rule engine and planner read for one request, loaded with a handful of bounded reads. */
function loadContext(id) {
  var req = RunRequest.make({ id: id }).get(
    'this, lab.this, project.this, submittedBy.this, requestedCluster.this, requestedPartition.this, requestedGpuType.this'
  );
  if (req == null) throw new Error('RunRequest ' + id + ' not found');
  var now = Date.now();
  var labId = req.lab.id;

  var gpuTypes = {};
  list(GpuType.fetch({ limit: 200 }).objs).forEach(function (g) {
    gpuTypes[g.id] = g;
  });
  var clusters = {};
  list(ComputeCluster.fetch({ limit: 200 }).objs).forEach(function (c) {
    clusters[c.id] = c;
  });
  var partitions = list(Partition.fetch({ limit: 500 }).objs);

  var allocations = {};
  list(Allocation.fetch({ filter: Filter.eq('lab.id', labId), limit: 200 }).objs).forEach(function (a) {
    var end = ms(a.endDate);
    if (end != null && end < now) return;
    var cid = a.cluster.id;
    var cur = allocations[cid] || { totalUnits: 0, usedUnits: 0, endMs: null, grantNames: [], unitName: a.unitName };
    cur.totalUnits += num(a.totalUnits, 0);
    cur.usedUnits += num(a.usedUnits, 0);
    cur.endMs = cur.endMs == null || (end != null && end < cur.endMs) ? end : cur.endMs;
    if (a.grantName) cur.grantNames.push(String(a.grantName));
    allocations[cid] = cur;
  });

  var policies = list(Policy.fetch({ filter: Filter.eq('active', true), limit: 1000 }).objs).filter(function (p) {
    return p.scope != 'LAB' || (p.lab != null && p.lab.id == labId);
  });

  // the lab's running + pending jobs per partition (MAX_JOBS_PER_USER)
  var liveByPartition = {};
  Job.fetchObjStream({
    filter: Filter.eq('lab.id', labId).and().intersects('state', ['RUNNING', 'PENDING']),
    include: 'partition',
  }).each(function (j) {
    if (j.partition == null) return;
    liveByPartition[j.partition.id] = (liveByPartition[j.partition.id] || 0) + 1;
  });

  var deadlineMs = ms(req.deadline);
  var deadlineLabel = deadlineMs != null ? 'the requested deadline' : null;
  if (deadlineMs == null && req.project != null && req.project.deadline != null) {
    deadlineMs = ms(req.project.deadline);
    deadlineLabel = req.project.deadlineLabel || 'the ' + req.project.name + ' deadline';
  }

  var labUtil = null;
  var utilRes = Job.evaluate({
    projection: 'avg(gpuUtilAvg), count()',
    filter: Filter.eq('lab.id', labId).and('exists(gpuUtilAvg) && allocGpus > 0'),
  });
  if (utilRes.tuples && utilRes.tuples.length) {
    var n = cellValue(utilRes.tuples[0], 1);
    if (n != null && Number(n) >= 3) labUtil = num(cellValue(utilRes.tuples[0], 0), null);
  }

  var gpuTypeForPrediction = req.requestedGpuType != null ? req.requestedGpuType.id : 'A100-40GB';
  var wantsCpu = req.requestedGpus === 0 || (req.requestedGpus == null && req.requestedGpuType == null && req.workloadType == 'DATA_PROCESSING');
  var prediction = Insights.predictDuration(
    String(req.workloadType || 'TRAINING'),
    wantsCpu ? 'CPU' : gpuTypeForPrediction,
    1,
    num(req.modelParamsB, 0),
    labId
  );
  var memNeedGb = num(prediction.memoryNeedGb, 0);
  if (/q?lora/i.test(String(req.description || '') + ' ' + String(req.name || '')) && req.workloadType == 'FINETUNE') {
    memNeedGb = round(num(req.modelParamsB, 0) * 2.6, 1);
  }

  // work in A100-40GB GPU-hours (or core-hours for CPU work); blend the user's own estimate when given
  var work = num(prediction.a100HoursP50, 1);
  var workP90 = num(prediction.a100HoursP90, work * 1.6);
  var workBasis = prediction.explanation;
  if (!wantsCpu && num(req.estGpuHours, 0) > 0) {
    var ratio = workP90 / Math.max(work, 0.01);
    work = 0.5 * work + 0.5 * Number(req.estGpuHours);
    workP90 = work * ratio;
    workBasis += ' Blended 50/50 with your estimate of ' + round(req.estGpuHours, 1) + ' GPU-hours.';
  }

  return {
    req: req,
    lab: req.lab,
    labId: labId,
    now: now,
    gpuTypes: gpuTypes,
    clusters: clusters,
    partitions: partitions,
    allocations: allocations,
    policies: policies,
    liveByPartition: liveByPartition,
    deadlineMs: deadlineMs,
    deadlineLabel: deadlineLabel,
    labUtil: labUtil,
    wantsCpu: wantsCpu,
    prediction: prediction,
    memNeedGb: memNeedGb,
    work: work,
    workP90: workP90,
    workBasis: workBasis,
    fairShare: {},
  };
}

/** Lab share of GPU-hours on a cluster (cached per cluster), for FAIRSHARE_CAP. */
function labShareOnCluster(ctx, clusterId) {
  if (ctx.fairShare[clusterId] !== undefined) return ctx.fairShare[clusterId];
  var res = Job.evaluate({
    projection: 'lab.id, sum(gpuHours)',
    group: 'lab.id',
    filter: Filter.eq('cluster.id', clusterId),
    limit: -1,
  });
  var total = 0;
  var mine = 0;
  list(res.tuples).forEach(function (t) {
    var v = num(cellValue(t, 1), 0);
    total += v;
    if (cellValue(t, 0) == ctx.labId) mine += v;
  });
  ctx.fairShare[clusterId] = total > 0 ? mine / total : null;
  return ctx.fairShare[clusterId];
}

// ---------------------------------------------------------------- candidate modeling

function partitionQos(p) {
  if (p.qos) return String(p.qos);
  var n = String(p.name || p.id).toLowerCase();
  if (n.indexOf('burst') >= 0) return 'burst';
  if (n.indexOf('standby') >= 0) return 'standby';
  if (n.indexOf('preempt') >= 0 || p.preemptible) return 'preemptible';
  if (n.indexOf('training') >= 0) return 'training';
  return 'normal';
}

function slurmPartitionName(p) {
  if (p.slurmPartition) return String(p.slurmPartition);
  var n = String(p.name || '');
  if (n && !/\s/.test(n)) return n.toLowerCase();
  var id = String(p.id);
  var cid = p.cluster ? String(p.cluster.id) : '';
  return cid && id.indexOf(cid + '-') === 0 ? id.substring(cid.length + 1) : id;
}

function chooseAccount(ctx, cluster, isGpu) {
  var accounts = csv(ctx.lab.slurmAccounts);
  var alloc = ctx.allocations[cluster.id];
  var grants = alloc ? alloc.grantNames.join(' ').toLowerCase() : '';
  var pick = accounts.filter(function (a) {
    return grants.indexOf(a.toLowerCase()) >= 0;
  })[0];
  pick = pick || accounts.filter(function (a) {
    return a.toLowerCase().indexOf(String(cluster.id)) >= 0;
  })[0];
  if (!pick && isGpu) {
    pick = accounts.filter(function (a) {
      return /gpu/i.test(a);
    })[0];
  }
  return pick || accounts[0] || String(ctx.labId);
}

/** Effective USD and allocation units per resource-hour (GPU-hour, or core-hour for CPU partitions). */
function unitRates(cluster, p, gpuType) {
  var factor = num(p.chargeFactor, 1);
  var unitsPerHour = factor;
  if (String(cluster.unitName) == 'USD') unitsPerHour = factor * num(gpuType ? gpuType.costPerGpuHourUsd : 0.05, 1);
  return { unitsPerHour: unitsPerHour, usdPerHour: unitsPerHour * num(cluster.usdPerUnit, 1) };
}

function scalingEfficiency(gpus, nodes) {
  var e = Math.pow(0.9, Math.log(Math.max(1, gpus)) / Math.LN2);
  return nodes > 1 ? e * 0.9 : e;
}

/**
 * Models one (partition, GPU count) option: duration, walltime (chained when needed), wait, cost, deadline, risk.
 * Returns null when the option is physically impossible (memory, walltime without checkpointing).
 */
function modelCandidate(ctx, p, gpus) {
  var req = ctx.req;
  var cluster = ctx.clusters[p.cluster.id];
  if (cluster == null) return null;
  var gpuType = p.gpuType ? ctx.gpuTypes[p.gpuType.id] : null;
  var isGpu = gpuType != null;
  var gpusPerNode = Math.max(1, num(p.gpusPerNode, 1));
  var coresPerNode = Math.max(1, num(p.coresPerNode, 64));
  var nodes = isGpu ? Math.ceil(gpus / gpusPerNode) : Math.max(1, gpus);
  var rel = isGpu ? num(gpuType.relativeThroughput, 1) : 1;
  var eff = scalingEfficiency(isGpu ? gpus : nodes, nodes);
  var capacity = isGpu ? gpus * rel * eff : nodes * coresPerNode * eff;
  var duration = ctx.work / capacity;
  var durationP90 = ctx.workP90 / capacity;
  if (req.workloadType == 'INTERACTIVE') {
    duration = Math.max(1, num(req.requestedWalltimeHours, 4));
    durationP90 = duration;
  }
  var needed = Math.max(0.5, Math.ceil(durationP90 * 1.2 * 4) / 4);
  var maxWall = num(p.maxWalltimeHours, 336);
  var walltime = req.requestedWalltimeHours ? Number(req.requestedWalltimeHours) : Math.min(needed, maxWall);
  var chained = 1;
  if (!req.requestedWalltimeHours && needed > maxWall) {
    if (CHECKPOINTABLE.indexOf(String(req.workloadType)) < 0) return null;
    chained = Math.ceil(needed / maxWall);
    walltime = maxWall;
  }
  var memFit = !isGpu || ctx.memNeedGb <= 0 || ctx.memNeedGb <= gpus * num(gpuType.memoryGb, 40) * 0.9;

  var util = num(p.utilizationPct, 50);
  var base = num(p.avgWaitHours, 0.5);
  var pressure = 1 + Math.max(0, (util - 80) / 20);
  var wait = base * pressure * (1 + 0.25 * (Math.log(Math.max(1, gpus)) / Math.LN2)) * (nodes > 1 ? 1.3 : 1);
  if (chained > 1) wait = wait * 1.5;
  var waitReason =
    (p.name || p.id) + ' is ' + Math.round(util) + '% busy with ' + num(p.currentQueueDepth, 0) + ' jobs queued (typical wait ' +
    fmtHours(base) + ')' + (gpus > 1 ? '; ' + gpus + (isGpu ? ' GPUs' : ' nodes') + (nodes > 1 && isGpu ? ' across ' + nodes + ' nodes' : '') + ' take longer to schedule' : '') + '.';

  var rates = unitRates(cluster, p, gpuType);
  var resourceHours = isGpu ? gpus * duration : nodes * coresPerNode * duration;
  var costUnits = resourceHours * rates.unitsPerHour;
  var costUsd = resourceHours * rates.usdPerHour;
  var finishHours = wait + duration * 1.2;
  var slack = ctx.deadlineMs != null ? (ctx.deadlineMs - ctx.now) / HOUR_MS - finishHours : null;
  var preemptionRisk = p.preemptible ? 1 - Math.exp(-duration * 0.02 * Math.max(0.5, util / 80)) : 0.01;

  return {
    p: p,
    cluster: cluster,
    gpuType: gpuType,
    isGpu: isGpu,
    gpus: isGpu ? gpus : 0,
    nodes: nodes,
    duration: duration,
    walltime: walltime,
    chained: chained,
    wait: wait,
    waitReason: waitReason,
    costUnits: costUnits,
    costUsd: costUsd,
    usdPerGpuHour: isGpu ? rates.usdPerHour : null,
    finishHours: finishHours,
    slack: slack,
    meetsDeadline: slack == null || slack >= 0,
    memFit: memFit,
    preemptionRisk: preemptionRisk,
    efficiency: eff,
  };
}

/** GPU counts worth considering on a partition. */
function gpuOptions(ctx, p) {
  var req = ctx.req;
  var gpuType = p.gpuType ? ctx.gpuTypes[p.gpuType.id] : null;
  if (gpuType == null) return [1, 2, 4]; // CPU: node counts
  var perGpu = num(gpuType.memoryGb, 40) * 0.9;
  var minGpus = ctx.memNeedGb > 0 ? Math.max(1, Math.ceil(ctx.memNeedGb / perGpu)) : 1;
  var cap = Math.min(num(p.maxGpusPerJob, 64) || 64, num(p.gpusPerNode, 1) * (num(p.maxNodesPerJob, 1) || 1), 64);
  if (req.requestedGpus > 0) return [Number(req.requestedGpus)];
  var out = [];
  [minGpus, minGpus * 2, minGpus * 4].forEach(function (g) {
    if (g <= cap && out.indexOf(g) < 0) out.push(g);
  });
  if (!out.length && minGpus > cap) out.push(minGpus); // shown as a memory-fit failure
  return out;
}

/** Partitions considered for the request: online/degraded, GPU or CPU as the workload needs. */
function candidatePartitions(ctx, restrictToRequest) {
  var req = ctx.req;
  return ctx.partitions.filter(function (p) {
    var isGpu = p.gpuType != null;
    if (ctx.wantsCpu ? isGpu : !isGpu) return false;
    if (req.requestedGpuType != null && isGpu && p.gpuType.id != req.requestedGpuType.id && restrictToRequest) return false;
    if (restrictToRequest && req.requestedPartition != null) return p.id == req.requestedPartition.id;
    if (restrictToRequest && req.requestedCluster != null) return p.cluster.id == req.requestedCluster.id;
    return true;
  });
}

// ---------------------------------------------------------------- rule engine

function policyApplies(pol, cand) {
  if (pol.scope == 'UNIVERSITY') return true;
  if (pol.scope == 'CLUSTER') return pol.cluster != null && pol.cluster.id == cand.cluster.id;
  if (pol.scope == 'PARTITION') return pol.partition != null && pol.partition.id == cand.p.id;
  if (pol.scope == 'LAB') {
    if (pol.cluster != null && pol.cluster.id != cand.cluster.id) return false;
    if (pol.partition != null && pol.partition.id != cand.p.id) return false;
    return true;
  }
  return false;
}

/** Evaluates one policy for one candidate: { ok: boolean, msg: string } (ok=true means compliant). */
function evalPolicy(ctx, pol, c) {
  var req = ctx.req;
  var kind = String(pol.kind);
  var lv = pol.limitValue == null ? null : Number(pol.limitValue);
  var where = (c.cluster.name || c.cluster.id) + ' / ' + (c.p.name || c.p.id);
  var wt = String(req.workloadType || '');
  var lim;
  switch (kind) {
    case 'MAX_WALLTIME':
      lim = lv != null ? lv : num(c.p.maxWalltimeHours, 1e9);
      return c.walltime <= lim + 1e-9
        ? { ok: true, msg: 'Walltime ' + fmtHours(c.walltime) + (c.chained > 1 ? ' per job (' + c.chained + ' chained jobs)' : '') + ' is within the ' + fmtHours(lim) + ' limit on ' + where + '.' }
        : { ok: false, msg: 'Walltime ' + fmtHours(c.walltime) + ' exceeds the ' + fmtHours(lim) + ' limit on ' + where + '. Split into checkpointed chained jobs or use a partition with a longer limit.' };
    case 'MAX_GPUS_PER_JOB':
      if (!c.isGpu) return { ok: true, msg: 'CPU-only option.' };
      lim = lv != null ? lv : num(c.p.maxGpusPerJob, 1e9);
      return c.gpus <= lim
        ? { ok: true, msg: c.gpus + ' GPUs is within the ' + lim + '-GPU per-job limit on ' + where + '.' }
        : { ok: false, msg: c.gpus + ' GPUs exceeds the ' + lim + '-GPU per-job limit on ' + where + '.' };
    case 'MAX_NODES_PER_JOB':
      lim = lv != null ? lv : num(c.p.maxNodesPerJob, 1e9);
      return c.nodes <= lim
        ? { ok: true, msg: c.nodes + ' node(s) is within the ' + lim + '-node limit on ' + where + '.' }
        : { ok: false, msg: c.nodes + ' nodes exceeds the ' + lim + '-node per-job limit on ' + where + '.' };
    case 'MAX_JOBS_PER_USER':
      lim = lv != null ? lv : num(c.p.maxJobsPerUser, 1e9);
      var live = ctx.liveByPartition[c.p.id] || 0;
      return live + c.chained <= lim
        ? { ok: true, msg: 'The lab has ' + live + ' running/pending job(s) on ' + where + '; limit ' + lim + '.' }
        : { ok: false, msg: 'The lab already has ' + live + ' running/pending job(s) on ' + where + '; adding ' + c.chained + ' exceeds the limit of ' + lim + '.' };
    case 'ALLOWED_GPU_TYPES':
      if (!c.isGpu) return { ok: true, msg: 'CPU-only option.' };
      var allowed = csv(pol.limitText);
      return !allowed.length || allowed.indexOf(String(c.gpuType.id)) >= 0
        ? { ok: true, msg: c.gpuType.id + ' is an allowed GPU type.' }
        : { ok: false, msg: c.gpuType.id + ' is not allowed (allowed: ' + allowed.join(', ') + ').' };
    case 'BUDGET_REMAINING':
      return budgetCheck(ctx, c, lv);
    case 'DEADLINE_FEASIBLE':
      return deadlineCheck(ctx, c);
    case 'FAIRSHARE_CAP':
      if (!c.isGpu) return { ok: true, msg: 'Fair share is tracked on GPU usage only.' };
      var share = labShareOnCluster(ctx, c.cluster.id);
      var target = num(ctx.lab.fairShareTarget, 0);
      var cap = target * (lv != null ? lv : 1.5);
      if (share == null || target <= 0) return { ok: true, msg: 'No GPU usage recorded on ' + c.cluster.name + ' yet.' };
      return share <= cap
        ? { ok: true, msg: 'Lab uses ' + round(share * 100, 1) + '% of ' + c.cluster.name + ' GPU-hours (cap ' + round(cap * 100, 1) + '% = ' + round(lv != null ? lv : 1.5, 2) + ' x ' + round(target * 100, 1) + '% target).' }
        : { ok: false, msg: 'Lab already uses ' + round(share * 100, 1) + '% of ' + c.cluster.name + ' GPU-hours, above its fair-share cap of ' + round(cap * 100, 1) + '%. Expect lower priority, or use another cluster.' };
    case 'PREEMPTIBLE_ONLY':
      var kinds = csv(pol.limitText).map(function (s) {
        return s.toUpperCase();
      });
      if (kinds.length && kinds.indexOf(wt) < 0) return { ok: true, msg: 'Applies only to ' + kinds.join(', ') + ' work.' };
      return c.p.preemptible
        ? { ok: true, msg: where + ' is preemptible.' }
        : { ok: false, msg: where + ' is not preemptible; this rule requires standby/preemptible capacity.' };
    case 'DATA_RESIDENCY':
      var ok = csv(pol.limitText);
      var resident = ok.length ? ok.indexOf(String(c.cluster.id)) >= 0 : c.cluster.billing != 'THIRD_PARTY_HOURLY';
      return resident
        ? { ok: true, msg: 'Data stays on ' + c.cluster.name + ', an approved location.' }
        : { ok: false, msg: 'Data may not leave approved clusters' + (ok.length ? ' (' + ok.join(', ') + ')' : ' (no third-party cloud)') + '; ' + c.cluster.name + ' is not one of them.' };
    case 'EXPORT_CONTROL':
      var flagged = pol.scope == 'LAB' || /\b(ITAR|EAR|CUI|export[- ]control)/i.test(String(ctx.lab.contextDump || '') + ' ' + String(ctx.lab.notes || '') + ' ' + String(req.description || ''));
      if (!flagged) return { ok: true, msg: 'No export-controlled data declared for this lab or run.' };
      return c.cluster.billing == 'IN_HOUSE_NODE_SHARE'
        ? { ok: true, msg: c.cluster.name + ' is Purdue-operated, as export-controlled work requires.' }
        : { ok: false, msg: 'Export-controlled (ITAR/EAR/CUI) work must stay on Purdue-operated clusters; ' + c.cluster.name + ' is ' + (c.cluster.operator || 'external') + '.' };
    case 'MIN_GPU_UTIL':
      lim = lv != null ? lv : 30;
      if (ctx.labUtil == null) return { ok: true, msg: 'Not enough GPU history to judge utilization.' };
      return ctx.labUtil >= lim
        ? { ok: true, msg: 'Recent lab GPU utilization ' + round(ctx.labUtil, 0) + '% meets the ' + lim + '% minimum.' }
        : { ok: false, msg: 'Recent lab GPU jobs averaged only ' + round(ctx.labUtil, 0) + '% GPU utilization (minimum ' + lim + '%). Consider fewer or smaller GPUs and profiling the data loader.' };
    case 'QUIET_HOURS':
      var hour = easternHour(ctx.now);
      return !inHourRange(hour, pol.limitText)
        ? { ok: true, msg: 'Submission time is outside the quiet hours (' + pol.limitText + ' Eastern).' }
        : { ok: false, msg: 'It is ' + hour + ':00 Eastern, inside the quiet hours (' + pol.limitText + '); submit later or hold the job until then.' };
    default:
      return { ok: true, msg: 'Not checkable automatically.' };
  }
}

function budgetCheck(ctx, c, shareLimit) {
  var alloc = ctx.allocations[c.cluster.id];
  if (alloc == null) return { ok: false, msg: 'The lab has no active allocation on ' + c.cluster.name + '.' };
  var remaining = alloc.totalUnits - alloc.usedUnits;
  var allowed = shareLimit != null && shareLimit > 0 && shareLimit <= 1 ? remaining * shareLimit : remaining;
  var unit = alloc.unitName || c.cluster.unitName || 'units';
  return c.costUnits <= allowed
    ? { ok: true, msg: 'Estimated ' + round(c.costUnits, 1) + ' ' + unit + ' fits the ' + round(remaining, 0) + ' ' + unit + ' remaining on ' + c.cluster.name + ' (' + round((c.costUnits / Math.max(remaining, 1e-9)) * 100, 1) + '%).' }
    : { ok: false, msg: 'Estimated ' + round(c.costUnits, 1) + ' ' + unit + ' exceeds ' + (allowed < remaining ? 'the ' + round(shareLimit * 100, 0) + '% per-run share of ' : '') + 'the ' + round(remaining, 0) + ' ' + unit + ' remaining on ' + c.cluster.name + '.' };
}

function deadlineCheck(ctx, c) {
  if (ctx.deadlineMs == null) return { ok: true, msg: 'No deadline set.' };
  var left = (ctx.deadlineMs - ctx.now) / HOUR_MS;
  return c.meetsDeadline
    ? { ok: true, msg: 'Wait ' + fmtHours(c.wait) + ' + 1.2 x runtime ' + fmtHours(c.duration) + ' finishes ' + fmtHours(c.slack) + ' before ' + ctx.deadlineLabel + '.' }
    : { ok: false, msg: 'Wait ' + fmtHours(c.wait) + ' + 1.2 x runtime ' + fmtHours(c.duration) + ' = ' + fmtHours(c.finishHours) + ', but ' + ctx.deadlineLabel + ' is in ' + fmtHours(Math.max(0, left)) + '.' };
}

/** Built-in checks that do not depend on Policy rows. Each: { kind, title, severity, ok, msg }. */
function builtinChecks(ctx, c) {
  var out = [];
  var st = String(c.cluster.status || 'ONLINE');
  out.push({
    kind: 'CLUSTER_ONLINE',
    title: 'Cluster accepting jobs',
    severity: 'BLOCK',
    ok: st == 'ONLINE' || st == 'DEGRADED',
    msg: st == 'RETIRED'
      ? c.cluster.name + ' is retired and accepts no jobs' + (String(c.cluster.id) == 'bell' ? ' (decommissioned 2026-10-31; successor: Gautschi).' : '.')
      : st == 'MAINTENANCE' ? c.cluster.name + ' is in maintenance; no new jobs are scheduled.' : c.cluster.name + ' is ' + st.toLowerCase() + '.',
  });
  var alloc = ctx.allocations[c.cluster.id];
  out.push({
    kind: 'ACCOUNT_ACCESS',
    title: 'Lab has an account and allocation',
    severity: 'BLOCK',
    ok: alloc != null,
    msg: alloc != null ? 'Charged to account ' + chooseAccount(ctx, c.cluster, c.isGpu) + ' on ' + c.cluster.name + '.' : 'The lab has no active allocation (Slurm account) on ' + c.cluster.name + '.',
  });
  if (c.isGpu && ctx.memNeedGb > 0) {
    out.push({
      kind: 'GPU_MEMORY_FIT',
      title: 'Model fits in GPU memory',
      severity: 'BLOCK',
      ok: c.memFit,
      msg: (c.memFit ? 'Needs ~' : 'Needs ~') + round(ctx.memNeedGb, 0) + ' GB of GPU memory; ' + c.gpus + ' x ' + c.gpuType.id + ' provide ' + c.gpus * num(c.gpuType.memoryGb, 0) + ' GB' + (c.memFit ? '.' : ' — use more GPUs (FSDP/ZeRO) or a larger GPU.'),
    });
  }
  var hasBudget = false;
  var hasDeadline = false;
  ctx.policies.forEach(function (pol) {
    if (!policyApplies(pol, c)) return;
    if (pol.kind == 'BUDGET_REMAINING') hasBudget = true;
    if (pol.kind == 'DEADLINE_FEASIBLE') hasDeadline = true;
  });
  if (!hasBudget && alloc != null) {
    var b = budgetCheck(ctx, c, null);
    out.push({ kind: 'BUDGET_REMAINING', title: 'Allocation balance covers the run', severity: 'BLOCK', ok: b.ok, msg: b.msg });
  }
  if (!hasDeadline && ctx.deadlineMs != null) {
    var d = deadlineCheck(ctx, c);
    out.push({ kind: 'DEADLINE_FEASIBLE', title: 'Finishes before the deadline', severity: 'WARN', ok: d.ok, msg: d.msg });
  }
  return out;
}

/** All rule results for one candidate: [{ key, policy, kind, title, severity, scope, ok, msg }]. */
function evaluateCandidate(ctx, c) {
  var results = [];
  ctx.policies.forEach(function (pol) {
    if (!policyApplies(pol, c)) return;
    var r = evalPolicy(ctx, pol, c);
    results.push({
      key: pol.id,
      policy: pol,
      kind: String(pol.kind),
      title: pol.title || String(pol.kind),
      severity: String(pol.severity || 'WARN'),
      scope: String(pol.scope),
      ok: r.ok,
      msg: r.msg,
    });
  });
  builtinChecks(ctx, c).forEach(function (b) {
    results.push({ key: b.kind, policy: null, kind: b.kind, title: b.title, severity: b.severity, scope: 'UNIVERSITY', ok: b.ok, msg: b.msg });
  });
  return results;
}

function blocks(results) {
  return results.filter(function (r) {
    return !r.ok && r.severity == 'BLOCK';
  });
}

function warns(results) {
  return results.filter(function (r) {
    return !r.ok && r.severity == 'WARN';
  });
}

/** Every modeled (partition, gpus) option with its rule results. */
function allOptions(ctx, restrict) {
  var out = [];
  candidatePartitions(ctx, restrict).forEach(function (p) {
    gpuOptions(ctx, p).forEach(function (g) {
      var c = modelCandidate(ctx, p, g);
      if (c == null) return;
      c.results = evaluateCandidate(ctx, c);
      c.blocked = blocks(c.results).length > 0;
      out.push(c);
    });
  });
  return out;
}

// ---------------------------------------------------------------- checkRules

function checkRules() {
  var ctx = loadContext(this.id);
  var req = ctx.req;
  var restricted = req.requestedPartition != null || req.requestedCluster != null || req.requestedGpuType != null;
  var shown = allOptions(ctx, true);
  var everything = restricted ? allOptions(ctx, false) : shown;
  // one representative option per partition (smallest GPU count) for the display checks
  var perPartition = {};
  shown.forEach(function (c) {
    if (perPartition[c.p.id] == null || c.gpus < perPartition[c.p.id].gpus) perPartition[c.p.id] = c;
  });
  var reps = Object.keys(perPartition).map(function (k) {
    return perPartition[k];
  });

  // merge results per rule key across representative options
  var byKey = {};
  var order = [];
  reps.forEach(function (c) {
    c.results.forEach(function (r) {
      var e = byKey[r.key];
      if (!e) {
        e = byKey[r.key] = { r: r, fails: [], passes: [], firstFailMsg: null, firstPassMsg: null };
        order.push(r.key);
      }
      var label = (c.cluster.name || c.cluster.id) + ' ' + (c.p.name || c.p.id);
      if (r.ok) {
        e.passes.push(label);
        e.firstPassMsg = e.firstPassMsg || r.msg;
      } else {
        e.fails.push(label);
        e.firstFailMsg = e.firstFailMsg || r.msg;
      }
    });
  });

  var nowDt = toDt(ctx.now);
  var rows = order.map(function (key) {
    var e = byKey[key];
    var r = e.r;
    var total = e.fails.length + e.passes.length;
    var outcome;
    var msg;
    if (!e.fails.length) {
      outcome = 'PASS';
      msg = total > 1 ? 'Satisfied by all ' + total + ' options. ' + e.firstPassMsg : e.firstPassMsg;
    } else if (r.severity == 'INFO') {
      outcome = 'PASS';
      msg = 'For information: ' + e.firstFailMsg;
    } else if (!e.passes.length) {
      outcome = r.severity == 'BLOCK' ? 'FAIL' : 'WARN';
      msg = total > 1 ? 'Fails for all ' + total + ' options. ' + e.firstFailMsg : e.firstFailMsg;
    } else {
      outcome = 'WARN';
      msg = 'Rules out ' + e.fails.length + ' of ' + total + ' options (' + e.fails.slice(0, 4).join(', ') + (e.fails.length > 4 ? ', ...' : '') + '). ' + e.firstFailMsg;
    }
    return RuleCheck.make({
      id: req.id + '-' + key,
      runRequest: { id: req.id },
      policy: r.policy ? { id: r.policy.id } : null,
      outcome: outcome,
      message: msg,
      checkedAt: nowDt,
      title: r.title,
      ruleKind: r.kind,
      severity: r.severity,
      scope: r.scope,
    });
  });
  rows.sort(function (a, b) {
    return SEVERITY_ORDER[a.outcome] - SEVERITY_ORDER[b.outcome];
  });

  if (!reps.length) {
    rows.push(
      RuleCheck.make({
        id: req.id + '-NO_CANDIDATES',
        runRequest: { id: req.id },
        outcome: 'FAIL',
        message: 'No partition matches the requested cluster, partition and GPU type' + (ctx.wantsCpu ? ' for CPU-only work.' : '.'),
        checkedAt: nowDt,
        title: 'A matching partition exists',
        ruleKind: 'ACCOUNT_ACCESS',
        severity: 'BLOCK',
        scope: 'UNIVERSITY',
      })
    );
  }

  RuleCheck.removeAll({ filter: Filter.eq('runRequest.id', req.id).toString() }, true);
  if (rows.length) RuleCheck.upsertBatch(rows);

  var feasible = everything.filter(function (c) {
    return !c.blocked;
  });
  var status = feasible.length ? 'CHECKED' : 'REJECTED';
  RunRequest.make({ id: req.id, status: status }).merge();
  log.info('checkRules {}: {} checks, {} of {} options feasible -> {}', req.id, rows.length, feasible.length, everything.length, status);

  return list(RuleCheck.fetch({ filter: Filter.eq('runRequest.id', req.id), limit: 200 }).objs).sort(function (a, b) {
    return SEVERITY_ORDER[a.outcome] - SEVERITY_ORDER[b.outcome];
  });
}

// ---------------------------------------------------------------- recommendPlans

function sbatchScript(ctx, c, label) {
  var req = ctx.req;
  var name = slug(req.name);
  var account = chooseAccount(ctx, c.cluster, c.isGpu);
  var qos = partitionQos(c.p);
  var part = slurmPartitionName(c.p);
  var gpn = c.isGpu ? Math.min(c.gpus, num(c.p.gpusPerNode, 1)) : 0;
  var gpusPerNode = Math.max(1, num(c.p.gpusPerNode, 1));
  var coresPerNode = num(c.p.coresPerNode, 64);
  var cpt = c.isGpu ? Math.max(1, Math.floor(coresPerNode / gpusPerNode)) : 1;
  var mem = c.isGpu ? Math.max(8, Math.round((num(c.p.memPerNodeGb, 256) * gpn) / gpusPerNode * 0.9)) : Math.round(num(c.p.memPerNodeGb, 256) * 0.9);
  var checkpointing = c.p.preemptible || c.chained > 1 || c.walltime > 4;
  var L = [];
  L.push('#!/bin/bash');
  L.push('# EasyCompute plan "' + label + '" for "' + (req.name || req.id) + '" (' + (ctx.lab.name || ctx.labId) + ')');
  L.push('# ' + (c.isGpu ? c.gpus + ' x ' + c.gpuType.id : c.nodes + ' node(s), ' + c.nodes * coresPerNode + ' cores') + ' on ' + c.cluster.name + ' ' + (c.p.name || c.p.id) +
    ' | predicted runtime ' + fmtHours(c.duration) + ' | wait ' + waitBucket(c.wait) + ' | est. cost ' + round(c.costUnits, 1) + ' ' + (c.cluster.unitName || 'units') + ' ($' + round(c.costUsd, 2) + ')');
  L.push('#SBATCH --job-name=' + name);
  L.push('#SBATCH --account=' + account);
  L.push('#SBATCH --partition=' + part);
  L.push('#SBATCH --qos=' + qos);
  L.push('#SBATCH --nodes=' + c.nodes);
  if (c.isGpu) {
    L.push('#SBATCH --ntasks-per-node=' + gpn);
    L.push('#SBATCH --gpus-per-node=' + gpn);
    L.push('#SBATCH --cpus-per-task=' + cpt);
  } else {
    L.push('#SBATCH --ntasks-per-node=' + coresPerNode);
  }
  L.push('#SBATCH --mem=' + mem + 'G');
  L.push('#SBATCH --time=' + slurmTime(c.walltime));
  if (c.chained > 1) L.push('#SBATCH --array=1-' + c.chained + '%1            # ' + c.chained + ' chained jobs, one at a time, each resumes from the last checkpoint');
  if (checkpointing) L.push('#SBATCH --signal=B:USR1@600       # 10 min warning before preemption/timeout -> checkpoint');
  if (c.p.preemptible || c.chained > 1) L.push('#SBATCH --requeue');
  L.push('#SBATCH --mail-type=BEGIN,END,FAIL,TIME_LIMIT_80');
  if (ctx.req.submittedBy && ctx.req.submittedBy.username) L.push('#SBATCH --mail-user=' + ctx.req.submittedBy.username + '@purdue.edu');
  L.push('#SBATCH --output=%x-%j.out');
  L.push('');
  L.push('set -euo pipefail');
  L.push('module purge');
  var wt = String(req.workloadType || '');
  if (wt == 'SIMULATION') {
    L.push('module load ' + (c.isGpu ? 'cuda gromacs/2024.4-gpu' : 'gromacs/2024.4'));
  } else if (c.isGpu) {
    L.push('module load cuda/12.6 conda');
    L.push('conda activate ' + name);
  } else {
    L.push('module load conda');
    L.push('conda activate ' + name);
  }
  if (checkpointing) {
    L.push('');
    L.push('# On USR1 ask the application to write a checkpoint before the job ends');
    L.push("trap 'echo \"USR1 received: checkpointing\"; touch \"$SLURM_SUBMIT_DIR/CHECKPOINT_NOW\"' USR1");
  }
  L.push('');
  L.push('cd "$SLURM_SUBMIT_DIR"');
  if (wt == 'SIMULATION') {
    L.push('srun gmx_mpi mdrun -deffnm ' + name + ' -cpi ' + name + '.cpt -cpt 15 -maxh ' + round(Math.max(0.2, c.walltime - 0.2), 1) + ' &');
  } else if (wt == 'DATA_PROCESSING') {
    L.push('srun python process.py --input "$RCAC_SCRATCH/' + name + '/raw" --output "$RCAC_SCRATCH/' + name + '/processed" &');
  } else if (wt == 'INFERENCE') {
    L.push('srun python infer.py --model checkpoints/' + name + ' --tensor-parallel ' + Math.max(1, c.gpus) + ' --batch-size 32 &');
  } else if (wt == 'INTERACTIVE') {
    L.push('jupyter lab --no-browser --ip=0.0.0.0 --port=$((8000 + RANDOM % 1000)) &');
  } else {
    L.push('srun torchrun --nnodes=$SLURM_NNODES --nproc_per_node=' + Math.max(1, gpn) + ' \\');
    L.push('  --rdzv_backend=c10d --rdzv_endpoint=$(hostname):29500 \\');
    L.push('  train.py --config configs/' + name + '.yaml --resume-from latest --save-every-min 30 &');
  }
  L.push('wait');
  return L.join('\n');
}

function rationale(ctx, c, label) {
  var parts = [];
  var hw = c.isGpu ? c.gpus + ' x ' + c.gpuType.id : c.nodes + ' CPU node(s)';
  var why = {
    Fastest: 'Earliest expected finish of all compliant options.',
    Cheapest: 'Lowest cost of all compliant options.',
    Balanced: 'Best trade-off of finish time, cost, deadline slack and risk.',
  }[label];
  parts.push(why + ' Runs ' + hw + ' on ' + c.cluster.name + ' ' + (c.p.name || c.p.id) + ' (' + partitionQos(c.p) + ' QOS): predicted runtime ' + fmtHours(c.duration) +
    (c.chained > 1 ? ' as ' + c.chained + ' chained ' + fmtHours(c.walltime) + ' jobs with checkpoints' : '') + ', queue wait about ' + fmtHours(c.wait) + ' (' + waitBucket(c.wait) + ').');
  parts.push(ctx.workBasis);
  var alloc = ctx.allocations[c.cluster.id];
  var unit = c.cluster.unitName || 'units';
  var share = alloc && alloc.totalUnits - alloc.usedUnits > 0 ? ' = ' + round((c.costUnits / (alloc.totalUnits - alloc.usedUnits)) * 100, 1) + '% of the lab\'s remaining ' + c.cluster.name + ' balance' : '';
  parts.push('Cost ' + round(c.costUnits, 1) + ' ' + unit + ' at ' + round(num(c.p.chargeFactor, 1), 2) + 'x (~$' + round(c.costUsd, 2) + ')' + share + '.');
  if (ctx.deadlineMs != null) {
    parts.push(c.meetsDeadline ? 'Finishes ' + fmtHours(c.slack) + ' before ' + ctx.deadlineLabel + '.' : 'Misses ' + ctx.deadlineLabel + ' by ' + fmtHours(-c.slack) + '.');
  }
  if (c.p.preemptible) parts.push('Preemptible: ' + Math.round(c.preemptionRisk * 100) + '% chance of preemption; the script checkpoints on the 10-minute signal and requeues.');
  var w = warns(c.results);
  if (w.length) parts.push('Warnings: ' + w.map(function (r) { return r.title; }).join('; ') + '.');
  return parts.join(' ');
}

function recommendPlans() {
  var ctx = loadContext(this.id);
  var req = ctx.req;
  var options = allOptions(ctx, false).filter(function (c) {
    return !c.blocked;
  });
  RunPlan.removeAll({ filter: Filter.eq('runRequest.id', req.id).toString() }, true);
  if (!options.length) {
    RunRequest.make({ id: req.id, status: 'REJECTED' }).merge();
    log.info('recommendPlans {}: no compliant option', req.id);
    return RunPlan.fetch({ filter: Filter.eq('runRequest.id', req.id), limit: 10 }).objs;
  }

  var minF = Infinity, maxF = -Infinity, minC = Infinity, maxC = -Infinity;
  options.forEach(function (c) {
    minF = Math.min(minF, c.finishHours);
    maxF = Math.max(maxF, c.finishHours);
    minC = Math.min(minC, c.costUsd);
    maxC = Math.max(maxC, c.costUsd);
  });
  var preferred = csv(ctx.lab.preferredClusters);
  options.forEach(function (c) {
    var f = maxF > minF ? (c.finishHours - minF) / (maxF - minF) : 0;
    var k = maxC > minC ? (c.costUsd - minC) / (maxC - minC) : 0;
    var s = 100 * (1 - (0.4 * f + 0.35 * k + 0.15 * c.preemptionRisk + 0.1 * Math.min(1, warns(c.results).length / 3)));
    if (!c.meetsDeadline) s -= 30;
    if (preferred.indexOf(String(c.cluster.id)) >= 0) s += 3;
    if (req.requestedCluster != null && req.requestedCluster.id == c.cluster.id) s += 4;
    if (req.requestedPartition != null && req.requestedPartition.id == c.p.id) s += 4;
    if (req.requestedGpuType != null && c.gpuType != null && req.requestedGpuType.id == c.gpuType.id) s += 4;
    c.score = Math.max(0, Math.min(100, s));
  });

  var pickedIds = {};
  var picks = [];
  function take(label, cmp) {
    var sorted = options.slice().sort(cmp);
    for (var i = 0; i < sorted.length; i++) {
      var key = sorted[i].p.id + ':' + sorted[i].gpus;
      if (!pickedIds[key]) {
        pickedIds[key] = true;
        picks.push({ c: sorted[i], label: label });
        return;
      }
    }
  }
  var deadlineFirst = function (a, b) {
    return (a.meetsDeadline ? 0 : 1) - (b.meetsDeadline ? 0 : 1);
  };
  take('Fastest', function (a, b) {
    return a.finishHours - b.finishHours || a.costUsd - b.costUsd;
  });
  take('Cheapest', function (a, b) {
    return deadlineFirst(a, b) || a.costUsd - b.costUsd || a.finishHours - b.finishHours;
  });
  take('Balanced', function (a, b) {
    return b.score - a.score;
  });

  picks.sort(function (a, b) {
    return b.c.score - a.c.score;
  });
  var plans = picks.map(function (pk, i) {
    var c = pk.c;
    return RunPlan.make({
      id: req.id + '-plan-' + (i + 1),
      runRequest: { id: req.id },
      rank: i + 1,
      label: pk.label,
      cluster: { id: c.cluster.id },
      partition: { id: c.p.id },
      gpuType: c.gpuType ? { id: c.gpuType.id } : null,
      gpus: c.gpus,
      nodes: c.nodes,
      walltimeHours: round(c.walltime, 2),
      estWaitHours: round(c.wait, 2),
      estDurationHours: round(c.duration, 2),
      estCostUnits: round(c.costUnits, 2),
      estCostUsd: round(c.costUsd, 2),
      meetsDeadline: c.meetsDeadline,
      score: round(c.score, 1),
      rationale: rationale(ctx, c, pk.label),
      sbatchScript: sbatchScript(ctx, c, pk.label),
      qos: partitionQos(c.p),
      account: chooseAccount(ctx, c.cluster, c.isGpu),
      slurmPartition: slurmPartitionName(c.p),
      waitBucket: waitBucket(c.wait),
      waitReason: c.waitReason,
      chainedJobs: c.chained,
      preemptionRisk: round(c.preemptionRisk, 3),
      gpuMemNeedGb: round(ctx.memNeedGb, 1),
      costPerGpuHourUsd: c.usdPerGpuHour == null ? null : round(c.usdPerGpuHour, 3),
      finishBy: toDt(ctx.now + c.finishHours * HOUR_MS),
      deadlineSlackHours: c.slack == null ? null : round(c.slack, 1),
      ruleWarnings: warns(c.results).length,
    });
  });
  RunPlan.upsertBatch(plans);
  RunRequest.make({ id: req.id, status: 'PLANNED' }).merge();
  log.info('recommendPlans {}: {} compliant options, {} plans', req.id, options.length, plans.length);
  return RunPlan.fetch({ filter: Filter.eq('runRequest.id', req.id), order: 'rank', limit: 10 }).objs;
}

// ---------------------------------------------------------------- submit

function nextSlurmJobId(clusterId) {
  var n = 8240000 + (Job.fetchCount({ filter: Filter.eq('cluster.id', clusterId) }) % 50000) * 7;
  for (var i = 0; i < 50; i++) {
    var id = clusterId + '-' + n;
    if (Job.make({ id: id }).get('id') == null) return String(n);
    n += 13;
  }
  return String(Date.now() % 100000000);
}

function nodeName(clusterId, i) {
  var prefix = { gautschi: 'gautschi-h', gilbreth: 'gilbreth-k', anvil: 'g', negishi: 'negishi-a', 'aws-p4d': 'ip-10-0-4-' }[clusterId] || clusterId + '-n';
  var n = String(10 + i);
  return prefix + (n.length < 3 ? '0' + n : n);
}

function submit(planId) {
  var req = RunRequest.make({ id: this.id }).get('this, lab.this, project, submittedBy.this');
  if (req == null) throw new Error('RunRequest ' + this.id + ' not found');
  var plan = RunPlan.make({ id: planId }).get('this, cluster.this, partition.this, gpuType.this');
  if (plan == null || plan.runRequest == null || plan.runRequest.id != req.id) throw new Error('RunPlan ' + planId + ' is not a plan of RunRequest ' + req.id);
  if (req.status == 'SUBMITTED') throw new Error('RunRequest ' + req.id + ' was already submitted');

  var now = Date.now();
  var clusterId = String(plan.cluster.id);
  var slurmJobId = nextSlurmJobId(clusterId);
  var jobId = clusterId + '-' + slurmJobId;
  var running = num(plan.estWaitHours, 0) < 0.25;
  var startMs = running ? now - 15 * 60 * 1000 : null;
  var gpus = num(plan.gpus, 0);
  var nodes = Math.max(1, num(plan.nodes, 1));
  var p = plan.partition;
  var gpusPerNode = Math.max(1, num(p.gpusPerNode, 1));
  var cores = gpus > 0 ? Math.floor(num(p.coresPerNode, 64) / gpusPerNode) * gpus : nodes * num(p.coresPerNode, 64);
  var nodeList = [];
  for (var i = 0; i < nodes; i++) nodeList.push(nodeName(clusterId, (Number(slurmJobId) + i * 3) % 40));
  var lab = req.lab;
  var user = req.submittedBy && req.submittedBy.username ? String(req.submittedBy.username) : 'user_' + String(lab.id).substring(0, 3);

  Job.make({
    id: jobId,
    slurmJobId: slurmJobId,
    lab: { id: lab.id },
    project: req.project ? { id: req.project.id } : null,
    runRequest: { id: req.id },
    user: user,
    cluster: { id: clusterId },
    partition: { id: p.id },
    account: plan.account,
    qos: plan.qos,
    jobName: slug(req.name),
    workloadType: req.workloadType,
    state: running ? 'RUNNING' : 'PENDING',
    submitTime: toDt(running ? startMs - 60 * 1000 : now),
    startTime: running ? toDt(startMs) : null,
    timelimitHours: num(plan.walltimeHours, 4),
    elapsedHours: running ? 0.25 : 0,
    allocCpus: cores,
    allocNodes: nodes,
    allocGpus: gpus,
    gpuType: plan.gpuType ? { id: plan.gpuType.id } : null,
    reqMemGb: gpus > 0 ? Math.round((num(p.memPerNodeGb, 256) * Math.min(gpus, gpusPerNode)) / gpusPerNode * 0.9) * nodes : Math.round(num(p.memPerNodeGb, 256) * 0.9) * nodes,
    costUnits: 0,
    costUsd: 0,
    isLive: true,
    nodeList: running ? nodeList.join(',') : null,
    exitCode: null,
  }).create();

  if (running) {
    var tdp = plan.gpuType && /H100/.test(plan.gpuType.id) ? 700 : plan.gpuType && /A100/.test(plan.gpuType.id) ? 400 : 300;
    var wt = String(req.workloadType || '');
    var training = wt == 'TRAINING' || wt == 'FINETUNE';
    var samples = [];
    for (var s = 0; s < 4; s++) {
      var util = gpus > 0 ? 40 + s * 14 : 0;
      samples.push(
        JobMetric.make({
          id: jobId + '-m' + s,
          job: { id: jobId },
          ts: toDt(startMs + s * 5 * 60 * 1000),
          gpuUtilPct: util,
          gpuMemPct: gpus > 0 ? 35 + s * 10 : 0,
          cpuUtilPct: 55 + s * 5,
          memPct: 30 + s * 3,
          ioReadMBps: round(Math.min(2000, 150 + num(req.datasetGb, 10) * 2) * (s === 0 ? 2 : 1), 1),
          ioWriteMBps: 4,
          powerW: gpus > 0 ? round(gpus * (70 + ((tdp - 70) * util) / 100), 0) : 0,
          checkpointAgeMin: s * 5,
          trainingLoss: training ? round(2.9 - s * 0.08, 3) : null,
        })
      );
    }
    JobMetric.createBatch(samples);
  }

  RunRequest.make({ id: req.id, status: 'SUBMITTED', chosenPlan: { id: plan.id } }).merge();
  var cmd = 'sbatch -A ' + plan.account + ' -p ' + plan.slurmPartition + ' -q ' + plan.qos + ' --nodes=' + nodes +
    (gpus > 0 ? ' --gpus-per-node=' + Math.min(gpus, gpusPerNode) : '') + ' --time=' + slurmTime(num(plan.walltimeHours, 4)) + ' ' + slug(req.name) + '.sh';
  ActionLogEntry.make({
    id: jobId + '-submit',
    lab: { id: lab.id },
    job: { id: jobId },
    runRequest: { id: req.id },
    actionType: 'SUBMIT',
    actor: 'USER',
    actedAt: toDt(now),
    detail: 'Submitted plan "' + plan.label + '" (' + plan.id + '): ' + cmd + ' -> Submitted batch job ' + slurmJobId + (running ? ' (started immediately).' : ' (queued; expected wait ' + plan.waitBucket + ').'),
    outcome: 'DONE',
  }).create();
  log.info('submit {}: plan {} -> job {}', req.id, plan.id, jobId);
  return Job.make({ id: jobId }).get('this');
}
