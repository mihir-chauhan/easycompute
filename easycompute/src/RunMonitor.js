/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/*
 * Live cluster simulator (SPEC "LIVE CLUSTER SIMULATION", API.md section 8). Timestamps are real wall-clock time; job
 * progress runs at demoTimeScale x real time; queue waits are compressed by queueWaitCompression. Everything is seeded
 * by job / partition id and timestamp, so the same inputs always produce the same telemetry.
 */

var log = Logger.for('RunMonitor');

var MIN_MS = 60 * 1000;
var HOUR_MS = 60 * MIN_MS;
var DEFAULTS = { enabled: true, demoTimeScale: 10, queueWaitCompression: 60, sampleIntervalSec: 20, maxCatchUpMin: 10, maxSamplesPerJob: 360, respawnScriptedJobs: true };
var MAX_SAMPLES_PER_TICK = 30;
var THIN_JOBS_PER_TICK = 3;
var ENDED_VISIBLE_MS = 10 * MIN_MS;
var TRAINING = ['TRAINING', 'FINETUNE'];

// ---------------------------------------------------------------- helpers

function ms(v) {
  return v == null ? null : Date.parse(String(v));
}

function iso(t) {
  return t == null || !isFinite(t) ? null : new Date(t).toISOString();
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

function plainJson(v) {
  if (v == null) return v;
  if (typeof v === 'string') return JSON.parse(v);
  if (typeof v.type === 'string' && /^Boxed/.test(v.type) && v.value != null) return v.value;
  return v;
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

/** Symmetric noise in [-amp, amp]. */
function noise(key, amp) {
  return (rand(key) - 0.5) * 2 * amp;
}

function tdpFor(gpuTypeId) {
  var g = String(gpuTypeId || '');
  if (/H100/.test(g)) return 700;
  if (/A100/.test(g)) return 400;
  if (/L40S/.test(g)) return 350;
  if (/MI210|V100/.test(g)) return 300;
  return 165;
}

function settings() {
  var s = RunSimulatorSettings.make({ id: 'default' }).get('this');
  var out = {};
  Object.keys(DEFAULTS).forEach(function (k) {
    out[k] = s != null && s[k] != null ? s[k] : DEFAULTS[k];
  });
  out.lastTickAt = s != null ? ms(s.lastTickAt) : null;
  return out;
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

// ---------------------------------------------------------------- telemetry profiles

/** Scenario of a seeded live job, inferred once from its recent telemetry (HEALTHY for new runs). */
function inferScenario(job, samples) {
  if (!samples.length) return 'HEALTHY';
  var gpus = num(job.allocGpus, 0);
  var last = samples[samples.length - 1];
  var prev = samples.length > 1 ? samples[samples.length - 2] : null;
  var avg = function (f) {
    return samples.reduce(function (s, x) { return s + num(x[f], 0); }, 0) / samples.length;
  };
  var resets = 0;
  for (var i = 1; i < samples.length; i++) if (num(samples[i].checkpointAgeMin, 0) < num(samples[i - 1].checkpointAgeMin, 0)) resets++;
  if (gpus > 0 && num(last.powerW, 1) === 0 && num(last.gpuUtilPct, 1) === 0 && prev && num(prev.powerW, 0) > 0) return 'NODE_FAILURE';
  if (num(last.gpuUtilPct, 0) < 2 && num(last.cpuUtilPct, 0) < 3) return 'HUNG';
  if (gpus > 0 && num(last.gpuUtilPct, 0) < 5) return 'IDLE_GPU';
  if (gpus > 0 && num(last.gpuMemPct, 0) >= 88 && num(last.gpuMemPct, 0) - num(samples[0].gpuMemPct, 0) > 3) return 'OOM_CREEP';
  if (gpus > 0 && avg('gpuUtilPct') < 45) return 'LOW_UTIL';
  if (num(last.checkpointAgeMin, 0) > 120 && resets === 0) return 'STALE_CHECKPOINT';
  if (num(job.timelimitHours, 0) - num(job.elapsedHours, 0) < 2) return 'WALLTIME_RISK';
  return 'HEALTHY';
}

/**
 * Next telemetry sample. `prev` is the last sample (or null when the job just started), `prog` the job progress in
 * minutes at this sample, `dProg` the progress since `prev`. Values move continuously from `prev` toward the workload's
 * profile; scenarios override the profile.
 */
function nextSample(job, scenario, prev, prog, dProg, t, failAt) {
  var key = job.id + ':' + Math.floor(t / 1000);
  var h = rand(job.id + ':profile');
  var gpus = num(job.allocGpus, 0);
  var wt = String(job.workloadType || 'TRAINING');
  var pv = function (f, d) {
    return prev ? num(prev[f], d) : d;
  };
  var smooth = function (from, to, rate) {
    return from + (to - from) * (1 - Math.exp(-dProg / rate));
  };
  var util;
  var mem;
  var cpu;
  var hostMem;
  var ioR;
  var ioW = 3 + noise(key + ':iow', 2);
  var loss = prev ? prev.trainingLoss : TRAINING.indexOf(wt) >= 0 ? round(2.4 + 0.6 * h, 3) : null;
  var period = wt == 'SIMULATION' ? 15 : 30 + Math.round(30 * h);
  var ckpt = pv('checkpointAgeMin', 0) + dProg;
  var warm = clamp(prog / 10, 0, 1);

  // workload profile
  if (TRAINING.indexOf(wt) >= 0) {
    var dip = rand(key + ':dip') < 0.02;
    util = dip ? 40 + noise(key + ':u', 5) : smooth(pv('gpuUtilPct', 20), (20 + 70 * warm) + 6 * warm * Math.sin(prog / 7 + h * 6) * 0.5, 2) + noise(key + ':u', 3);
    if (!dip && warm >= 1) util = clamp(util, 85, 97.5);
    mem = smooth(pv('gpuMemPct', 10), 55 + 30 * h, 20) + noise(key + ':m', 0.8);
    cpu = 40 + 20 * (util / 100) + noise(key + ':c', 5);
    ioR = warm < 1 ? 1500 + noise(key + ':ior', 200) : 200 + 400 * h + noise(key + ':ior', 60);
    if (loss != null) loss = Math.max(0.3 + 0.3 * h, num(loss, 2.5) * (1 - dProg / (300 + 400 * h)) + noise(key + ':l', 0.008));
  } else if (wt == 'INFERENCE') {
    util = 70 + 15 * Math.sin(prog / 3 + h * 9) + noise(key + ':u', 6);
    mem = smooth(pv('gpuMemPct', 20), 40 + 30 * h, 5) + noise(key + ':m', 0.5);
    cpu = 35 + noise(key + ':c', 6);
    ioR = 150 + noise(key + ':ior', 40);
    period = 0;
  } else if (wt == 'SIMULATION') {
    util = gpus > 0 ? 94 + noise(key + ':u', 4) : 0;
    mem = gpus > 0 ? smooth(pv('gpuMemPct', 15), 35 + 25 * h, 10) + noise(key + ':m', 0.5) : 0;
    cpu = gpus > 0 ? 60 + noise(key + ':c', 8) : 96 + noise(key + ':c', 2.5);
    ioR = 40 + noise(key + ':ior', 10);
  } else if (wt == 'DATA_PROCESSING') {
    util = gpus > 0 ? 10 + noise(key + ':u', 5) : 0;
    mem = gpus > 0 ? 15 + noise(key + ':m', 2) : 0;
    cpu = 91 + noise(key + ':c', 6);
    ioR = 1400 + noise(key + ':ior', 600);
    period = 0;
  } else {
    var active = rand(job.id + ':burst:' + Math.floor(prog / 20)) < 0.5;
    util = active ? 55 + noise(key + ':u', 15) : 2 + noise(key + ':u', 1.5);
    mem = 30 + 20 * h + noise(key + ':m', 1);
    cpu = active ? 30 + noise(key + ':c', 10) : 4 + noise(key + ':c', 2);
    ioR = active ? 120 : 5;
    period = 0;
  }
  hostMem = smooth(pv('memPct', 25), 30 + 25 * h, 15) + noise(key + ':hm', 1);

  // scenario overrides (scripted demo problems keep firing)
  if (scenario == 'IDLE_GPU' && gpus > 0) {
    util = 0.2 + rand(key + ':idle') * 2.8;
    cpu = 30 + noise(key + ':c', 10);
    ioR = 5 + noise(key + ':ior', 4);
    period = 0;
  } else if (scenario == 'LOW_UTIL' && gpus > 0) {
    util = 30 + noise(key + ':u', 9);
  } else if (scenario == 'OOM_CREEP' && gpus > 0) {
    mem = Math.min(98.8, Math.max(pv('gpuMemPct', 85), 85) + 0.15 * dProg + noise(key + ':m', 0.2));
  } else if (scenario == 'HUNG') {
    util = 0;
    cpu = 0.5 + rand(key + ':c') * 2;
    ioR = 0;
    ioW = 0;
    mem = pv('gpuMemPct', mem);
    loss = prev ? prev.trainingLoss : loss;
    period = 0;
  } else if (scenario == 'STALE_CHECKPOINT') {
    period = 0;
  }
  if (gpus <= 0) {
    util = 0;
    mem = 0;
  }

  // checkpoints: write spike and age reset every `period` progress-minutes
  if (period > 0 && ckpt >= period) {
    ckpt = ckpt % period;
    ioW = 600 + rand(key + ':ck') * 400;
  }
  var power = gpus > 0 ? gpus * (60 + ((tdpFor(job.gpuType && job.gpuType.id) - 60) * clamp(util, 0, 100)) / 100) * (1 + noise(key + ':pw', 0.03)) : 0;
  if (scenario == 'NODE_FAILURE' && gpus > 0 && failAt != null && prog >= failAt) {
    util = 0;
    power = 0;
    cpu = 0;
    ioR = 0;
    ioW = 0;
  }
  return {
    gpuUtilPct: round(clamp(util, 0, 100), 1),
    gpuMemPct: round(clamp(mem, 0, 99.5), 1),
    cpuUtilPct: round(clamp(cpu, 0, 100), 1),
    memPct: round(clamp(hostMem, 1, 99.5), 1),
    ioReadMBps: round(Math.max(0, ioR), 1),
    ioWriteMBps: round(Math.max(0, ioW), 1),
    powerW: Math.round(Math.max(0, power)),
    checkpointAgeMin: round(Math.max(0, ckpt), 1),
    trainingLoss: loss == null ? null : round(loss, 4),
  };
}

// ---------------------------------------------------------------- tick

function chargePerHour(j) {
  var res = num(j.allocGpus, 0) > 0 ? num(j.allocGpus, 0) : num(j.allocCpus, 1);
  var units = res * num(j.partition && j.partition.chargeFactor, 1);
  if (j.cluster && String(j.cluster.unitName) == 'USD') units = units * num(j.gpuType && j.gpuType.costPerGpuHourUsd, 1);
  return { units: units, usd: units * num(j.cluster && j.cluster.usdPerUnit, 1) };
}

function tick(fastForwardMinutes) {
  var cfg = settings();
  if (!cfg.enabled) return { skipped: true, reason: 'RunSimulatorSettings.enabled is false (kill switch)' };
  var now = Date.now();
  var ff = Math.max(0, num(fastForwardMinutes, 0));
  var last = cfg.lastTickAt == null ? now - MIN_MS : cfg.lastTickAt;
  var realMs = clamp(now - last, 0, cfg.maxCatchUpMin * MIN_MS);
  var progressMin = (realMs / MIN_MS) * cfg.demoTimeScale + ff;
  var nSamples = clamp(Math.floor(realMs / 1000 / cfg.sampleIntervalSec), 1, MAX_SAMPLES_PER_TICK);

  var jobs = [];
  Job.fetchObjStream({
    filter: Filter.eq('isLive', true).and().intersects('state', ['RUNNING', 'PENDING']),
    include: 'this, lab.this, project.priority, cluster.this, partition.this, gpuType.this, runRequest.chosenPlan.estDurationHours, runRequest.chosenPlan.estWaitHours',
  }).each(function (j) {
    jobs.push(j);
  });

  var allocs = {};
  var labIds = jobs.map(function (j) { return j.lab ? j.lab.id : ''; });
  if (labIds.length) {
    list(Allocation.fetch({ filter: Filter.intersects('lab.id', labIds), limit: 1000 }).objs).forEach(function (a) {
      var key = a.lab.id + '|' + a.cluster.id;
      if (allocs[key] == null || ms(a.endDate) > ms(allocs[key].endDate)) allocs[key] = { id: a.id, usedUnits: num(a.usedUnits, 0), endDate: a.endDate, delta: 0 };
    });
  }

  var newMetrics = [];
  var jobUpdates = [];
  var started = [];
  var finished = [];
  var stillRunning = [];
  var thinCandidates = [];
  var pendingByPartition = {};

  jobs.forEach(function (j) {
    if (j.state != 'PENDING') return;
    var pid = j.partition ? j.partition.id : '';
    (pendingByPartition[pid] = pendingByPartition[pid] || []).push(j);
  });
  Object.keys(pendingByPartition).forEach(function (pid) {
    pendingByPartition[pid].sort(function (a, b) {
      return (ms(a.submitTime) || 0) - (ms(b.submitTime) || 0);
    });
  });

  jobs.forEach(function (j) {
    if (j.state == 'PENDING') {
      var eta = ms(j.etaStartAt);
      if (eta == null) {
        var waitH = j.runRequest && j.runRequest.chosenPlan && j.runRequest.chosenPlan.estWaitHours != null ? num(j.runRequest.chosenPlan.estWaitHours, 0.5) : num(j.partition && j.partition.avgWaitHours, 0.5);
        eta = Math.max(ms(j.submitTime) || now, now - MIN_MS) + clamp((waitH * HOUR_MS) / cfg.queueWaitCompression, 20 * 1000, 5 * MIN_MS);
      }
      var pos = pendingByPartition[j.partition ? j.partition.id : ''].indexOf(j) + 1;
      if (now + ff * MIN_MS >= eta) {
        var nodes = Math.max(1, num(j.allocNodes, 1));
        var names = [];
        for (var n = 0; n < nodes; n++) names.push(nodeName(j.partition, Math.floor(rand(j.id + ':node') * 90) + n));
        var first = nextSample(j, j.simScenario || 'HEALTHY', null, 0, 0, now);
        newMetrics.push(JobMetric.make(withMeta(first, j.id, now)));
        jobUpdates.push({ id: j.id, state: 'RUNNING', startTime: toDt(now), nodeList: j.nodeList || names.join(','), etaStartAt: null, queuePosition: null, simScenario: j.simScenario || 'HEALTHY', latestSample: latestOf(first, now), lastSimAt: toDt(now) });
        started.push(j.id);
      } else {
        jobUpdates.push({ id: j.id, etaStartAt: toDt(eta), queuePosition: pos });
      }
      return;
    }

    // RUNNING
    var samples = list(JobMetric.fetch({ filter: Filter.eq('job.id', j.id), order: 'descending(ts)', limit: 16 }).objs).reverse();
    var scenario = j.simScenario || inferScenario(j, samples);
    var prev = samples.length ? samples[samples.length - 1] : null;
    var lastTs = prev ? ms(prev.ts) : now - realMs;
    var elapsed0 = num(j.elapsedHours, 0);
    if (scenario == 'NODE_FAILURE') {
      if (prev && num(prev.powerW, 1) === 0 && num(prev.gpuUtilPct, 1) === 0) {
        jobUpdates.push({ id: j.id, state: 'FAILED', endTime: toDt(now), exitCode: '0:9', simScenario: scenario, lastSimAt: toDt(now) });
        finished.push({ jobId: j.id, state: 'FAILED', scripted: j.runRequest == null, scenario: scenario, job: j });
        return;
      }
    }
    var failAt = scenario == 'NODE_FAILURE' ? elapsed0 * 60 + 20 : null; // the node drops ~20 progress-minutes later
    var n = ff > 0 && realMs < cfg.sampleIntervalSec * 1000 ? 1 : nSamples;
    var dProg = progressMin / n;
    var prog = elapsed0 * 60;
    var written = 0;
    for (var i = 0; i < n; i++) {
      var t = Math.max(lastTs + 1000, now - (n - 1 - i) * cfg.sampleIntervalSec * 1000);
      prog += dProg;
      var s = nextSample(j, scenario, prev, prog, dProg, t, failAt);
      newMetrics.push(JobMetric.make(withMeta(s, j.id, t)));
      prev = s;
      prev.ts = new Date(t).toISOString();
      lastTs = t;
      written++;
    }
    var elapsed = elapsed0 + progressMin / 60;
    var limit = num(j.timelimitHours, 1e9);
    var oldAvg = num(j.gpuUtilAvg, prev.gpuUtilPct);
    var avgUtil = elapsed > 0 ? (oldAvg * elapsed0 + prev.gpuUtilPct * (progressMin / 60)) / elapsed : prev.gpuUtilPct;
    var rate = chargePerHour(j);
    var units = rate.units * Math.min(progressMin / 60, Math.max(0, limit - elapsed0));
    var akey = (j.lab ? j.lab.id : '') + '|' + (j.cluster ? j.cluster.id : '');
    if (allocs[akey]) allocs[akey].delta += units;
    var upd = {
      id: j.id,
      elapsedHours: round(Math.min(elapsed, limit), 4),
      allocGpus: j.allocGpus,
      gpuUtilAvg: round(avgUtil, 2),
      costUnits: round(num(j.costUnits, 0) + units, 3),
      costUsd: round(num(j.costUsd, 0) + rate.usd * Math.min(progressMin / 60, Math.max(0, limit - elapsed0)), 3),
      simScenario: scenario,
      latestSample: latestOf(prev, lastTs),
      lastSimAt: toDt(now),
    };
    var planned = j.runRequest && j.runRequest.chosenPlan ? num(j.runRequest.chosenPlan.estDurationHours, null) : null;
    if (planned != null && elapsed >= planned && scenario == 'HEALTHY') {
      upd.state = 'COMPLETED';
      upd.endTime = toDt(now);
      upd.exitCode = '0:0';
      finished.push({ jobId: j.id, state: 'COMPLETED', scripted: j.runRequest == null, scenario: scenario, job: j });
    } else if (elapsed >= limit) {
      upd.state = 'TIMEOUT';
      upd.endTime = toDt(now);
      upd.exitCode = '0:15';
      finished.push({ jobId: j.id, state: 'TIMEOUT', scripted: j.runRequest == null, scenario: scenario, job: j });
    } else {
      stillRunning.push(j);
      thinCandidates.push(j.id);
    }
    jobUpdates.push(upd);
  });

  if (newMetrics.length) JobMetric.createBatch(newMetrics);
  if (jobUpdates.length) Job.mergeBatch(jobUpdates.map(function (u) { return Job.make(u); }));
  var allocUpdates = Object.keys(allocs)
    .filter(function (k) { return allocs[k].delta > 0; })
    .map(function (k) { return Allocation.make({ id: allocs[k].id, usedUnits: round(allocs[k].usedUnits + allocs[k].delta, 3) }); });
  if (allocUpdates.length) Allocation.mergeBatch(allocUpdates);

  var drift = driftClusters(jobs, realMs, now);
  var thinned = thinSamples(thinCandidates, cfg.maxSamplesPerJob);

  // finished jobs: close their alerts; scripted demo jobs get a successor so demo problems keep firing
  var respawned = [];
  finished.forEach(function (f) {
    Job.make({ id: f.jobId }).evaluateHealth();
    if (cfg.respawnScriptedJobs && f.scripted) respawned.push(respawn(f.job, f.scenario, now));
  });

  // guardrails + autopilot
  var newAlerts = [];
  var actions = [];
  var resolvedAlerts = [];
  var policies = {};
  stillRunning.concat(jobs.filter(function (j) { return started.indexOf(j.id) >= 0; })).forEach(function (j) {
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
      } else if ((t == 'PREEMPTION_RISK' || t == 'STALE_CHECKPOINT' || t == 'OOM_RISK') && num(ap.checkpointBeforeTimeoutMin, 0) > 0 && j.simScenario != 'STALE_CHECKPOINT') act('CHECKPOINT_NOW', a);
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

  var superseded = supersedeProposals(resolvedAlerts.concat(finished.map(function (f) { return f.jobId; })), now);

  var openAlerts = JobAlert.fetchCount({ filter: Filter.intersects('status', ['OPEN', 'ACKED']) });
  var liveJobs = Job.fetchCount({ filter: Filter.eq('isLive', true).and().intersects('state', ['RUNNING', 'PENDING']) });
  var awaiting = actions.filter(function (a) { return a.outcome == 'PENDING_APPROVAL'; }).length;
  var summary = {
    simulatedTo: iso(now),
    realSecondsAdvanced: round(realMs / 1000, 1),
    progressMinutes: round(progressMin, 2),
    demoTimeScale: cfg.demoTimeScale,
    advanced: stillRunning.length + finished.length,
    started: started,
    finished: finished.map(function (f) { return { jobId: f.jobId, state: f.state }; }),
    respawned: respawned,
    samplesWritten: newMetrics.length,
    samplesThinned: thinned,
    partitionsDrifted: drift,
    newAlerts: newAlerts,
    resolvedAlerts: resolvedAlerts,
    actions: actions,
    supersededProposals: superseded,
    awaitingConfirmation: awaiting,
    openAlerts: openAlerts,
    liveJobs: liveJobs,
    provenance: [
      { component: 'RunMonitor', version: 'live-sim-v2', method: 'wall-clock simulator: seeded per-workload telemetry profiles, scenario overrides, compressed queue waits, mean-reverting partition drift', status: 'SIMULATED', trainingPeriod: null, sampleSupport: null, historicalOnly: false, computedAt: iso(now), note: 'Simulated telemetry for demo' },
      { component: 'GuardrailRuleEngine', version: 'guardrails-hysteresis-v1', method: 'state machine with hysteresis; consequential autopilot actions (cancel, scale down, requeue) wait for user confirmation', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: null, historicalOnly: false, computedAt: iso(now) },
      { component: 'GPUUnderuseDetector', version: 'ewma-cusum-v1', method: 'EWMA + CUSUM over each run\'s own GPU-utilization baseline', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: null, historicalOnly: false, computedAt: iso(now) },
    ],
  };
  var compact = JSON.parse(JSON.stringify(summary));
  compact.newAlerts = compact.newAlerts.length;
  compact.actions = compact.actions.length;
  RunSimulatorSettings.make({ id: 'default', lastTickAt: toDt(now), lastTickSummary: compact }).merge();
  log.info('tick: {} s real, {} progress-min, {} running, {} started, {} finished, {} samples', round(realMs / 1000, 0), round(progressMin, 1), stillRunning.length, started.length, finished.length, newMetrics.length);
  return summary;
}

function withMeta(s, jobId, t) {
  var m = {};
  Object.keys(s).forEach(function (k) {
    if (k != 'ts') m[k] = s[k];
  });
  m.id = jobId + '-m' + t;
  m.job = { id: jobId };
  m.ts = toDt(t);
  return m;
}

function latestOf(s, t) {
  var out = { ts: iso(t) };
  ['gpuUtilPct', 'gpuMemPct', 'cpuUtilPct', 'memPct', 'ioReadMBps', 'ioWriteMBps', 'powerW', 'checkpointAgeMin', 'trainingLoss'].forEach(function (k) {
    out[k] = s[k] == null ? null : Number(s[k]);
  });
  return out;
}

/** Partition load and cluster health follow a mean-reverting random walk around the seeded baseline plus live demand. */
function driftClusters(jobs, realMs, now) {
  var minutes = Math.max(0.05, realMs / MIN_MS);
  var demand = {};
  jobs.forEach(function (j) {
    if (!j.partition) return;
    var d = (demand[j.partition.id] = demand[j.partition.id] || { running: 0, pending: 0 });
    if (j.state == 'RUNNING') d.running += Math.max(1, num(j.allocGpus, 0));
    else d.pending++;
  });
  var bucket = Math.floor(now / MIN_MS);
  var parts = list(Partition.fetch({ limit: 500 }).objs);
  var clusterUtil = {};
  var updates = parts.map(function (p) {
    var key = p.id + ':' + bucket;
    var baseU = num(p.baseUtilizationPct, num(p.utilizationPct, 60));
    var baseQ = num(p.baseQueueDepth, num(p.currentQueueDepth, 5));
    var baseW = num(p.baseAvgWaitHours, num(p.avgWaitHours, 1));
    var d = demand[p.id] || { running: 0, pending: 0 };
    var cap = Math.max(1, num(p.nodeCount, 4) * Math.max(1, num(p.gpusPerNode, 1)));
    var targetU = clamp(baseU + (d.running / cap) * 100 * 0.3, 0, 99);
    var theta = 1 - Math.exp(-minutes / 30);
    var u = clamp(num(p.utilizationPct, baseU) + (targetU - num(p.utilizationPct, baseU)) * theta + noise(key + ':u', 1.2) * Math.sqrt(minutes), 0, 99.5);
    var q = Math.max(0, Math.round(num(p.currentQueueDepth, baseQ) + (baseQ + d.pending - num(p.currentQueueDepth, baseQ)) * theta + noise(key + ':q', 1.5) * Math.sqrt(minutes)));
    var w = Math.max(0, baseW * (1 + Math.max(0, u - baseU) / 20) * (1 + noise(key + ':w', 0.05)));
    if (p.cluster) {
      var c = (clusterUtil[p.cluster.id] = clusterUtil[p.cluster.id] || { sum: 0, n: 0 });
      if (p.gpuType != null || c.n === 0) {
        c.sum += u;
        c.n++;
      }
    }
    return Partition.make({ id: p.id, utilizationPct: round(u, 1), currentQueueDepth: q, avgWaitHours: round(w, 2), baseUtilizationPct: baseU, baseQueueDepth: baseQ, baseAvgWaitHours: baseW });
  });
  if (updates.length) Partition.mergeBatch(updates);
  var cUpdates = list(ComputeCluster.fetch({ include: 'id, status, healthPct', limit: 100 }).objs).map(function (c) {
    var retired = String(c.status) == 'RETIRED';
    var h = retired ? 0 : clamp(num(c.healthPct, 98.5) + (98.5 - num(c.healthPct, 98.5)) * 0.2 + noise(c.id + ':' + bucket + ':h', 0.4), 96, 100);
    var cu = clusterUtil[c.id];
    return ComputeCluster.make({ id: c.id, healthPct: round(h, 1), liveUtilizationPct: retired || !cu ? 0 : round(cu.sum / cu.n, 1) });
  });
  if (cUpdates.length) ComputeCluster.mergeBatch(cUpdates);
  return updates.length;
}

/** Keeps sample volume bounded: beyond the newest `keep` samples of a job, only every 6th sample survives. */
function thinSamples(jobIds, keep) {
  var removed = 0;
  var picked = jobIds.filter(function (id) {
    return rand(id + ':thin:' + Math.floor(Date.now() / MIN_MS)) < 0.5;
  }).slice(0, THIN_JOBS_PER_TICK);
  picked.forEach(function (id) {
    var old = list(JobMetric.fetch({ filter: Filter.eq('job.id', id), order: 'descending(ts)', offset: keep, limit: 300, include: 'id, ts' }).objs);
    var drop = old.filter(function (m) {
      return Math.floor(ms(m.ts) / 1000) % 6 !== 0;
    }).map(function (m) {
      return JobMetric.make({ id: m.id });
    });
    if (drop.length) {
      JobMetric.removeBatch(drop);
      removed += drop.length;
    }
  });
  return removed;
}

/** A successor for a scripted demo job that ended, queued with the same scenario so demo problems keep firing. */
function respawn(j, scenario, now) {
  var cid = j.cluster ? String(j.cluster.id) : 'node';
  var base = Number(String(j.slurmJobId || '0').replace(/\D/g, '')) || 1000000;
  var newId = String(base + 1 + Math.floor(rand(j.id + ':respawn:' + now) * 900));
  var limit = num(j.timelimitHours, 24);
  if (scenario == 'WALLTIME_RISK') limit = Math.max(2, Math.round(limit * 0.15));
  var name = String(j.jobName || 'job').replace(/(-r\d+)?$/, '') + '-r' + (1 + (Number((String(j.jobName || '').match(/-r(\d+)$/) || [0, 1])[1]) || 1));
  Job.make({
    id: cid + '-' + newId,
    slurmJobId: newId,
    lab: j.lab ? { id: j.lab.id } : null,
    project: j.project ? { id: j.project.id } : null,
    user: j.user,
    cluster: j.cluster ? { id: j.cluster.id } : null,
    partition: j.partition ? { id: j.partition.id } : null,
    account: j.account,
    qos: j.qos,
    jobName: name,
    workloadType: j.workloadType,
    state: 'PENDING',
    submitTime: toDt(now),
    etaStartAt: toDt(now + (30 + rand(j.id + ':eta') * 90) * 1000),
    timelimitHours: limit,
    elapsedHours: 0,
    allocCpus: j.allocCpus,
    allocNodes: j.allocNodes,
    allocGpus: j.allocGpus,
    gpuType: j.gpuType ? { id: j.gpuType.id } : null,
    reqMemGb: j.reqMemGb,
    costUnits: 0,
    costUsd: 0,
    isLive: true,
    simScenario: scenario,
  }).create();
  return cid + '-' + newId;
}

/** Pending AI-triage / autopilot proposals for alerts (or jobs) that resolved are closed as superseded. */
function supersedeProposals(ids, now) {
  if (!ids.length) return [];
  var out = [];
  var jobIds = {};
  ids.forEach(function (id) {
    jobIds[String(id).replace(/-(IDLE_GPU|LOW_GPU_UTIL|OOM_RISK|WALLTIME_RISK|BUDGET_BURN|HUNG_JOB|NODE_FAILURE|PREEMPTION_RISK|STALE_CHECKPOINT)$/, '')] = true;
  });
  var triaged = {};
  if (typeof GuardrailTriage !== 'undefined') {
    list(GuardrailTriage.fetch({ filter: Filter.intersects('id', ids), include: 'id, actionLogEntry', limit: 200 }).objs).forEach(function (t) {
      if (t.actionLogEntry) triaged[t.actionLogEntry.id] = true;
    });
  }
  ActionLogEntry.fetchObjStream({ filter: Filter.eq('outcome', 'PENDING_APPROVAL').and().intersects('job.id', Object.keys(jobIds)), include: 'id, actionType, actor, detail, job.state' }).each(function (e) {
    var jobEnded = e.job && e.job.state != 'RUNNING' && e.job.state != 'PENDING';
    if (!triaged[e.id] && !jobEnded && String(e.actor) != 'AUTOPILOT') return;
    if (!jobEnded && !triaged[e.id] && String(e.actionType) == 'EXTEND_WALLTIME') return;
    ActionLogEntry.make({ id: e.id, outcome: 'FAILED', detail: e.detail + ' — Superseded at ' + iso(now) + ': ' + (jobEnded ? 'the job ended' : 'the alert auto-resolved') + ' before a decision.' }).merge();
    out.push(e.id);
  });
  return out;
}

// ---------------------------------------------------------------- snapshot

function liveSnapshot(labId) {
  var now = Date.now();
  var cfg = settings();
  var jobFilter = Filter.eq('isLive', true).and("state == 'RUNNING' || state == 'PENDING' || endTime >= dateTime('" + new Date(now - ENDED_VISIBLE_MS).toISOString().substring(0, 19) + "')");
  if (labId) jobFilter = Filter.eq('lab.id', labId).and(jobFilter);
  var jobs = list(Job.fetch({ filter: jobFilter, include: 'id, jobName, user, lab, cluster, partition, qos, state, workloadType, allocGpus, gpuType, nodeList, submitTime, startTime, endTime, etaStartAt, queuePosition, elapsedHours, timelimitHours, costUnits, costUsd, latestSample', order: 'descending(submitTime)', limit: 200 }).objs);
  var ids = jobs.map(function (j) { return j.id; });
  var alertsByJob = {};
  var crit = 0;
  var open = 0;
  if (ids.length) {
    list(JobAlert.fetch({ filter: Filter.intersects('job.id', ids).and().intersects('status', ['OPEN', 'ACKED']), include: 'id, job, alertType, severity, status', limit: 500 }).objs).forEach(function (a) {
      (alertsByJob[a.job.id] = alertsByJob[a.job.id] || []).push({ id: a.id, alertType: a.alertType, severity: a.severity, status: a.status });
      open++;
      if (a.severity == 'CRITICAL') crit++;
    });
  }
  var awaiting = ids.length ? ActionLogEntry.fetchCount({ filter: Filter.eq('outcome', 'PENDING_APPROVAL').and().intersects('job.id', ids) }) : 0;
  var perSec = cfg.demoTimeScale / 3600;
  var out = {
    serverTime: iso(now),
    simulator: { enabled: !!cfg.enabled, demoTimeScale: cfg.demoTimeScale, queueWaitCompression: cfg.queueWaitCompression, lastTickAt: iso(cfg.lastTickAt), nextTickInSec: 60 - (Math.floor(now / 1000) % 60) },
    counts: {
      running: jobs.filter(function (j) { return j.state == 'RUNNING'; }).length,
      pending: jobs.filter(function (j) { return j.state == 'PENDING'; }).length,
      openAlerts: open,
      criticalAlerts: crit,
      awaitingConfirmation: awaiting,
    },
    jobs: jobs.map(function (j) {
      var running = j.state == 'RUNNING';
      return {
        id: j.id,
        jobName: j.jobName,
        user: j.user,
        labId: j.lab ? j.lab.id : null,
        clusterId: j.cluster ? j.cluster.id : null,
        partitionId: j.partition ? j.partition.id : null,
        qos: j.qos,
        state: j.state,
        workloadType: j.workloadType,
        gpus: num(j.allocGpus, 0),
        gpuTypeId: j.gpuType ? j.gpuType.id : null,
        nodeList: j.nodeList || null,
        submitTime: iso(ms(j.submitTime)),
        startTime: iso(ms(j.startTime)),
        endTime: iso(ms(j.endTime)),
        etaStartAt: iso(ms(j.etaStartAt)),
        queuePosition: j.queuePosition == null ? null : Number(j.queuePosition),
        elapsedHours: round(num(j.elapsedHours, 0), 4),
        timelimitHours: num(j.timelimitHours, null),
        remainingHours: j.timelimitHours == null ? null : round(Math.max(0, num(j.timelimitHours, 0) - num(j.elapsedHours, 0)), 4),
        costUnits: round(num(j.costUnits, 0), 3),
        costUsd: round(num(j.costUsd, 0), 3),
        progressPerRealSec: running && cfg.enabled ? perSec : 0,
        latest: j.latestSample == null ? null : plainJson(j.latestSample),
        alerts: alertsByJob[j.id] || [],
      };
    }),
    partitions: list(Partition.fetch({ include: 'id, cluster, utilizationPct, currentQueueDepth, avgWaitHours', limit: 500 }).objs).map(function (p) {
      return { id: p.id, clusterId: p.cluster ? p.cluster.id : null, utilizationPct: num(p.utilizationPct, 0), currentQueueDepth: num(p.currentQueueDepth, 0), avgWaitHours: num(p.avgWaitHours, 0) };
    }),
    clusters: list(ComputeCluster.fetch({ include: 'id, status, healthPct, liveUtilizationPct', limit: 100 }).objs).map(function (c) {
      return { id: c.id, status: c.status, healthPct: c.healthPct == null ? null : Number(c.healthPct), liveUtilizationPct: c.liveUtilizationPct == null ? null : Number(c.liveUtilizationPct) };
    }),
    allocations: labId
      ? list(Allocation.fetch({ filter: Filter.eq('lab.id', labId), include: 'id, cluster, usedUnits, totalUnits, unitName', limit: 100 }).objs).map(function (a) {
          return { id: a.id, clusterId: a.cluster.id, usedUnits: round(num(a.usedUnits, 0), 3), totalUnits: num(a.totalUnits, 0), unitName: a.unitName };
        })
      : null,
    provenance: [{ component: 'RunMonitor', version: 'live-sim-v2', method: 'wall-clock simulator snapshot', status: 'SIMULATED', trainingPeriod: null, sampleSupport: null, historicalOnly: false, computedAt: iso(now), note: 'Simulated telemetry for demo' }],
  };
  return out;
}
