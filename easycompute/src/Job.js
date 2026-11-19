/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('Job');

var MIN_MS = 60 * 1000;
var HOUR_MS = 60 * MIN_MS;
var ACTIONS = ['CANCEL', 'EXTEND_WALLTIME', 'REQUEUE_STANDBY', 'CHECKPOINT_NOW', 'SCALE_DOWN', 'NOTIFY_PI', 'HOLD'];
var ACTORS = ['USER', 'AUTOPILOT', 'ADMIN'];
var SEVERITY_RANK = { CRITICAL: 0, WARNING: 1, INFO: 2 };
/** Alerts an action addresses (resolved when the action succeeds). */
var RESOLVES = {
  CANCEL: ['IDLE_GPU', 'LOW_GPU_UTIL', 'OOM_RISK', 'WALLTIME_RISK', 'BUDGET_BURN', 'HUNG_JOB', 'NODE_FAILURE', 'PREEMPTION_RISK', 'STALE_CHECKPOINT'],
  CHECKPOINT_NOW: ['STALE_CHECKPOINT', 'PREEMPTION_RISK', 'WALLTIME_RISK', 'OOM_RISK'],
  SCALE_DOWN: ['LOW_GPU_UTIL', 'IDLE_GPU'],
  REQUEUE_STANDBY: ['NODE_FAILURE', 'LOW_GPU_UTIL'],
  EXTEND_WALLTIME: ['WALLTIME_RISK'],
};
var CHECKPOINTING = ['TRAINING', 'FINETUNE', 'SIMULATION'];

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

function fmtMin(m) {
  return m >= 120 ? round(m / 60, 1) + ' h' : Math.round(m) + ' min';
}

/** The job's latest samples, oldest first. */
function recentMetrics(jobId, n) {
  return list(JobMetric.fetch({ filter: Filter.eq('job.id', jobId), order: 'descending(ts)', limit: n || 48 }).objs).reverse();
}

/** Minutes covered by the trailing run of samples satisfying pred (0 when the latest sample does not). */
function trailingMinutes(samples, pred) {
  var n = samples.length;
  if (!n || !pred(samples[n - 1])) return 0;
  var i = n - 1;
  while (i > 0 && pred(samples[i - 1])) i--;
  var gap = n > 1 ? (ms(samples[n - 1].ts) - ms(samples[n - 2].ts)) / MIN_MS : 5;
  return (ms(samples[n - 1].ts) - ms(samples[i].ts)) / MIN_MS + Math.max(1, gap);
}

function autopilotFor(labId) {
  var ap = labId ? AutopilotPolicy.make({ id: labId }).get('this') : null;
  if (ap == null && labId) ap = AutopilotPolicy.fetch({ filter: Filter.eq('lab.id', labId), limit: 1 }).objs[0];
  return {
    enabled: ap ? !!ap.enabled : false,
    cancelIdleAfterMin: num(ap && ap.cancelIdleAfterMin, 60) || 60,
    checkpointBeforeTimeoutMin: num(ap && ap.checkpointBeforeTimeoutMin, 30),
    autoExtendWalltime: ap ? !!ap.autoExtendWalltime : false,
    requeueToStandbyOnLowPriority: ap ? !!ap.requeueToStandbyOnLowPriority : false,
    notifyPiOnCritical: ap ? !!ap.notifyPiOnCritical : false,
    budgetAlertPct: num(ap && ap.budgetAlertPct, 0.8) || 0.8,
  };
}

/** Allocation units charged per hour by this job. */
function unitsPerHour(job) {
  var p = job.partition;
  var c = job.cluster;
  var factor = num(p && p.chargeFactor, 1);
  var gpus = num(job.allocGpus, 0);
  var res = gpus > 0 ? gpus : num(job.allocCpus, 1);
  var rate = factor;
  if (c && String(c.unitName) == 'USD') rate = factor * num(job.gpuType && job.gpuType.costPerGpuHourUsd, 1);
  return res * rate;
}

// ---------------------------------------------------------------- health rules

/** Returns [{ alertType, severity, message, action }] for the job's current metric window. */
function detect(job, samples, ap, alloc, burnPerDay) {
  var out = [];
  if (!samples.length) return out;
  var last = samples[samples.length - 1];
  var lastTs = ms(last.ts);
  var win = samples.filter(function (s) {
    return ms(s.ts) >= lastTs - HOUR_MS;
  });
  var prev = samples.length > 1 ? samples[samples.length - 2] : null;
  var gpus = num(job.allocGpus, 0);
  var wt = String(job.workloadType || '');
  var mean = function (f) {
    return win.reduce(function (s, x) { return s + num(x[f], 0); }, 0) / win.length;
  };

  // node failure: power and utilization dropped to zero after a live sample
  if (gpus > 0 && num(last.powerW, 1) === 0 && num(last.gpuUtilPct, 1) === 0 && prev != null && num(prev.powerW, 0) > 0) {
    out.push({ alertType: 'NODE_FAILURE', severity: 'CRITICAL', action: 'REQUEUE_STANDBY', message: 'Node ' + (String(job.nodeList || '').split(',')[0] || 'unknown') + ' stopped reporting: GPU power fell from ' + Math.round(num(prev.powerW, 0)) + ' W to 0 W. Requeue from the last checkpoint (' + fmtMin(num(last.checkpointAgeMin, 0)) + ' old).' });
    return out;
  }

  // hung: nothing moves
  var lossFlat = function (s) {
    return last.trainingLoss == null || s.trainingLoss == null || Math.abs(num(s.trainingLoss, 0) - num(last.trainingLoss, 0)) < 1e-4;
  };
  var hungMin = trailingMinutes(samples, function (s) {
    return num(s.gpuUtilPct, 0) < 2 && num(s.cpuUtilPct, 0) < 3 && num(s.ioReadMBps, 0) + num(s.ioWriteMBps, 0) < 1 && lossFlat(s);
  });
  if (hungMin >= 30) {
    out.push({ alertType: 'HUNG_JOB', severity: hungMin >= 60 ? 'CRITICAL' : 'WARNING', action: 'CANCEL', message: 'No GPU, CPU or I/O activity and no training progress for ' + fmtMin(hungMin) + ' (GPU ' + round(last.gpuUtilPct, 0) + '%, CPU ' + round(last.cpuUtilPct, 0) + '%). The process is likely deadlocked; cancel or requeue from the checkpoint.' });
  }
  if (gpus > 0) {
    var idleMin = trailingMinutes(samples, function (s) {
      return num(s.gpuUtilPct, 0) < 5;
    });
    if (idleMin >= 30) {
      var critical = idleMin >= ap.cancelIdleAfterMin;
      out.push({ alertType: 'IDLE_GPU', severity: critical ? 'CRITICAL' : 'WARNING', action: 'CANCEL', message: gpus + ' GPU(s) idle (<5% utilization) for ' + fmtMin(idleMin) + ' while the job holds them' + (critical ? '; past the lab\'s ' + ap.cancelIdleAfterMin + '-minute idle limit.' : '; autopilot cancels at ' + ap.cancelIdleAfterMin + ' min.') + ' Wasting ~' + round((gpus * idleMin) / 60, 1) + ' GPU-hours so far.' });
    } else if (win.length >= 3 && (ms(win[win.length - 1].ts) - ms(win[0].ts)) / MIN_MS >= 40) {
      var u = mean('gpuUtilPct');
      if (u >= 5 && u < 45) {
        out.push({ alertType: 'LOW_GPU_UTIL', severity: 'WARNING', action: gpus > 1 ? 'SCALE_DOWN' : 'NOTIFY_PI', message: 'GPU utilization averaged ' + round(u, 0) + '% over the last hour on ' + gpus + ' GPU(s)' + (mean('ioReadMBps') > 300 ? ' with heavy reads (' + Math.round(mean('ioReadMBps')) + ' MB/s): likely data-loader bound; add --cpus-per-task workers.' : '.') + (gpus > 1 ? ' Halving to ' + Math.max(1, Math.floor(gpus / 2)) + ' GPU(s) would save ~' + round((gpus - Math.max(1, Math.floor(gpus / 2))) * 24, 0) + ' GPU-hours/day.' : ' A smaller GPU (A30/L40S) would cost less.') });
      } else if (u >= 45 && u < 55 && gpus > 1) {
        out.push({ alertType: 'LOW_GPU_UTIL', severity: 'INFO', action: 'SCALE_DOWN', message: 'GPU utilization averaged ' + round(u, 0) + '% on ' + gpus + ' GPUs; scaling efficiency is poor at this size.' });
      }
    }
  }

  // memory pressure
  var gm = num(last.gpuMemPct, 0);
  var rising = prev != null && gm - num(prev.gpuMemPct, 0) >= 2;
  var hm = num(last.memPct, 0);
  if (gpus > 0 && (gm >= 95 || (gm >= 88 && rising))) {
    out.push({ alertType: 'OOM_RISK', severity: gm >= 97 ? 'CRITICAL' : 'WARNING', action: 'CHECKPOINT_NOW', message: 'GPU memory at ' + round(gm, 1) + '%' + (rising ? ' and rising (+' + round(gm - num(prev.gpuMemPct, 0), 1) + ' pts per sample)' : '') + '. Checkpoint now; next run use gradient checkpointing, a smaller batch or an 80 GB GPU.' });
  } else if (hm >= 92) {
    out.push({ alertType: 'OOM_RISK', severity: hm >= 97 ? 'CRITICAL' : 'WARNING', action: 'CHECKPOINT_NOW', message: 'Host memory at ' + round(hm, 1) + '% of the ' + round(job.reqMemGb, 0) + ' GB requested; the job will be OOM-killed if it grows. Checkpoint now and request +25% memory next time.' });
  }

  // walltime
  var elapsed = num(job.elapsedHours, 0);
  var limit = num(job.timelimitHours, 0);
  var remainingMin = (limit - elapsed) * 60;
  var plannedHours = job.runRequest && job.runRequest.chosenPlan ? num(job.runRequest.chosenPlan.estDurationHours, null) : null;
  var ckptAge = num(last.checkpointAgeMin, 0);
  if (limit > 0) {
    var overrun = plannedHours != null && plannedHours - elapsed > limit - elapsed + 0.01;
    var near = remainingMin <= Math.max(60, 2 * ap.checkpointBeforeTimeoutMin) || (remainingMin <= 180 && ckptAge > 60);
    if (overrun || near) {
      var crit = remainingMin <= Math.max(15, ap.checkpointBeforeTimeoutMin);
      out.push({
        alertType: 'WALLTIME_RISK',
        severity: crit ? 'CRITICAL' : 'WARNING',
        action: overrun ? 'EXTEND_WALLTIME' : 'CHECKPOINT_NOW',
        message: overrun
          ? 'Predicted to need ' + round(plannedHours - elapsed, 1) + ' h more but only ' + fmtMin(remainingMin) + ' of walltime remain. Request an extension or checkpoint and chain a continuation job.'
          : 'Slurm kills the job at its ' + round(limit, 1) + ' h limit in ' + fmtMin(Math.max(0, remainingMin)) + '; the last checkpoint is ' + fmtMin(ckptAge) + ' old. Checkpoint now and chain a continuation job (--dependency=afterany) if it is not done.',
      });
    }
  }

  // budget
  if (alloc && num(alloc.totalUnits, 0) > 0) {
    var hoursLeft = Math.max(0, (plannedHours != null ? Math.min(plannedHours, limit) : limit) - elapsed);
    var projected = num(alloc.usedUnits, 0) + unitsPerHour(job) * hoursLeft;
    var pct = projected / Number(alloc.totalUnits);
    var remainingUnits = Number(alloc.totalUnits) - num(alloc.usedUnits, 0);
    var endMs = ms(alloc.endDate);
    var runOutDays = burnPerDay > 0 ? Math.max(0, remainingUnits) / burnPerDay : null;
    var runsOutEarly = runOutDays != null && endMs != null && Date.now() + runOutDays * 24 * HOUR_MS < endMs;
    if (pct >= ap.budgetAlertPct) {
      var unitName = alloc.unitName || 'units';
      out.push({
        alertType: 'BUDGET_BURN',
        severity: pct >= 0.95 || runsOutEarly ? 'CRITICAL' : 'WARNING',
        action: 'NOTIFY_PI',
        message: 'At ' + round(unitsPerHour(job), 1) + ' ' + unitName + '/h this job brings the ' + (job.cluster ? job.cluster.name : '') + ' allocation to ' + round(pct * 100, 0) + '% of ' + round(alloc.totalUnits, 0) + ' ' + unitName + ' (alert at ' + round(ap.budgetAlertPct * 100, 0) + '%).' +
          (runsOutEarly ? ' At the 30-day burn of ' + round(burnPerDay, 0) + ' ' + unitName + '/day the allocation runs out in ' + Math.round(runOutDays) + ' days, before it ends on ' + new Date(endMs).toISOString().substring(0, 10) + '.' : ''),
      });
    }
  }

  // checkpoints
  if (job.partition && job.partition.preemptible && ckptAge > 30) {
    {
      out.push({ alertType: 'PREEMPTION_RISK', severity: ckptAge > 60 ? 'CRITICAL' : 'WARNING', action: 'CHECKPOINT_NOW', message: 'Preemptible partition (' + Math.round(num(job.partition.utilizationPct, 0)) + '% busy): a preemption gives 10 minutes notice, but the last checkpoint is ' + fmtMin(ckptAge) + ' old, so ~' + fmtMin(ckptAge) + ' of work would be lost.' });
    }
  }
  if (CHECKPOINTING.indexOf(wt) >= 0 && ckptAge > 120) {
    out.push({ alertType: 'STALE_CHECKPOINT', severity: ckptAge > 240 ? 'CRITICAL' : 'WARNING', action: 'CHECKPOINT_NOW', message: 'No checkpoint for ' + fmtMin(ckptAge) + '. A node failure now would lose that work; checkpoint now and save every 30-60 min.' });
  }
  return out;
}

function loadJob(id) {
  var job = Job.make({ id: id }).get('this, lab.this, cluster.this, partition.this, gpuType.this, runRequest.chosenPlan.estDurationHours');
  if (job == null) throw new Error('Job ' + id + ' not found');
  return job;
}

function activeAlerts(jobId) {
  return list(JobAlert.fetch({ filter: Filter.eq('job.id', jobId).and().intersects('status', ['OPEN', 'ACKED']), limit: 50 }).objs);
}

function evaluateHealth() {
  var job = loadJob(this.id);
  var labId = job.lab ? job.lab.id : null;
  var existing = list(JobAlert.fetch({ filter: Filter.eq('job.id', job.id), limit: 100 }).objs);
  var active = existing.filter(function (a) {
    return a.status == 'OPEN' || a.status == 'ACKED';
  });

  if (job.state != 'RUNNING') {
    var closing = active.map(function (a) {
      return JobAlert.make({ id: a.id, status: 'AUTO_RESOLVED', resolvedAt: toDt(Date.now()) });
    });
    if (closing.length) JobAlert.mergeBatch(closing);
    return [];
  }

  var samples = recentMetrics(job.id, 48);
  if (!samples.length) return active;
  var lastTs = ms(samples[samples.length - 1].ts);
  var alloc = null;
  if (labId && job.cluster) {
    alloc = list(Allocation.fetch({ filter: Filter.eq('lab.id', labId).and().eq('cluster.id', job.cluster.id), order: 'descending(endDate)', limit: 1 }).objs)[0] || null;
  }
  var burnPerDay = 0;
  if (alloc) {
    var since = new Date(lastTs - 30 * 24 * HOUR_MS).toISOString().substring(0, 10);
    var burn = Job.evaluate({
      projection: 'sum(costUnits)',
      filter: Filter.eq('lab.id', labId).and().eq('cluster.id', job.cluster.id).and("submitTime >= dateTime('" + since + "')"),
    }).tuples;
    var c0 = burn && burn.length ? burn[0].cells[0] : null;
    burnPerDay = c0 == null ? 0 : num(c0.value(), 0) / 30;
  }
  var found = detect(job, samples, autopilotFor(labId), alloc, burnPerDay);
  var foundTypes = {};
  found.forEach(function (f) {
    foundTypes[f.alertType] = f;
  });

  var writes = [];
  // per type: the active alert if any, else the most recently detected one
  var byType = {};
  existing.forEach(function (a) {
    var cur = byType[a.alertType];
    var aActive = a.status == 'OPEN' || a.status == 'ACKED';
    var curActive = cur != null && (cur.status == 'OPEN' || cur.status == 'ACKED');
    if (cur == null || (aActive && !curActive) || (aActive == curActive && ms(a.detectedAt) > ms(cur.detectedAt))) byType[a.alertType] = a;
  });
  found.forEach(function (f) {
    var a = byType[f.alertType];
    if (a && (a.status == 'OPEN' || a.status == 'ACKED')) {
      writes.push(JobAlert.make({ id: a.id, severity: f.severity, message: f.message, recommendedAction: f.action }));
      return;
    }
    // a just-resolved alert is not reopened within the hour (avoids flapping after an action)
    if (a && a.resolvedAt != null && lastTs - ms(a.resolvedAt) < HOUR_MS && lastTs - ms(a.resolvedAt) >= 0) return;
    writes.push(
      JobAlert.make({
        id: a ? a.id : job.id + '-' + f.alertType,
        job: { id: job.id },
        lab: labId ? { id: labId } : null,
        alertType: f.alertType,
        severity: f.severity,
        status: 'OPEN',
        detectedAt: toDt(lastTs),
        message: f.message,
        recommendedAction: f.action,
        autoActionTaken: false,
      })
    );
  });
  active.forEach(function (a) {
    if (!foundTypes[a.alertType]) writes.push(JobAlert.make({ id: a.id, status: 'AUTO_RESOLVED', resolvedAt: toDt(lastTs) }));
  });
  if (writes.length) JobAlert.mergeBatch(writes);

  return activeAlerts(job.id).sort(function (a, b) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || ms(b.detectedAt) - ms(a.detectedAt);
  });
}

// ---------------------------------------------------------------- actions

function standbyPartition(job) {
  if (!job.cluster) return null;
  var parts = list(Partition.fetch({ filter: Filter.eq('cluster.id', job.cluster.id).and().eq('preemptible', true), limit: 50 }).objs);
  var gt = job.gpuType ? job.gpuType.id : null;
  return (
    parts.filter(function (p) {
      return p.id != (job.partition && job.partition.id) && (p.gpuType ? p.gpuType.id : null) == gt;
    })[0] || null
  );
}

function appendSample(job, overrides) {
  var last = recentMetrics(job.id, 1)[0];
  if (last == null) return;
  var t = Math.max(Date.now(), ms(last.ts) + MIN_MS);
  var m = {
    id: job.id + '-m' + t,
    job: { id: job.id },
    ts: toDt(t),
    gpuUtilPct: last.gpuUtilPct,
    gpuMemPct: last.gpuMemPct,
    cpuUtilPct: last.cpuUtilPct,
    memPct: last.memPct,
    ioReadMBps: last.ioReadMBps,
    ioWriteMBps: last.ioWriteMBps,
    powerW: last.powerW,
    checkpointAgeMin: last.checkpointAgeMin,
    trainingLoss: last.trainingLoss,
  };
  Object.keys(overrides).forEach(function (k) {
    m[k] = overrides[k];
  });
  JobMetric.make(m).create();
}

function applyAction(actionType, actor) {
  var type = String(actionType || '').toUpperCase();
  var who = String(actor || 'USER').toUpperCase();
  if (ACTIONS.indexOf(type) < 0) throw new Error('Unsupported actionType ' + actionType + ' for a job; use one of ' + ACTIONS.join(', '));
  if (ACTORS.indexOf(who) < 0) throw new Error('Unknown actor ' + actor + '; use one of ' + ACTORS.join(', '));
  var job = loadJob(this.id);
  var now = Date.now();
  var sid = job.slurmJobId || job.id;
  var st = String(job.state);
  var live = st == 'RUNNING' || st == 'PENDING';
  var outcome = 'DONE';
  var detail;
  var update = null;

  if (!live && type != 'NOTIFY_PI') {
    outcome = 'FAILED';
    detail = 'Job ' + sid + ' is ' + st + '; ' + type + ' applies only to running or pending jobs.';
  } else if (type == 'CANCEL') {
    update = { state: 'CANCELLED', endTime: toDt(now) };
    detail = 'scancel ' + sid + ' — cancelled after ' + round(job.elapsedHours, 2) + ' h, releasing ' + num(job.allocGpus, 0) + ' GPU(s).';
  } else if (type == 'EXTEND_WALLTIME') {
    var cur = num(job.timelimitHours, 0);
    var max = num(job.partition && job.partition.maxWalltimeHours, cur * 2);
    var target = Math.min(max, cur + Math.max(2, cur * 0.25));
    if (target <= cur + 1e-9) {
      outcome = 'FAILED';
      detail = 'Time limit ' + cur + ' h is already the partition maximum (' + max + ' h); chain a continuation job instead.';
    } else if (who != 'ADMIN') {
      outcome = 'PENDING_APPROVAL';
      detail = 'Requested extension of job ' + sid + ' from ' + cur + ' h to ' + round(target, 2) + ' h. Users cannot raise a time limit in Slurm; Research Computing must run: scontrol update JobId=' + sid + ' TimeLimit=' + round(target, 2) + 'h';
    } else {
      update = { timelimitHours: round(target, 2) };
      detail = 'scontrol update JobId=' + sid + ' TimeLimit=' + round(target, 2) + 'h — extended from ' + cur + ' h.';
    }
  } else if (type == 'REQUEUE_STANDBY') {
    var sp = standbyPartition(job);
    if (sp == null) {
      outcome = 'FAILED';
      detail = 'No preemptible/standby partition with ' + (job.gpuType ? job.gpuType.id : 'the same hardware') + ' on ' + (job.cluster ? job.cluster.name : 'this cluster') + '.';
    } else {
      var q = sp.qos ? String(sp.qos) : /standby/i.test(String(sp.name || sp.id)) ? 'standby' : 'preemptible';
      update = { partition: { id: sp.id }, qos: q, state: 'PENDING' };
      detail = 'scontrol requeue ' + sid + ' && scontrol update JobId=' + sid + ' Partition=' + (sp.slurmPartition || sp.name || sp.id) + ' QOS=' + q + ' — requeued to ' + (sp.name || sp.id) + ' (' + round(num(sp.chargeFactor, 0), 2) + 'x charge), resuming from the last checkpoint.';
    }
  } else if (type == 'CHECKPOINT_NOW') {
    if (st != 'RUNNING') {
      outcome = 'FAILED';
      detail = 'Job ' + sid + ' is not running.';
    } else {
      appendSample(job, { checkpointAgeMin: 0, ioWriteMBps: 850 });
      detail = 'scancel --signal=USR1 --batch ' + sid + ' — checkpoint signal sent; checkpoint written.';
    }
  } else if (type == 'SCALE_DOWN') {
    var g = num(job.allocGpus, 0);
    if (g <= 1) {
      outcome = 'FAILED';
      detail = 'Job ' + sid + ' already uses ' + g + ' GPU.';
    } else {
      var ng = Math.max(1, Math.floor(g / 2));
      var gpn = Math.max(1, num(job.partition && job.partition.gpusPerNode, ng));
      update = { allocGpus: ng, allocNodes: Math.ceil(ng / gpn), allocCpus: Math.max(1, Math.round((num(job.allocCpus, g) * ng) / g)) };
      if (st == 'RUNNING') {
        var last = recentMetrics(job.id, 1)[0];
        if (last) appendSample(job, { gpuUtilPct: Math.min(95, round((num(last.gpuUtilPct, 0) * g) / ng, 1)), powerW: round((num(last.powerW, 0) * ng) / g, 0), checkpointAgeMin: 0 });
      }
      detail = 'Checkpointed and resubmitted with --gres=gpu:' + ng + ' (was ' + g + '), freeing ' + (g - ng) + ' GPU(s) (~' + (g - ng) * 24 + ' GPU-hours/day).';
    }
  } else if (type == 'NOTIFY_PI') {
    var lab = job.lab || {};
    var open = activeAlerts(job.id);
    detail = 'Emailed ' + (lab.piName || 'the PI') + ' <' + (lab.piEmail || 'pi@purdue.edu') + '>: job ' + sid + ' (' + (job.jobName || '') + ', user ' + (job.user || '?') + ') on ' + (job.cluster ? job.cluster.name : '') + ' — ' +
      (open.length ? open.map(function (a) { return a.alertType + ' (' + a.severity + ')'; }).join(', ') : 'status update: ' + st) + '.';
  } else if (type == 'HOLD') {
    if (st != 'PENDING') {
      outcome = 'FAILED';
      detail = 'Only pending jobs can be held; job ' + sid + ' is ' + st + '.';
    } else {
      detail = 'scontrol hold ' + sid + ' — job stays queued until released (scontrol release ' + sid + ').';
    }
  }

  if (update) {
    update.id = job.id;
    if (update.allocGpus != null) {
      update.elapsedHours = job.elapsedHours;
      update.gpuUtilAvg = job.gpuUtilAvg;
    }
    Job.make(update).merge();
  }

  if (outcome == 'DONE' && RESOLVES[type]) {
    var fix = RESOLVES[type];
    var resolved = activeAlerts(job.id)
      .filter(function (a) {
        return fix.indexOf(String(a.alertType)) >= 0;
      })
      .map(function (a) {
        return JobAlert.make({ id: a.id, status: 'RESOLVED', resolvedAt: toDt(now), autoActionTaken: who == 'AUTOPILOT' ? true : a.autoActionTaken });
      });
    if (resolved.length) JobAlert.mergeBatch(resolved);
  }

  var created = ActionLogEntry.make({
    lab: job.lab ? { id: job.lab.id } : null,
    job: { id: job.id },
    actionType: type,
    actor: who,
    actedAt: toDt(now),
    detail: detail,
    outcome: outcome,
  }).create();
  log.info('applyAction {} {} by {} -> {}', job.id, type, who, outcome);
  return ActionLogEntry.make({ id: created.id }).get('this');
}
