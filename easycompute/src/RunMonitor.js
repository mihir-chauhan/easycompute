/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('RunMonitor');

var STEP_MIN = 15;
var MIN_MS = 60 * 1000;
var HOUR_MS = 60 * MIN_MS;

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

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Deterministic pseudo-random number in [0, 1) from a string (FNV-1a). */
function rand(key) {
  var h = 2166136261;
  for (var i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return (h % 100000) / 100000;
}

function tdpFor(gpuTypeId) {
  var g = String(gpuTypeId || '');
  if (/H100/.test(g)) return 700;
  if (/A100/.test(g)) return 400;
  if (/L40S/.test(g)) return 350;
  if (/MI210/.test(g)) return 300;
  if (/V100/.test(g)) return 300;
  return 165;
}

/** A node name in the cluster's naming scheme (same rules as RunRequest#submit). */
function nodeName(p, i) {
  if (p == null) return 'node' + i;
  var cid = p.cluster ? String(p.cluster.id) : '';
  var part = String(p.slurmPartition || p.name || '').toLowerCase();
  var gt = p.gpuType ? String(p.gpuType.id) : '';
  var letter;
  if (cid == 'aws-p4d') return (p.preemptible ? 'p4d-sp-' : 'p4d-dy-') + (1 + (i % Math.max(1, num(p.nodeCount, 4))));
  if (cid == 'gilbreth') letter = { 'a100-80gb': 'k', 'a100-40gb': 'n', a10: 'h', a30: 'b', h100: 'l', training: 'j' }[part] || 'k';
  else if (cid == 'gautschi') letter = part == 'ai' ? 'h' : part == 'smallgpu' ? 'g' : part == 'highmem' ? 'b' : 'a';
  else if (cid == 'negishi') letter = part == 'gpu' ? 'g' : part == 'highmem' ? 'b' : 'a';
  else if (cid == 'anvil') letter = /H100/.test(gt) ? 'h' : gt ? 'g' : part == 'highmem' ? 'b' : 'a';
  else letter = 'a';
  var n = String(1 + (i % Math.max(1, num(p.nodeCount, 20))));
  while (n.length < 3) n = '0' + n;
  return (cid == 'anvil' ? '' : cid + '-') + letter + n;
}

/**
 * Next sample from the last two: each metric continues half of its last change plus bounded noise, so scripted
 * issues (idle GPUs, rising memory, stale checkpoints) persist, while healthy jobs keep fluctuating. A small,
 * deterministic chance starts a data-loader stall on a healthy job.
 */
function nextSample(job, prev, last, k, t) {
  var key = job.id + ':' + k;
  var gpus = num(job.allocGpus, 0);
  var r = function (name, amp) {
    return (rand(key + ':' + name) - 0.5) * 2 * amp;
  };
  var step = function (name, amp, lo, hi, damp) {
    var v = num(last[name], 0);
    var d = prev ? (v - num(prev[name], 0)) * (damp == null ? 0.5 : damp) : 0;
    return clamp(v + clamp(d, -amp * 2, amp * 2) + r(name, amp), lo, hi);
  };
  var hung = num(last.gpuUtilPct, 0) < 2 && num(last.cpuUtilPct, 0) < 3;
  var idle = gpus > 0 && num(last.gpuUtilPct, 0) < 5;
  var s = {
    id: job.id + '-m' + t,
    job: { id: job.id },
    ts: toDt(t),
  };
  if (hung) {
    s.gpuUtilPct = 0;
    s.cpuUtilPct = round(clamp(num(last.cpuUtilPct, 0) + r('cpu', 0.5), 0, 2.5), 1);
    s.gpuMemPct = num(last.gpuMemPct, 0);
    s.memPct = num(last.memPct, 0);
    s.ioReadMBps = 0;
    s.ioWriteMBps = 0;
    s.powerW = gpus > 0 ? Math.round(gpus * 62) : 0;
    s.trainingLoss = last.trainingLoss;
  } else {
    s.gpuUtilPct = gpus > 0 ? round(idle ? clamp(num(last.gpuUtilPct, 0) + r('gpu', 1.5), 0, 4.5) : step('gpuUtilPct', 6, 5, 99), 1) : 0;
    s.gpuMemPct = gpus > 0 ? round(step('gpuMemPct', 1.2, 1, 99.5, 0.8), 1) : 0;
    s.cpuUtilPct = round(step('cpuUtilPct', 5, 3, 100), 1);
    s.memPct = round(step('memPct', 1.2, 1, 99.5, 0.6), 1);
    s.ioReadMBps = round(Math.max(0, num(last.ioReadMBps, 0) * (1 + r('ior', 0.15))), 1);
    s.ioWriteMBps = round(Math.max(0, num(last.ioWriteMBps, 0) > 100 ? 5 + r('iow', 2) : num(last.ioWriteMBps, 0) * (1 + r('iow', 0.2))), 1);
    var stall = !idle && gpus > 0 && s.gpuUtilPct > 50 && rand(key + ':stall') < 0.03;
    if (stall) s.gpuUtilPct = round(18 + r('stall2', 5), 1);
    var tdp = tdpFor(job.gpuType && job.gpuType.id);
    s.powerW = gpus > 0 ? Math.round(gpus * (60 + ((tdp - 60) * s.gpuUtilPct) / 100) * (1 + r('pw', 0.03))) : 0;
    s.trainingLoss = last.trainingLoss == null ? null : round(Math.max(0.05, num(last.trainingLoss, 0) * (1 - 0.006 * (s.gpuUtilPct / 100)) + r('loss', 0.004)), 4);
  }
  s.checkpointAgeMin = num(last.checkpointAgeMin, 0) + STEP_MIN;
  return s;
}

/** Checkpoint period the job has shown (minutes), or null when it has not checkpointed recently. */
function checkpointPeriod(samples) {
  var maxAge = null;
  for (var i = 1; i < samples.length; i++) {
    var a = num(samples[i - 1].checkpointAgeMin, 0);
    var b = num(samples[i].checkpointAgeMin, 0);
    if (b < a) maxAge = Math.max(maxAge || 0, a);
  }
  return maxAge;
}

function tick() {
  var now = Date.now();
  var jobs = [];
  Job.fetchObjStream({
    filter: Filter.eq('isLive', true).and().intersects('state', ['RUNNING', 'PENDING']),
    include: 'this, lab.this, project.priority, cluster.this, partition.this, gpuType.this, runRequest.chosenPlan.estDurationHours',
  }).each(function (j) {
    jobs.push(j);
  });

  var metricsByJob = {};
  var running = jobs.filter(function (j) {
    return j.state == 'RUNNING';
  });
  running.forEach(function (j) {
    metricsByJob[j.id] = list(JobMetric.fetch({ filter: Filter.eq('job.id', j.id), order: 'descending(ts)', limit: 16 }).objs).reverse();
  });
  // simulated clock: one step after the newest live sample (never behind real time minus one step)
  var clock = now - STEP_MIN * MIN_MS;
  running.forEach(function (j) {
    var m = metricsByJob[j.id];
    if (m.length) clock = Math.max(clock, ms(m[m.length - 1].ts));
  });
  var simTo = clock + STEP_MIN * MIN_MS;

  var allocs = {};
  list(Allocation.fetch({ filter: Filter.intersects('lab.id', jobs.map(function (j) { return j.lab ? j.lab.id : ''; })), limit: 1000 }).objs).forEach(function (a) {
    var key = a.lab.id + '|' + a.cluster.id;
    if (allocs[key] == null || ms(a.endDate) > ms(allocs[key].endDate)) allocs[key] = { id: a.id, usedUnits: num(a.usedUnits, 0), endDate: a.endDate, delta: 0 };
  });

  var newMetrics = [];
  var jobUpdates = [];
  var started = [];
  var finished = [];
  var stillRunning = [];

  jobs.forEach(function (j) {
    if (j.state == 'PENDING') {
      var waitH = num(j.partition && j.partition.avgWaitHours, 0.5);
      var queuedH = (simTo - ms(j.submitTime)) / HOUR_MS;
      if (queuedH >= waitH || rand(j.id + ':start:' + Math.floor(simTo / HOUR_MS)) < STEP_MIN / 60 / Math.max(0.25, waitH)) {
        var nodes = Math.max(1, num(j.allocNodes, 1));
        var names = [];
        for (var n = 0; n < nodes; n++) names.push(nodeName(j.partition, Math.floor(rand(j.id + ':node') * 90) + n));
        jobUpdates.push({ id: j.id, state: 'RUNNING', startTime: toDt(simTo - STEP_MIN * MIN_MS), nodeList: j.nodeList || names.join(',') });
        var gpus = num(j.allocGpus, 0);
        var wt = String(j.workloadType || '');
        newMetrics.push({
          id: j.id + '-m' + simTo,
          job: { id: j.id },
          ts: toDt(simTo),
          gpuUtilPct: gpus > 0 ? 62 : 0,
          gpuMemPct: gpus > 0 ? 55 : 0,
          cpuUtilPct: 60,
          memPct: 35,
          ioReadMBps: 420,
          ioWriteMBps: 4,
          powerW: gpus > 0 ? Math.round(gpus * (60 + (tdpFor(j.gpuType && j.gpuType.id) - 60) * 0.62)) : 0,
          checkpointAgeMin: STEP_MIN,
          trainingLoss: wt == 'TRAINING' || wt == 'FINETUNE' ? 2.9 : null,
        });
        started.push(j.id);
      }
      return;
    }

    var samples = metricsByJob[j.id];
    var last = samples[samples.length - 1];
    var prev = samples.length > 1 ? samples[samples.length - 2] : null;
    var endT = simTo;

    // a node that stopped reporting last step fails the job now
    if (last && num(j.allocGpus, 0) > 0 && num(last.powerW, 1) === 0 && num(last.gpuUtilPct, 1) === 0 && prev && num(prev.powerW, 0) > 0) {
      jobUpdates.push({ id: j.id, state: 'FAILED', endTime: toDt(endT), exitCode: '0:9' });
      finished.push({ jobId: j.id, state: 'FAILED' });
      return;
    }

    var elapsed = num(j.elapsedHours, 0) + STEP_MIN / 60;
    var limit = num(j.timelimitHours, 1e9);
    var planned = j.runRequest && j.runRequest.chosenPlan ? num(j.runRequest.chosenPlan.estDurationHours, null) : null;
    var s = null;
    if (last) {
      s = nextSample(j, prev, last, samples.length + Math.round(num(j.elapsedHours, 0) * 4), simTo);
      var period = checkpointPeriod(samples);
      if (period != null && s.checkpointAgeMin > period) {
        s.checkpointAgeMin = 0;
        s.ioWriteMBps = round(600 + rand(j.id + ':ck' + simTo) * 400, 1);
      }
      newMetrics.push(s);
    }
    var util = s ? s.gpuUtilPct : num(j.gpuUtilAvg, 0);
    var oldElapsed = num(j.elapsedHours, 0);
    var avgUtil = elapsed > 0 ? (num(j.gpuUtilAvg, util) * oldElapsed + util * (STEP_MIN / 60)) / elapsed : util;

    // cost of this step
    var gpus2 = num(j.allocGpus, 0);
    var factor = num(j.partition && j.partition.chargeFactor, 1);
    var units = (gpus2 > 0 ? gpus2 : num(j.allocCpus, 1)) * (STEP_MIN / 60) * factor;
    if (j.cluster && String(j.cluster.unitName) == 'USD') units = units * num(j.gpuType && j.gpuType.costPerGpuHourUsd, 1);
    var usd = units * num(j.cluster && j.cluster.usdPerUnit, 1);
    var akey = (j.lab ? j.lab.id : '') + '|' + (j.cluster ? j.cluster.id : '');
    if (allocs[akey]) allocs[akey].delta += units;

    var upd = {
      id: j.id,
      elapsedHours: round(Math.min(elapsed, limit), 4),
      allocGpus: j.allocGpus,
      gpuUtilAvg: round(avgUtil, 2),
      costUnits: round(num(j.costUnits, 0) + units, 3),
      costUsd: round(num(j.costUsd, 0) + usd, 3),
    };
    if (planned != null && elapsed >= planned) {
      upd.state = 'COMPLETED';
      upd.endTime = toDt(endT);
      upd.exitCode = '0:0';
      finished.push({ jobId: j.id, state: 'COMPLETED' });
    } else if (elapsed >= limit) {
      upd.state = 'TIMEOUT';
      upd.endTime = toDt(endT);
      upd.exitCode = '0:15';
      finished.push({ jobId: j.id, state: 'TIMEOUT' });
    } else {
      stillRunning.push(j);
    }
    jobUpdates.push(upd);
  });

  if (newMetrics.length) JobMetric.createBatch(newMetrics.map(function (m) { return JobMetric.make(m); }));
  if (jobUpdates.length) Job.mergeBatch(jobUpdates.map(function (u) { return Job.make(u); }));
  var allocUpdates = Object.keys(allocs)
    .filter(function (k) {
      return allocs[k].delta > 0;
    })
    .map(function (k) {
      return Allocation.make({ id: allocs[k].id, usedUnits: round(allocs[k].usedUnits + allocs[k].delta, 3) });
    });
  if (allocUpdates.length) Allocation.mergeBatch(allocUpdates);

  // finished jobs: close their alerts
  finished.forEach(function (f) {
    Job.make({ id: f.jobId }).evaluateHealth();
  });

  // health + autopilot
  var newAlerts = [];
  var actions = [];
  var resolvedAlerts = [];
  var policies = {};
  stillRunning.concat(
    jobs.filter(function (j) {
      return started.indexOf(j.id) >= 0;
    })
  ).forEach(function (j) {
    var before = {};
    list(JobAlert.fetch({ filter: Filter.eq('job.id', j.id).and().intersects('status', ['OPEN', 'ACKED']), include: 'alertType', limit: 50 }).objs).forEach(function (a) {
      before[a.id] = true;
    });
    var alerts = list(Job.make({ id: j.id }).evaluateHealth());
    var after = {};
    alerts.forEach(function (a) {
      after[a.id] = true;
      if (!before[a.id]) newAlerts.push({ id: a.id, jobId: j.id, alertType: a.alertType, severity: a.severity, message: a.message });
    });
    Object.keys(before).forEach(function (id) {
      if (!after[id]) resolvedAlerts.push(id);
    });

    var labId = j.lab ? j.lab.id : null;
    if (!labId) return;
    if (policies[labId] === undefined) policies[labId] = AutopilotPolicy.make({ id: labId }).get('this');
    var ap = policies[labId];
    if (ap == null || !ap.enabled) return;

    var done = {};
    var act = function (type, alert) {
      if (done[type] || done.CANCEL) return;
      done[type] = true;
      var entry = Job.make({ id: j.id }).applyAction(type, 'AUTOPILOT');
      actions.push({ id: entry.id, jobId: j.id, labId: labId, alertId: alert ? alert.id : null, actionType: type, outcome: entry.outcome, detail: entry.detail });
    };
    var priority = j.project ? num(j.project.priority, 2) : 2;
    alerts.forEach(function (a) {
      if (a.autoActionTaken) return;
      var t = String(a.alertType);
      var acted = true;
      if ((t == 'IDLE_GPU' || t == 'HUNG_JOB') && a.severity == 'CRITICAL') act('CANCEL', a);
      else if (t == 'WALLTIME_RISK' && num(ap.checkpointBeforeTimeoutMin, 0) > 0) {
        act('CHECKPOINT_NOW', a);
        if (ap.autoExtendWalltime && a.recommendedAction == 'EXTEND_WALLTIME') act('EXTEND_WALLTIME', a);
      } else if ((t == 'PREEMPTION_RISK' || t == 'STALE_CHECKPOINT' || t == 'OOM_RISK') && num(ap.checkpointBeforeTimeoutMin, 0) > 0) act('CHECKPOINT_NOW', a);
      else if (t == 'LOW_GPU_UTIL' && ap.requeueToStandbyOnLowPriority && priority >= 3) act('REQUEUE_STANDBY', a);
      else if (t == 'NODE_FAILURE') act('REQUEUE_STANDBY', a);
      else acted = false;
      if (a.severity == 'CRITICAL' && ap.notifyPiOnCritical && !before[a.id]) {
        act('NOTIFY_PI', a);
        acted = true;
      }
      if (acted) JobAlert.make({ id: a.id, autoActionTaken: true }).merge();
    });
  });

  var openAlerts = JobAlert.fetchCount({ filter: Filter.intersects('status', ['OPEN', 'ACKED']) });
  var liveJobs = Job.fetchCount({ filter: Filter.eq('isLive', true).and().intersects('state', ['RUNNING', 'PENDING']) });
  log.info('tick to {}: {} jobs advanced, {} started, {} finished, {} new alerts, {} autopilot actions', new Date(simTo).toISOString(), stillRunning.length, started.length, finished.length, newAlerts.length, actions.length);
  return {
    simulatedTo: new Date(simTo).toISOString(),
    stepMinutes: STEP_MIN,
    advanced: running.length,
    started: started,
    finished: finished,
    newAlerts: newAlerts,
    resolvedAlerts: resolvedAlerts,
    actions: actions,
    openAlerts: openAlerts,
    liveJobs: liveJobs,
  };
}
