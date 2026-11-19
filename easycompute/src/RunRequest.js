/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('RunRequest');

var HOUR_MS = 3600 * 1000;
/** Workloads that checkpoint, so a run longer than the walltime limit can be split into chained jobs. */
var CHECKPOINTABLE = ['TRAINING', 'FINETUNE', 'SIMULATION'];
/** Chained runs: at most this many jobs, only on partitions whose limit is at least this long. */
var MAX_CHAINED_JOBS = 6;
var MIN_CHAIN_WALLTIME_HOURS = 4;

/** Debug / test / interactive queues (Anvil debug, gpu-debug, ...): for short tests only, never for chained production runs. */
function isShortQueue(p) {
  return /debug|test|interactive/i.test(String(p.slurmPartition || '') + ' ' + String(p.name || '') + ' ' + String(p.id || '') + ' ' + String(p.qos || ''));
}
var SEVERITY_ORDER = { FAIL: 0, WARN: 1, PASS: 2 };
/** ClusterPolicyEngine rule-set version: the latest RCAC policy change encoded (Gautschi-AI QOS, 2026-11-02). */
var POLICY_VERSION = 'rcac-2026-11-02';
/** Anvil partition categories the MODEL_MAP quantile models were trained on. */
var ANVIL_PARTITIONS = ['shared', 'standard', 'gpu', 'gpu-debug', 'highmem', 'wide', 'debug'];

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

/** A `json` value returned by another type's method, as a plain JS object (it may arrive boxed or as a string). */
function plainJson(v) {
  if (v == null) return v;
  if (typeof v === 'string') return JSON.parse(v);
  if (typeof v.type === 'string' && /^Boxed/.test(v.type) && v.value != null) return v.value;
  return v;
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
  var runningGpusByPartition = {};
  Job.fetchObjStream({
    filter: Filter.eq('lab.id', labId).and().intersects('state', ['RUNNING', 'PENDING']),
    include: 'partition, state, allocGpus',
  }).each(function (j) {
    if (j.partition == null) return;
    liveByPartition[j.partition.id] = (liveByPartition[j.partition.id] || 0) + 1;
    if (j.state == 'RUNNING') runningGpusByPartition[j.partition.id] = (runningGpusByPartition[j.partition.id] || 0) + num(j.allocGpus, 0);
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
  prediction = plainJson(prediction);
  var advice = plainJson(
    GPUShapeAdvisor.advise(
      String(req.workloadType || 'TRAINING'),
      num(req.modelParamsB, 0),
      num(req.datasetGb, 0),
      req.requestedGpus == null ? null : Number(req.requestedGpus),
      req.requestedGpuType != null ? String(req.requestedGpuType.id) : null,
      String(req.name || '') + ' ' + String(req.description || '')
    )
  );
  var shapes = {};
  (advice.shapes || []).forEach(function (sh) {
    shapes[sh.gpuTypeId] = sh;
  });
  var memNeedGb = num(advice.memoryNeedGb, 0);

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
    runningGpusByPartition: runningGpusByPartition,
    deadlineMs: deadlineMs,
    deadlineLabel: deadlineLabel,
    labUtil: labUtil,
    wantsCpu: wantsCpu,
    prediction: prediction,
    memNeedGb: memNeedGb,
    shapes: shapes,
    shapeAdvice: advice,
    work: work,
    workP90: workP90,
    workBasis: workBasis,
    fairShare: {},
  };
}

/** Lab share of GPU-hours on a cluster (cached per cluster), for FAIRSHARE_CAP. */
function labShareOnCluster(ctx, clusterId) {
  if (ctx.fairShare[clusterId] !== undefined) return ctx.fairShare[clusterId];
  var total = 0;
  var mine = 0;
  Job.fetchObjStream({ filter: Filter.eq('cluster.id', clusterId).and('allocGpus > 0'), include: 'lab, allocGpus, elapsedHours' }).each(function (j) {
    var gh = num(j.allocGpus, 0) * num(j.elapsedHours, 0);
    total += gh;
    if (j.lab != null && j.lab.id == ctx.labId) mine += gh;
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

/** ACCESS project ids look like `cis250417` (three letters + six digits). */
var ACCESS_ACCOUNT_RE = /^[a-z]{3}\d{6}$/;

/**
 * Slurm account the way RCAC expects it: the PI/lab account on Purdue community clusters (Gilbreth, Gautschi, Negishi);
 * the ACCESS allocation on Anvil, with the `-gpu` suffix for GPU partitions (`-A cis250417-gpu`); `<lab>-aws` on the
 * cloud ParallelCluster.
 */
function chooseAccount(ctx, cluster, isGpu) {
  var accounts = csv(ctx.lab.slurmAccounts).map(function (a) {
    return a.toLowerCase();
  });
  var base = accounts.filter(function (a) {
    return !ACCESS_ACCOUNT_RE.test(a.replace(/-gpu$/, '')) && !/-aws$/.test(a);
  })[0] || String(ctx.labId).replace(/^lab-/, '');
  if (cluster.billing == 'ACCESS_SU') {
    var alloc = ctx.allocations[cluster.id];
    var fromGrant = alloc ? (alloc.grantNames.join(' ').match(/\b([A-Za-z]{3}\d{6})\b/) || [])[1] : null;
    var project = (fromGrant ? fromGrant.toLowerCase() : null) || accounts.filter(function (a) {
      return ACCESS_ACCOUNT_RE.test(a);
    })[0] || base;
    return isGpu ? project + '-gpu' : project;
  }
  if (cluster.billing == 'THIRD_PARTY_HOURLY') {
    return accounts.filter(function (a) {
      return /-aws$/.test(a);
    })[0] || base + '-aws';
  }
  return base;
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
 * Models one (partition, GPU count) option: duration, walltime (chained when needed), cost, deadline, risk. Runs start
 * immediately on submit (no queue), so the finish time is runtime only.
 * Returns null when the option is physically impossible (memory, walltime without checkpointing).
 */
function modelCandidate(ctx, p, gpus, q) {
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
  var runtimeSource = 'heuristic';
  if (q && q.runtime) {
    // AnvilRuntimeQ50Q90: P50/P90 of historical Anvil jobs with this request shape
    duration = Math.max(0.05, q.runtime.p50);
    durationP90 = Math.max(duration, q.runtime.p90);
    runtimeSource = 'model';
  }
  if (req.workloadType == 'INTERACTIVE') {
    duration = Math.max(1, num(req.requestedWalltimeHours, 4));
    durationP90 = duration;
  }
  var needed = Math.max(0.5, Math.ceil(durationP90 * 1.2 * 4) / 4);
  var maxWall = num(p.maxWalltimeHours, 336);
  var walltime = req.requestedWalltimeHours ? Number(req.requestedWalltimeHours) : Math.min(needed, maxWall);
  var chained = 1;
  if (!req.requestedWalltimeHours && needed > maxWall) {
    // chaining only where an RCAC user would: checkpointable work, a production partition with a long enough limit,
    // and a handful of jobs (a 2-day run is not 100 debug-queue jobs)
    if (CHECKPOINTABLE.indexOf(String(req.workloadType)) < 0) return null;
    if (isShortQueue(p) || partitionQos(p) == 'standby' || maxWall < MIN_CHAIN_WALLTIME_HOURS) return null;
    chained = Math.ceil(needed / maxWall);
    if (chained > MAX_CHAINED_JOBS) return null;
    walltime = maxWall;
  }
  var memFit = !isGpu || ctx.memNeedGb <= 0 || ctx.memNeedGb <= gpus * num(gpuType.memoryGb, 40) * 0.9;

  var util = num(p.utilizationPct, 50);
  var nodeShareGb = isGpu ? Math.max(8, Math.round(((num(p.memPerNodeGb, 256) * Math.min(gpus, gpusPerNode)) / gpusPerNode) * 0.9)) : Math.round(num(p.memPerNodeGb, 256) * 0.9);
  var memRequestGb = nodeShareGb;
  var memSource = 'heuristic';
  if (q && q.mem) {
    memRequestGb = Math.min(nodeShareGb, Math.max(4, Math.ceil(q.mem.p90 * 1.15)));
    memSource = 'model';
  }
  var cpuEvidence = q && q.cpu ? 'AnvilTaskCPUQ50Q90 (historical): P90 of similar Anvil batch tasks ' + round(q.cpu.p90, 1) + ' core-equivalents; requested ' + (isGpu ? Math.floor(coresPerNode / gpusPerNode) * gpus : nodes * coresPerNode) + '.' : null;

  var rates = unitRates(cluster, p, gpuType);
  var resourceHours = isGpu ? gpus * duration : nodes * coresPerNode * duration;
  var costUnits = resourceHours * rates.unitsPerHour;
  var costUsd = resourceHours * rates.usdPerHour;
  var finishHours = duration * 1.2;
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
    durationP90: durationP90,
    runtimeSource: runtimeSource,
    memRequestGb: memRequestGb,
    memSource: memSource,
    cpuEvidence: cpuEvidence,
    shape: isGpu ? ctx.shapes[gpuType.id] || null : null,
    walltime: walltime,
    chained: chained,
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

/** GPU counts worth considering on a partition: GPUShapeAdvisor's options, capped by the partition's limits. */
function gpuOptions(ctx, p) {
  var gpuType = p.gpuType ? ctx.gpuTypes[p.gpuType.id] : null;
  if (gpuType == null) return [1, 2, 4]; // CPU: node counts
  var sh = ctx.shapes[gpuType.id];
  var cap = Math.min(num(p.maxGpusPerJob, 64) || 64, num(p.gpusPerNode, 1) * (num(p.maxNodesPerJob, 1) || 1), 64);
  if (sh == null) return [ctx.req.requestedGpus > 0 ? Number(ctx.req.requestedGpus) : 1];
  var out = sh.options.filter(function (g) {
    return g <= cap || ctx.req.requestedGpus > 0;
  });
  if (!out.length) out.push(sh.minGpus); // shown as a memory-fit / limit failure
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

var EXPORT_RE = /\b(ITAR|EAR|CUI|export[- ]control)/i;
var REGULATED_RE = /(human[- ]subjects|HIPAA|PHI\b|clinical|patient|data[- ]use agreement|\bDUA\b|\bIRB\b|regulated|sensitive)/i;

/**
 * True when the run's own text matches `re`, or the lab context mentions the run's project in a sentence that
 * matches it (for example "the sequence set for Project HELIX is export-controlled").
 */
function dataFlagged(ctx, re) {
  var req = ctx.req;
  var own = [req.name, req.description, req.project ? req.project.name : '', req.project ? req.project.description : ''].join(' ');
  if (re.test(own)) return true;
  if (req.project == null || !req.project.name) return false;
  var words = String(req.project.name).split(/[\s:,-]+/).filter(function (w) {
    return w.length >= 4;
  });
  return String(ctx.lab.contextDump || '')
    .split(/[.!?\n]+/)
    .some(function (sentence) {
      return re.test(sentence) && words.some(function (w) {
        return sentence.toLowerCase().indexOf(w.toLowerCase()) >= 0;
      });
    });
}

/** Cluster ids named in a policy's limitText ("gilbreth,gautschi"), or [] when it is not a cluster list. */
function clusterList(ctx, text) {
  var ids = csv(text).map(function (s) {
    return s.toLowerCase();
  });
  return ids.length && ids.every(function (i) {
    return ctx.clusters[i] != null;
  }) ? ids : [];
}

/** Quiet window from text such as "Mon-Fri 09:00-17:00 ET gilbreth-a30" or "22-06". */
function quietWindow(text) {
  var t = String(text || '');
  var m = t.match(/(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?/);
  if (!m) return null;
  var targets = (t.match(/[a-z][a-z0-9]*-[a-z0-9-]+/g) || []).filter(function (x) {
    return !/^(mon|tue|wed|thu|fri|sat|sun)/i.test(x);
  });
  return { from: Number(m[1]), to: Number(m[3]), weekdaysOnly: /mon\s*-\s*fri|weekday/i.test(t), targets: targets };
}

function inQuietWindow(w, millis) {
  var hour = easternHour(millis);
  var day = new Date(millis - (hour > new Date(millis).getUTCHours() ? 24 * HOUR_MS : 0)).getUTCDay();
  if (w.weekdaysOnly && (day === 0 || day === 6)) return false;
  return w.from <= w.to ? hour >= w.from && hour < w.to : hour >= w.from || hour < w.to;
}

/** Evaluates one policy for one candidate: { ok: boolean, msg: string } (ok=true means compliant). */
function evalPolicy(ctx, pol, c) {
  var req = ctx.req;
  var kind = String(pol.kind);
  var lv = pol.limitValue == null ? null : Number(pol.limitValue);
  var text = String(pol.limitText || '');
  var where = (c.cluster.name || c.cluster.id) + ' / ' + (c.p.name || c.p.id);
  var wt = String(req.workloadType || '');
  var lim;
  if (String(pol.severity) == 'INFO') return { ok: true, msg: pol.description || pol.title || 'Guidance.' };
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
      if (lim <= 0) return { ok: false, msg: where + ' accepts no jobs (node limit 0).' };
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
      var allowed = csv(text);
      return !allowed.length || allowed.indexOf(String(c.gpuType.id)) >= 0
        ? { ok: true, msg: c.gpuType.id + ' is an allowed GPU type.' }
        : { ok: false, msg: c.gpuType.id + ' is not on the allowed list (' + allowed.join(', ') + ').' };
    case 'BUDGET_REMAINING':
      return budgetCheck(ctx, c, pol);
    case 'DEADLINE_FEASIBLE':
      return deadlineCheck(ctx, c);
    case 'FAIRSHARE_CAP':
      if (!c.isGpu) return { ok: true, msg: 'Tracked on GPU usage only.' };
      if (/purchas/i.test(text + ' ' + pol.title)) {
        // Gautschi ai normal QOS since 2026-11-02: concurrent GPUs <= max(2, 2 x purchased GPUs)
        var alloc = ctx.allocations[c.cluster.id];
        var purchased = alloc && /gpu/i.test(String(alloc.unitName)) ? Math.round(alloc.totalUnits / 8760) : 0;
        var capGpus = Math.max(lv != null ? lv : 2, 2 * purchased);
        var inUse = ctx.runningGpusByPartition[c.p.id] || 0;
        return inUse + c.gpus <= capGpus
          ? { ok: true, msg: inUse + ' running + ' + c.gpus + ' requested GPUs is within the concurrent cap of ' + capGpus + ' (max(2, 2 x ' + purchased + ' purchased)).' }
          : { ok: false, msg: 'The lab already runs ' + inUse + ' GPUs on ' + where + '; ' + c.gpus + ' more exceeds the concurrent cap of ' + capGpus + ' = max(2, 2 x ' + purchased + ' purchased GPUs). Use preemptible (0.25x) or wait.' };
      }
      var share = labShareOnCluster(ctx, c.cluster.id);
      var target = num(ctx.lab.fairShareTarget, 0);
      var cap = target * (lv != null ? lv : 1.5);
      if (share == null || target <= 0) return { ok: true, msg: 'No GPU usage recorded on ' + c.cluster.name + ' yet.' };
      return share <= cap
        ? { ok: true, msg: 'Lab uses ' + round(share * 100, 1) + '% of ' + c.cluster.name + ' GPU-hours (cap ' + round(cap * 100, 1) + '% = ' + round(lv != null ? lv : 1.5, 2) + ' x ' + round(target * 100, 1) + '% target).' }
        : { ok: false, msg: 'Lab already uses ' + round(share * 100, 1) + '% of ' + c.cluster.name + ' GPU-hours, above its fair-share cap of ' + round(cap * 100, 1) + '%. Expect lower priority, or use another cluster.' };
    case 'PREEMPTIBLE_ONLY':
      if (pol.scope == 'PARTITION') {
        // a rule on a preemptible partition: jobs there must checkpoint (10-minute grace signal)
        return CHECKPOINTABLE.indexOf(wt) >= 0
          ? { ok: true, msg: wt + ' runs checkpoint; the plan adds --signal=B:USR1@600 --requeue for the 10-minute preemption notice.' }
          : { ok: false, msg: wt + ' work usually cannot resume from a checkpoint; on ' + where + ' a preemption loses all progress.' };
      }
      if (/normal|never/i.test(text + ' ' + pol.title)) {
        var prio = req.project ? num(req.project.priority, 2) : 2;
        if (prio != 1) return { ok: true, msg: 'Applies only to priority-1 project runs.' };
        return !c.p.preemptible
          ? { ok: true, msg: where + ' uses normal QOS, as priority-1 runs require.' }
          : { ok: false, msg: 'Priority-1 (final/thesis) runs must use normal QOS; ' + where + ' is preemptible.' };
      }
      var kinds = csv(text).map(function (s) {
        return s.toUpperCase();
      }).filter(function (s) {
        return /^[A-Z_]+$/.test(s);
      });
      if (kinds.length && kinds.indexOf(wt) < 0) return { ok: true, msg: 'Applies only to ' + kinds.join(', ') + ' work.' };
      return c.p.preemptible
        ? { ok: true, msg: where + ' is preemptible.' }
        : { ok: false, msg: where + ' is not preemptible; this rule requires standby/preemptible capacity.' };
    case 'DATA_RESIDENCY':
      var okList = clusterList(ctx, text);
      if (okList.length) {
        return okList.indexOf(String(c.cluster.id)) >= 0
          ? { ok: true, msg: 'Data stays on ' + c.cluster.name + ', an approved location.' }
          : { ok: false, msg: 'Lab data may only be processed on ' + okList.join(', ') + '; ' + c.cluster.name + ' is not approved.' };
      }
      if (!dataFlagged(ctx, REGULATED_RE)) return { ok: true, msg: 'No regulated or sensitive data declared for this run.' };
      if (/NON_SENSITIVE/i.test(text)) return { ok: false, msg: 'This run uses sensitive data, and ' + c.cluster.name + ' is allowed only for non-sensitive data.' };
      return c.cluster.billing == 'IN_HOUSE_NODE_SHARE'
        ? { ok: true, msg: 'Regulated data stays on Purdue-owned ' + c.cluster.name + '.' }
        : { ok: false, msg: 'Regulated data (human subjects / DUA) must stay on Purdue-owned clusters; ' + c.cluster.name + ' is ' + (c.cluster.operator || 'external') + '.' };
    case 'EXPORT_CONTROL':
      if (!dataFlagged(ctx, EXPORT_RE)) return { ok: true, msg: 'No export-controlled data declared for this run.' };
      var tcp = clusterList(ctx, text);
      var permitted = tcp.length ? tcp.indexOf(String(c.cluster.id)) >= 0 : c.cluster.billing == 'IN_HOUSE_NODE_SHARE';
      return permitted
        ? { ok: true, msg: c.cluster.name + ' is covered by the Technology Control Plan.' }
        : { ok: false, msg: 'Export-controlled (EAR/ITAR) data may only run on ' + (tcp.length ? tcp.join(', ') : 'Purdue-owned clusters in the Technology Control Plan') + '; never on ' + c.cluster.name + '.' };
    case 'MIN_GPU_UTIL':
      lim = lv != null ? lv : 30;
      if (!c.isGpu) return { ok: true, msg: 'CPU-only option.' };
      if (ctx.labUtil == null) return { ok: true, msg: 'Not enough GPU history to judge utilization.' };
      return ctx.labUtil >= lim
        ? { ok: true, msg: 'Recent lab GPU utilization ' + round(ctx.labUtil, 0) + '% meets the ' + lim + '% minimum.' }
        : { ok: false, msg: 'Recent lab GPU jobs averaged only ' + round(ctx.labUtil, 0) + '% GPU utilization (minimum ' + lim + '%). Consider fewer or smaller GPUs and profiling the data loader.' };
    case 'QUIET_HOURS':
      var w = quietWindow(text);
      if (w == null) return { ok: true, msg: 'No quiet window configured.' };
      if (w.targets.length && !w.targets.some(function (t) {
        return String(c.p.id).indexOf(t) === 0 || String(c.cluster.id) == t;
      })) return { ok: true, msg: 'Quiet hours apply only to ' + w.targets.join(', ') + '.' };
      return !inQuietWindow(w, ctx.now)
        ? { ok: true, msg: 'Outside the quiet window (' + text + ').' }
        : { ok: false, msg: 'Inside the quiet window (' + text + '): ' + (pol.description || 'hold the job until the window ends.') };
    default:
      return { ok: true, msg: 'Not checkable automatically.' };
  }
}

/** Budget rules: balance, per-run approval threshold (limitValue > 1), cap as a share of the total (0-1), expiry ("days"). */
function budgetCheck(ctx, c, pol) {
  var lv = pol && pol.limitValue != null ? Number(pol.limitValue) : null;
  var text = pol ? String(pol.limitText || '') : '';
  if (lv != null && lv > 1 && !/day/i.test(text)) {
    var gh = c.isGpu ? c.gpus * c.duration : c.costUnits;
    return gh <= lv
      ? { ok: true, msg: 'Estimated ' + round(gh, 1) + ' GPU-hours is under the ' + lv + ' GPU-hour approval threshold.' }
      : { ok: false, msg: 'Estimated ' + round(gh, 1) + ' GPU-hours exceeds ' + lv + ' GPU-hours: ' + (pol.description || 'needs PI approval.') };
  }
  var alloc = ctx.allocations[c.cluster.id];
  if (alloc == null) return { ok: false, msg: 'The lab has no active allocation on ' + c.cluster.name + '.' };
  var unit = alloc.unitName || c.cluster.unitName || 'units';
  var remaining = alloc.totalUnits - alloc.usedUnits;
  if (lv != null && /day/i.test(text)) {
    var daysLeft = alloc.endMs == null ? null : (alloc.endMs - ctx.now) / (24 * HOUR_MS);
    return daysLeft == null || daysLeft > lv
      ? { ok: true, msg: 'The ' + c.cluster.name + ' allocation runs ' + (daysLeft == null ? 'without an end date' : 'for ' + Math.round(daysLeft) + ' more days') + '.' }
      : { ok: false, msg: 'The ' + c.cluster.name + ' allocation ends in ' + Math.max(0, Math.round(daysLeft)) + ' days (within ' + lv + '); outputs on project storage are purged after expiry.' };
  }
  if (lv != null && lv > 0 && lv <= 1) {
    var capUnits = alloc.totalUnits * lv;
    return alloc.usedUnits + c.costUnits <= capUnits
      ? { ok: true, msg: 'Used ' + round(alloc.usedUnits, 0) + ' + estimated ' + round(c.costUnits, 1) + ' ' + unit + ' stays under ' + round(lv * 100, 0) + '% of ' + round(alloc.totalUnits, 0) + '.' }
      : { ok: false, msg: 'Used ' + round(alloc.usedUnits, 0) + ' + estimated ' + round(c.costUnits, 1) + ' ' + unit + ' passes ' + round(lv * 100, 0) + '% of the ' + round(alloc.totalUnits, 0) + ' ' + unit + ' on ' + c.cluster.name + '.' };
  }
  return c.costUnits <= remaining
    ? { ok: true, msg: 'Estimated ' + round(c.costUnits, 1) + ' ' + unit + ' fits the ' + round(remaining, 0) + ' ' + unit + ' remaining on ' + c.cluster.name + ' (' + round((c.costUnits / Math.max(remaining, 1e-9)) * 100, 1) + '%).' }
    : { ok: false, msg: 'Estimated ' + round(c.costUnits, 1) + ' ' + unit + ' exceeds the ' + round(Math.max(0, remaining), 0) + ' ' + unit + ' remaining on ' + c.cluster.name + '.' };
}

function deadlineCheck(ctx, c) {
  if (ctx.deadlineMs == null) return { ok: true, msg: 'No deadline set.' };
  var left = (ctx.deadlineMs - ctx.now) / HOUR_MS;
  return c.meetsDeadline
    ? { ok: true, msg: '1.2 x runtime ' + fmtHours(c.duration) + ' finishes ' + fmtHours(c.slack) + ' before ' + ctx.deadlineLabel + '.' }
    : { ok: false, msg: '1.2 x runtime ' + fmtHours(c.duration) + ' = ' + fmtHours(c.finishHours) + ', but ' + ctx.deadlineLabel + ' is in ' + fmtHours(Math.max(0, left)) + '.' };
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
  var limitIssues = [];
  if (c.walltime > num(c.p.maxWalltimeHours, 1e9) + 1e-9) limitIssues.push('walltime ' + fmtHours(c.walltime) + ' > ' + fmtHours(num(c.p.maxWalltimeHours, 0)) + ' max');
  if (c.isGpu && c.gpus > num(c.p.maxGpusPerJob, 1e9)) limitIssues.push(c.gpus + ' GPUs > ' + c.p.maxGpusPerJob + ' per job');
  if (c.nodes > num(c.p.maxNodesPerJob, 1e9)) limitIssues.push(c.nodes + ' nodes > ' + c.p.maxNodesPerJob + ' per job');
  out.push({
    kind: 'PARTITION_LIMITS',
    title: 'Within published partition limits',
    severity: 'BLOCK',
    ok: !limitIssues.length,
    msg: limitIssues.length
      ? c.cluster.name + ' ' + (c.p.name || c.p.id) + ' (published limits: ' + fmtHours(num(c.p.maxWalltimeHours, 0)) + ', ' + (c.isGpu ? c.p.maxGpusPerJob + ' GPUs, ' : '') + c.p.maxNodesPerJob + ' node(s) per job): ' + limitIssues.join('; ') + '.'
      : (c.p.name || c.p.id) + ' allows ' + fmtHours(num(c.p.maxWalltimeHours, 0)) + (c.isGpu ? ', ' + c.p.maxGpusPerJob + ' GPUs' : '') + ' and ' + c.p.maxNodesPerJob + ' node(s) per job.',
  });
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
    if (!r.ok && pol.sourceUrl) r.msg += ' Source: ' + pol.sourceUrl;
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

/** MODEL_MAP quantile-model features for one option (API.md section 7). */
function modelFeatures(ctx, p, gpus) {
  var gpuType = p.gpuType ? ctx.gpuTypes[p.gpuType.id] : null;
  var isGpu = gpuType != null;
  var gpusPerNode = Math.max(1, num(p.gpusPerNode, 1));
  var coresPerNode = Math.max(1, num(p.coresPerNode, 64));
  var nodes = isGpu ? Math.ceil(gpus / gpusPerNode) : Math.max(1, gpus);
  var part = slurmPartitionName(p);
  var d = new Date(ctx.now);
  var hour = easternHour(ctx.now);
  var wall = ctx.req.requestedWalltimeHours ? Number(ctx.req.requestedWalltimeHours) : Math.min(num(p.maxWalltimeHours, 48), Math.max(1, (ctx.workP90 / Math.max(1, isGpu ? gpus : nodes * coresPerNode / 64)) * 1.2));
  return {
    partition: ANVIL_PARTITIONS.indexOf(part) >= 0 ? part : 'other',
    reqCpus: isGpu ? Math.floor(coresPerNode / gpusPerNode) * gpus : nodes * coresPerNode,
    reqNodes: nodes,
    reqMemGiB: isGpu ? Math.round((num(p.memPerNodeGb, 256) * Math.min(gpus, gpusPerNode)) / gpusPerNode) * nodes : num(p.memPerNodeGb, 256) * nodes,
    reqGpus: isGpu ? gpus : 0,
    walltimeHours: round(wall, 2),
    submitHour: hour,
    submitWeekday: (d.getUTCDay() + 6) % 7,
    submitMonth: d.getUTCMonth() + 1,
  };
}

/** Champion P50/P90 for every option, one batch call per model; null entries when an artifact is not loaded. */
function championPredictions(ctx, opts) {
  var feats = opts.map(function (o) {
    return modelFeatures(ctx, o.p, o.g);
  });
  var out = { runtime: null, mem: null, cpu: null, provenance: {} };
  [['runtime', 'AnvilRuntimeQ50Q90'], ['mem', 'AnvilHostMemoryQ50Q90'], ['cpu', 'AnvilTaskCPUQ50Q90']].forEach(function (m) {
    var r = plainJson(QuantileModel.predictBatch(m[1], feats));
    out.provenance[m[0]] = r.provenance;
    if (r.available && r.predictions) out[m[0]] = r.predictions;
  });
  return out;
}

/** Every modeled (partition, gpus) option with its rule results (ClusterPolicyEngine) and champion predictions. */
function allOptions(ctx, restrict) {
  var opts = [];
  candidatePartitions(ctx, restrict).forEach(function (p) {
    gpuOptions(ctx, p).forEach(function (g) {
      opts.push({ p: p, g: g });
    });
  });
  var preds = ctx.champions || (ctx.champions = championPredictions(ctx, opts));
  var predIndex = ctx.championIndex || (ctx.championIndex = {});
  if (!ctx.championKeys) {
    ctx.championKeys = true;
    opts.forEach(function (o, i) {
      predIndex[o.p.id + ':' + o.g] = i;
    });
  }
  var out = [];
  opts.forEach(function (o) {
    var i = predIndex[o.p.id + ':' + o.g];
    var q = null;
    if (i != null) {
      // trained on Anvil sacct history: used for Anvil partitions with enough support only (ml-trainer guidance)
      var onAnvil = String(o.p.cluster.id) == 'anvil';
      var usable = function (arr) {
        return arr && onAnvil && arr[i] && !arr[i].lowSupport ? arr[i] : null;
      };
      q = { runtime: usable(preds.runtime), mem: usable(preds.mem), cpu: usable(preds.cpu) };
    }
    var c = modelCandidate(ctx, o.p, o.g, q);
    if (c == null) return;
    c.results = evaluateCandidate(ctx, c);
    c.blocked = blocks(c.results).length > 0;
    out.push(c);
  });
  return out;
}

/** ClusterPolicyEngine provenance (versioned deterministic rules). */
function policyProvenance(ctx) {
  return { component: 'ClusterPolicyEngine', version: POLICY_VERSION, method: 'versioned deterministic rules (' + ctx.policies.length + ' active policies + built-in partition/account/memory checks); nothing waives them', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: ctx.policies.length, historicalOnly: false, computedAt: new Date(ctx.now).toISOString() };
}

/** Provenance of one option's duration / memory / CPU estimates: champion model or the labeled fallback. */
function estimateProvenance(ctx, c) {
  var pv = ctx.champions ? ctx.champions.provenance : {};
  var at = new Date(ctx.now).toISOString();
  var fallback = function (component, method, note, support) {
    return { component: component, version: 'fallback', method: method, status: 'FALLBACK_HEURISTIC', trainingPeriod: null, sampleSupport: support == null ? null : support, historicalOnly: true, computedAt: at, note: note };
  };
  var why = String(c.cluster.id) != 'anvil' ? 'Trained on Anvil only; ' + c.cluster.name + ' uses the heuristic.' : 'Too few similar Anvil jobs (or artifact not loaded); heuristic used.';
  var runtime = c.runtimeSource == 'model' && pv.runtime ? pv.runtime : fallback('AnvilRuntimeQ50Q90', 'history median of similar completed jobs scaled by GPU throughput and model size', why, ctx.prediction ? num(ctx.prediction.sampleSize, null) : null);
  var mem = c.memSource == 'model' && pv.mem ? pv.mem : fallback('AnvilHostMemoryQ50Q90', 'node memory proportional to GPUs requested', why, null);
  var cpu = c.cpuEvidence && pv.cpu ? pv.cpu : fallback('AnvilTaskCPUQ50Q90', 'cores proportional to GPUs requested', why, null);
  return [runtime, mem, cpu];
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
  var policyProv = policyProvenance(ctx);
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
      provenance: policyProv,
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
        provenance: policyProv,
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
  // a lab rule that asks for PI approval (e.g. runs above 500 GPU-hours) holds submission when every otherwise
  // feasible option violates it
  var approvalRule = null;
  feasible.forEach(function (c, idx) {
    c.results.forEach(function (r) {
      var pol = r.policy;
      if (r.ok || r.severity == 'INFO' || pol == null) return;
      if (!/approv/i.test(String(pol.title || '') + ' ' + String(pol.description || '') + ' ' + String(pol.limitText || ''))) return;
      var all = feasible.every(function (o) {
        return o.results.some(function (x) {
          return x.key == r.key && !x.ok;
        });
      });
      if (all && approvalRule == null) approvalRule = { r: r, firstFailMsg: r.msg };
    });
  });
  var approval = req.approvalStatus == 'APPROVED' || req.approvalStatus == 'REJECTED' ? String(req.approvalStatus) : approvalRule ? 'PENDING' : 'NOT_REQUIRED';
  var upd = { id: req.id, status: req.approvalStatus == 'REJECTED' ? 'REJECTED' : status, approvalStatus: approval };
  if (approval == 'PENDING') upd.approvalReason = (approvalRule.r.policy.id || '') + ' ' + approvalRule.r.title + ': ' + approvalRule.firstFailMsg;
  RunRequest.make(upd).merge();
  log.info('checkRules {}: {} checks, {} of {} options feasible -> {}', req.id, rows.length, feasible.length, everything.length, status);

  return list(RuleCheck.fetch({ filter: Filter.eq('runRequest.id', req.id), limit: 200 }).objs).sort(function (a, b) {
    return SEVERITY_ORDER[a.outcome] - SEVERITY_ORDER[b.outcome];
  });
}

// ---------------------------------------------------------------- recommendPlans

/** Module lines per cluster, following the RCAC user guides (module trees, ROCm on Negishi's MI210 nodes). */
function moduleLines(cid, c, wt, env) {
  var L = [];
  var sim = wt == 'SIMULATION';
  if (cid == 'aws-p4d') {
    L.push('source ~/miniconda3/etc/profile.d/conda.sh   # ParallelCluster DLAMI: no Lmod modules');
    L.push(sim ? 'export PATH=/opt/gromacs/bin:$PATH' : 'conda activate ' + env);
    return L;
  }
  L.push('module purge');
  if (cid == 'anvil') L.push(c.isGpu ? 'module load modtree/gpu' : 'module load modtree/cpu');
  if (sim) {
    L.push(c.isGpu && cid == 'negishi' ? 'module load rocm gromacs' : 'module load gromacs');
    return L;
  }
  if (c.isGpu) L.push(cid == 'negishi' ? 'module load rocm' : 'module load cuda');
  L.push('module load conda');
  L.push('conda activate ' + env);
  return L;
}

function sbatchScript(ctx, c, label) {
  var req = ctx.req;
  var cid = String(c.cluster.id);
  var name = slug(req.name);
  var account = chooseAccount(ctx, c.cluster, c.isGpu);
  var qos = partitionQos(c.p);
  var part = slurmPartitionName(c.p);
  var gpn = c.isGpu ? Math.min(c.gpus, num(c.p.gpusPerNode, 1)) : 0;
  var gpusPerNode = Math.max(1, num(c.p.gpusPerNode, 1));
  var coresPerNode = num(c.p.coresPerNode, 64);
  var cpt = c.isGpu ? Math.max(1, Math.floor(coresPerNode / gpusPerNode)) : 1;
  var mem = Math.round(c.memRequestGb);
  var checkpointing = c.p.preemptible || c.chained > 1 || c.walltime > 4;
  var rcac = c.cluster.billing == 'IN_HOUSE_NODE_SHARE'; // RCAC community clusters: account + partition + QOS on every job
  var scratch = cid == 'anvil' ? '$SCRATCH' : cid == 'aws-p4d' ? '/fsx' : '$RCAC_SCRATCH';
  var wt = String(req.workloadType || '');
  var L = [];
  L.push('#!/bin/bash');
  L.push('# EasyCompute plan "' + label + '" for "' + (req.name || req.id) + '" (' + (ctx.lab.name || ctx.labId) + ')');
  L.push('# ' + (c.isGpu ? c.gpus + ' x ' + c.gpuType.id : c.nodes + ' node(s), ' + c.nodes * coresPerNode + ' cores') + ' on ' + c.cluster.name + ' ' + (c.p.name || c.p.id) +
    ' | predicted runtime ' + fmtHours(c.duration) + ' | est. cost ' + round(c.costUnits, 1) + ' ' + (c.cluster.unitName || 'units') + ' ($' + round(c.costUsd, 2) + ')');
  if (rcac) L.push('# RCAC requires account (-A), partition (-p) and QOS (-q) on every job' + (cid == 'gilbreth' ? ', plus an explicit --mem on Gilbreth' : '') + '.');
  if (cid == 'anvil') L.push('# Anvil: GPU partitions are charged to the "-gpu" allocation account; no QOS flag.');
  L.push('#SBATCH --job-name=' + name);
  L.push('#SBATCH -A ' + account);
  L.push('#SBATCH -p ' + part);
  if (rcac) L.push('#SBATCH -q ' + qos);
  L.push('#SBATCH --nodes=' + c.nodes);
  if (c.isGpu) {
    L.push('#SBATCH --ntasks-per-node=' + gpn);
    L.push(cid == 'gilbreth' ? '#SBATCH --gres=gpu:' + gpn : '#SBATCH --gpus-per-node=' + gpn);
    L.push('#SBATCH --cpus-per-task=' + cpt);
  } else {
    L.push('#SBATCH --ntasks-per-node=' + coresPerNode);
    if (cid == 'anvil' && part == 'wholenode') L.push('#SBATCH --exclusive');
  }
  L.push('#SBATCH --mem=' + mem + 'G');
  L.push('#SBATCH --time=' + slurmTime(c.walltime));
  if (c.chained > 1) L.push('#SBATCH --array=1-' + c.chained + '%1            # ' + c.chained + ' chained jobs, one at a time, each resumes from the last checkpoint');
  if (checkpointing) L.push('#SBATCH --signal=B:USR1@600       # 10 min warning before preemption/timeout -> checkpoint');
  if (c.p.preemptible || c.chained > 1) L.push('#SBATCH --requeue');
  L.push('#SBATCH --mail-type=BEGIN,END,FAIL,TIME_LIMIT_80');
  if (ctx.req.submittedBy && ctx.req.submittedBy.username) L.push('#SBATCH --mail-user=' + ctx.req.submittedBy.username + '@purdue.edu');
  L.push('#SBATCH -o %x-%j.out');
  L.push('');
  L.push('set -euo pipefail');
  moduleLines(cid, c, wt, name).forEach(function (l) {
    L.push(l);
  });
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
    L.push('srun python process.py --input "' + scratch + '/' + name + '/raw" --output "' + scratch + '/' + name + '/processed" &');
  } else if (wt == 'INFERENCE') {
    L.push('srun python infer.py --model "' + scratch + '/' + name + '/checkpoints" --tensor-parallel ' + Math.max(1, c.gpus) + ' --batch-size 32 &');
  } else if (wt == 'INTERACTIVE') {
    L.push('jupyter lab --no-browser --ip=0.0.0.0 --port=$((8000 + RANDOM % 1000)) &   # or use Open OnDemand');
  } else {
    L.push('srun torchrun --nnodes=$SLURM_NNODES --nproc_per_node=' + Math.max(1, gpn) + ' \\');
    L.push('  --rdzv_backend=c10d --rdzv_endpoint=$(hostname):29500 \\');
    L.push('  train.py --config configs/' + name + '.yaml --ckpt-dir "' + scratch + '/' + name + '/ckpt" --resume-from latest --save-every-min 30 &');
  }
  L.push('wait');
  return L.join('\n');
}

function rationale(ctx, c, label, best) {
  var parts = [];
  var hw = c.isGpu ? c.gpus + ' x ' + c.gpuType.id : c.nodes + ' CPU node(s)';
  var fastest = c.finishHours <= best.finish + 1e-9;
  var cheapest = c.costUsd <= best.cost + 1e-9;
  var why;
  if (fastest && cheapest) why = 'Both the earliest finish and the lowest cost of all ' + best.n + ' compliant options.';
  else if (label == 'Fastest') why = fastest ? 'Earliest expected finish of all ' + best.n + ' compliant options.' : 'Fastest alternative to the plans above.';
  else if (label == 'Cheapest') why = cheapest ? 'Lowest cost of all ' + best.n + ' compliant options.' : 'Cheapest alternative to the plans above.';
  else why = 'Best trade-off of finish time, cost, deadline slack and risk.';
  parts.push(why + ' Runs ' + hw + ' on ' + c.cluster.name + ' ' + (c.p.name || c.p.id) + ' (' + partitionQos(c.p) + ' QOS): predicted runtime ' + fmtHours(c.duration) +
    (c.chained > 1 ? ' as ' + c.chained + ' chained ' + fmtHours(c.walltime) + ' jobs with checkpoints' : '') + '; starts as soon as you launch.');
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

  var minF = Infinity;
  var minC = Infinity;
  options.forEach(function (c) {
    minF = Math.min(minF, c.finishHours);
    minC = Math.min(minC, c.costUsd);
  });
  var preferred = csv(ctx.lab.preferredClusters);
  var fair = plainJson(LabFairShareAllocator.projectWeights(ctx.labId, req.project ? String(req.project.id) : null));
  var shift = num(fair.costWeightShift, 0);
  options.forEach(function (c) {
    // log ratios to the best option (0 = best, 1 = 4x worse or more): small absolute gaps stay small
    var f = Math.min(1, Math.log(Math.max(c.finishHours, 0.01) / Math.max(minF, 0.01)) / Math.log(4));
    var k = Math.min(1, Math.log((c.costUsd + 1) / (minC + 1)) / Math.log(4));
    var s = 100 * (1 - ((0.45 - shift) * f + (0.3 + shift) * k + 0.15 * c.preemptionRisk + 0.1 * Math.min(1, warns(c.results).length / 3)));
    if (c.shape && c.shape.fit == 'POOR') s -= 8;
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
  var policyProv = policyProvenance(ctx);
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
      estWaitHours: 0,
      estDurationHours: round(c.duration, 2),
      estCostUnits: round(c.costUnits, 2),
      estCostUsd: round(c.costUsd, 2),
      meetsDeadline: c.meetsDeadline,
      score: round(c.score, 1),
      rationale: rationale(ctx, c, pk.label, { finish: minF, cost: minC, n: options.length }),
      sbatchScript: sbatchScript(ctx, c, pk.label),
      qos: partitionQos(c.p),
      account: chooseAccount(ctx, c.cluster, c.isGpu),
      slurmPartition: slurmPartitionName(c.p),
      waitBucket: null,
      waitReason: null,
      chainedJobs: c.chained,
      preemptionRisk: round(c.preemptionRisk, 3),
      gpuMemNeedGb: round(ctx.memNeedGb, 1),
      costPerGpuHourUsd: c.usdPerGpuHour == null ? null : round(c.usdPerGpuHour, 3),
      finishBy: toDt(ctx.now + c.finishHours * HOUR_MS),
      deadlineSlackHours: c.slack == null ? null : round(c.slack, 1),
      ruleWarnings: warns(c.results).length,
      estDurationP90Hours: round(c.durationP90, 2),
      estWaitP90Hours: 0,
      memRequestGb: round(c.memRequestGb, 0),
      cpuEvidence: c.cpuEvidence,
      shapeReason: c.shape ? 'GPUShapeAdvisor (' + c.shape.fit + '): ' + c.shape.reason : c.isGpu ? null : 'CPU-only work: no GPU requested.',
      provenance: [policyProv, ctx.shapeAdvice.provenance].concat(estimateProvenance(ctx, c)).concat([fair.provenance]),
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

function submit(planId) {
  var req = RunRequest.make({ id: this.id }).get('this, lab.this, project, submittedBy.this');
  if (req == null) throw new Error('RunRequest ' + this.id + ' not found');
  var plan = RunPlan.make({ id: planId }).get('this, cluster.this, partition.this, gpuType.this');
  if (plan == null || plan.runRequest == null || plan.runRequest.id != req.id) throw new Error('RunPlan ' + planId + ' is not a plan of RunRequest ' + req.id);
  if (req.status == 'SUBMITTED') throw new Error('RunRequest ' + req.id + ' was already submitted');
  if (req.approvalStatus == 'PENDING') throw new Error('RunRequest ' + req.id + ' needs PI approval before it can be submitted (' + (req.approvalReason || 'lab rule') + '). Approve it with UserAdmin.approve("RR:' + req.id + '").');
  if (req.approvalStatus == 'REJECTED') throw new Error('RunRequest ' + req.id + ' was rejected by ' + (req.approvedBy || 'the PI') + '.');

  var now = Date.now();
  var clusterId = String(plan.cluster.id);
  var slurmJobId = nextSlurmJobId(clusterId);
  var jobId = clusterId + '-' + slurmJobId;
  var gpus = num(plan.gpus, 0);
  var nodes = Math.max(1, num(plan.nodes, 1));
  var p = plan.partition;
  var gpusPerNode = Math.max(1, num(p.gpusPerNode, 1));
  var cores = gpus > 0 ? Math.floor(num(p.coresPerNode, 64) / gpusPerNode) * gpus : nodes * num(p.coresPerNode, 64);
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
    // no queue: the run starts immediately; RunMonitor.startJob assigns nodes and writes the first samples
    state: 'RUNNING',
    submitTime: toDt(now),
    startTime: toDt(now),
    simScenario: 'HEALTHY',
    timelimitHours: num(plan.walltimeHours, 4),
    elapsedHours: 0,
    allocCpus: cores,
    allocNodes: nodes,
    allocGpus: gpus,
    gpuType: plan.gpuType ? { id: plan.gpuType.id } : null,
    reqMemGb: gpus > 0 ? Math.round((num(p.memPerNodeGb, 256) * Math.min(gpus, gpusPerNode)) / gpusPerNode * 0.9) * nodes : Math.round(num(p.memPerNodeGb, 256) * 0.9) * nodes,
    costUnits: 0,
    costUsd: 0,
    isLive: true,
    nodeList: null,
    exitCode: null,
  }).create();
  var started = RunMonitor.startJob(jobId);

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
    detail: 'Submitted plan "' + plan.label + '" (' + plan.id + '): ' + cmd + ' -> Submitted batch job ' + slurmJobId + ' (running on ' + started.nodeList + ').',
    outcome: 'DONE',
  }).create();
  log.info('submit {}: plan {} -> job {}', req.id, plan.id, jobId);
  return Job.make({ id: jobId }).get(
    'id, slurmJobId, lab.id, project.id, runRequest.id, user, cluster.id, partition.id, account, qos, jobName, workloadType, state, submitTime, timelimitHours, elapsedHours, allocCpus, allocNodes, allocGpus, gpuType.id, reqMemGb, costUnits, costUsd, isLive, startTime, nodeList, latestSample, simScenario'
  );
}
