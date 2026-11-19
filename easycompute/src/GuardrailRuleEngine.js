/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('GuardrailRuleEngine');

var VERSION = 'guardrails-hysteresis-v1';
var MIN_MS = 60 * 1000;
var HOUR_MS = 60 * MIN_MS;
var SEVERITY_RANK = { CRITICAL: 0, WARNING: 1, INFO: 2 };
var CHECKPOINTING = ['TRAINING', 'FINETUNE', 'SIMULATION'];

/**
 * Job columns read by core actions. Explicit (never `this`) so a column added later and not yet migrated in a workspace
 * database cannot break cancel / checkpoint / health evaluation.
 */
var JOB_CORE_FIELDS =
  'id, slurmJobId, lab.id, lab.name, lab.piName, lab.piEmail, project.id, user, cluster.id, cluster.name, cluster.unitName, cluster.usdPerUnit, partition.id, partition.name, partition.cluster, partition.gpuType, partition.slurmPartition, partition.qos, partition.preemptible, partition.utilizationPct, partition.chargeFactor, partition.gpusPerNode, partition.maxWalltimeHours, account, qos, jobName, workloadType, state, submitTime, startTime, endTime, timelimitHours, elapsedHours, allocCpus, allocNodes, allocGpus, gpuType.id, gpuType.costPerGpuHourUsd, reqMemGb, maxRssGb, cpuEfficiency, memEfficiency, gpuUtilAvg, costUnits, costUsd, exitCode, nodeList, isLive, runRequest.chosenPlan.estDurationHours';

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

function plainJson(v) {
  if (v == null) return v;
  if (typeof v === 'string') return JSON.parse(v);
  if (typeof v.type === 'string' && /^Boxed/.test(v.type) && v.value != null) return v.value;
  return v;
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
    budgetAlertPct: num(ap && ap.budgetAlertPct, 0.8) || 0.8,
  };
}

/** Allocation units charged per hour by this job. */
function unitsPerHour(job) {
  var factor = num(job.partition && job.partition.chargeFactor, 1);
  var gpus = num(job.allocGpus, 0);
  var rate = factor;
  if (job.cluster && String(job.cluster.unitName) == 'USD') rate = factor * num(job.gpuType && job.gpuType.costPerGpuHourUsd, 1);
  return (gpus > 0 ? gpus : num(job.allocCpus, 1)) * rate;
}

function engineProvenance(samples) {
  return { component: 'GuardrailRuleEngine', version: VERSION, method: 'state machine with hysteresis (separate enter / exit thresholds per guardrail); consequential actions need user confirmation', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: samples.length, historicalOnly: false, computedAt: new Date().toISOString() };
}

/**
 * Guardrails as a state machine. Each rule has an ENTER condition (opens an alert) and a looser EXIT condition: while an
 * alert is active it stays active until the exit condition clears, so values hovering around a threshold do not flap.
 * Returns [{ alertType, severity, action, message, firedRule, evidence, state: 'ENTER' | 'HOLD', extraProvenance }].
 */
function detect(job, samples, ap, alloc, burnPerDay, estimate, active, under) {
  var out = [];
  if (!samples.length) return out;
  var last = samples[samples.length - 1];
  var lastTs = ms(last.ts);
  var win = samples.filter(function (s) {
    return ms(s.ts) >= lastTs - HOUR_MS;
  });
  var window = { samples: win.length, from: new Date(ms(win[0].ts)).toISOString(), to: new Date(lastTs).toISOString() };
  var prev = samples.length > 1 ? samples[samples.length - 2] : null;
  var gpus = num(job.allocGpus, 0);
  var wt = String(job.workloadType || '');
  var mean = function (f) {
    return win.reduce(function (s, x) { return s + num(x[f], 0); }, 0) / win.length;
  };
  var push = function (type, isActive, enterNow, holdNow, f) {
    if (enterNow || (isActive && holdNow)) {
      f.alertType = type;
      f.state = enterNow ? 'ENTER' : 'HOLD';
      f.evidence.window = window;
      if (!enterNow) f.message += ' (Holding: ' + f.evidence.exit + ' not yet met.)';
      out.push(f);
    }
  };

  // node failure: power and utilization dropped to zero after a live sample (no hysteresis: a fact)
  if (gpus > 0 && num(last.powerW, 1) === 0 && num(last.gpuUtilPct, 1) === 0 && prev != null && num(prev.powerW, 0) > 0) {
    out.push({ alertType: 'NODE_FAILURE', state: 'ENTER', severity: 'CRITICAL', action: 'REQUEUE_STANDBY', firedRule: 'NODE_FAILURE.enter: powerW == 0 && gpuUtilPct == 0 after powerW > 0', evidence: { powerW: num(last.powerW, 0), previousPowerW: num(prev.powerW, 0), gpuUtilPct: num(last.gpuUtilPct, 0), checkpointAgeMin: num(last.checkpointAgeMin, 0), enter: 'powerW == 0 && gpuUtil == 0 after a live sample', exit: 'n/a (job is failed or requeued)', window: window }, message: 'Node ' + (String(job.nodeList || '').split(',')[0] || 'unknown') + ' stopped reporting: GPU power fell from ' + Math.round(num(prev.powerW, 0)) + ' W to 0 W. Requeue from the last checkpoint (' + fmtMin(num(last.checkpointAgeMin, 0)) + ' old).' });
    return out;
  }

  // hung: nothing moves
  var lossFlat = function (s) {
    return last.trainingLoss == null || s.trainingLoss == null || Math.abs(num(s.trainingLoss, 0) - num(last.trainingLoss, 0)) < 1e-4;
  };
  var hungMin = trailingMinutes(samples, function (s) {
    return num(s.gpuUtilPct, 0) < 2 && num(s.cpuUtilPct, 0) < 3 && num(s.ioReadMBps, 0) + num(s.ioWriteMBps, 0) < 1 && lossFlat(s);
  });
  push('HUNG_JOB', active.HUNG_JOB, hungMin >= 30, num(last.gpuUtilPct, 0) < 5 && num(last.cpuUtilPct, 0) < 10, {
    severity: hungMin >= 60 || active.HUNG_JOB ? 'CRITICAL' : 'WARNING',
    action: 'CANCEL',
    firedRule: 'HUNG_JOB.enter: gpu < 2% && cpu < 3% && io < 1 MB/s && loss flat for >= 30 min',
    evidence: { hungMinutes: Math.round(hungMin), gpuUtilPct: num(last.gpuUtilPct, 0), cpuUtilPct: num(last.cpuUtilPct, 0), ioMBps: round(num(last.ioReadMBps, 0) + num(last.ioWriteMBps, 0), 2), enter: 'no GPU/CPU/I/O/progress for 30 min', exit: 'gpu >= 5% or cpu >= 10%' },
    message: 'No GPU, CPU or I/O activity and no training progress for ' + fmtMin(hungMin) + ' (GPU ' + round(last.gpuUtilPct, 0) + '%, CPU ' + round(last.cpuUtilPct, 0) + '%). The process is likely deadlocked; cancel or requeue from the checkpoint.',
  });

  if (gpus > 0) {
    var idleMin = under && under.applicable ? under.idleMinutes : trailingMinutes(samples, function (s) { return num(s.gpuUtilPct, 0) < 5; });
    var critical = idleMin >= ap.cancelIdleAfterMin;
    push('IDLE_GPU', active.IDLE_GPU, idleMin >= 30, num(last.gpuUtilPct, 0) < 15, {
      severity: critical ? 'CRITICAL' : 'WARNING',
      action: 'CANCEL',
      firedRule: 'IDLE_GPU.enter: gpuUtil < 5% for >= 30 min' + (critical ? '; CRITICAL at >= ' + ap.cancelIdleAfterMin + ' min (lab limit)' : ''),
      evidence: { idleMinutes: idleMin, gpus: gpus, gpuUtilPct: num(last.gpuUtilPct, 0), wastedGpuHours: round((gpus * idleMin) / 60, 1), cancelIdleAfterMin: ap.cancelIdleAfterMin, enter: 'util < 5% for 30 min', exit: 'util >= 15%' },
      message: gpus + ' GPU(s) idle (<5% utilization) for ' + fmtMin(idleMin) + ' while the job holds them' + (critical ? '; past the lab\'s ' + ap.cancelIdleAfterMin + '-minute idle limit.' : '; autopilot proposes cancelling at ' + ap.cancelIdleAfterMin + ' min.') + ' Wasting ~' + round((gpus * idleMin) / 60, 1) + ' GPU-hours so far.',
      extraProvenance: under ? under.provenance : null,
    });
    var longEnough = win.length >= 3 && (ms(win[win.length - 1].ts) - ms(win[0].ts)) / MIN_MS >= 40;
    var u = mean('gpuUtilPct');
    var cusumHit = under && under.applicable && under.persistentUnderuse && num(last.gpuUtilPct, 0) >= 5;
    var lowEnter = !(idleMin >= 30) && longEnough && ((u >= 5 && u < 45) || cusumHit);
    var lowHold = !(idleMin >= 30) && (u < 55 || (under && under.applicable && under.ewma < under.baselineUtil - 10));
    push('LOW_GPU_UTIL', active.LOW_GPU_UTIL, lowEnter, lowHold, {
      severity: 'WARNING',
      action: gpus > 1 ? 'SCALE_DOWN' : 'NOTIFY_PI',
      firedRule: cusumHit ? 'LOW_GPU_UTIL.enter: CUSUM ' + under.cusum + ' > ' + under.threshold + ' below the run\'s ' + under.baselineUtil + '% baseline' : 'LOW_GPU_UTIL.enter: 1-hour mean gpuUtil < 45%',
      evidence: { meanGpuUtilPct: round(u, 1), baselineUtil: under ? under.baselineUtil : null, ewma: under ? under.ewma : null, cusum: under ? under.cusum : null, cusumThreshold: under ? under.threshold : null, meanIoReadMBps: round(mean('ioReadMBps'), 0), enter: 'mean < 45% over >= 40 min, or CUSUM above threshold', exit: 'mean >= 55% and EWMA within 10 pts of baseline' },
      message: 'GPU utilization averaged ' + round(u, 0) + '% over the last hour on ' + gpus + ' GPU(s)' + (under && under.applicable ? ' (EWMA ' + under.ewma + '% vs a ' + under.baselineUtil + '% baseline for this run)' : '') + (mean('ioReadMBps') > 300 ? ' with heavy reads (' + Math.round(mean('ioReadMBps')) + ' MB/s): likely data-loader bound; add --cpus-per-task workers.' : '.') + (gpus > 1 ? ' Halving to ' + Math.max(1, Math.floor(gpus / 2)) + ' GPU(s) would save ~' + round((gpus - Math.max(1, Math.floor(gpus / 2))) * 24, 0) + ' GPU-hours/day.' : ' A smaller GPU (A30/L40S) would cost less.'),
      extraProvenance: under ? under.provenance : null,
    });
  }

  // memory pressure
  var gm = num(last.gpuMemPct, 0);
  var rising = prev != null && gm - num(prev.gpuMemPct, 0) >= 2;
  var hm = num(last.memPct, 0);
  var gpuEnter = gpus > 0 && (gm >= 95 || (gm >= 88 && rising));
  push('OOM_RISK', active.OOM_RISK, gpuEnter || hm >= 92, (gpus > 0 && gm >= 90) || hm >= 88, {
    severity: gm >= 97 || hm >= 97 ? 'CRITICAL' : 'WARNING',
    action: 'CHECKPOINT_NOW',
    firedRule: gpuEnter || (gpus > 0 && gm >= hm) ? 'OOM_RISK.enter: gpuMemPct >= 95 (or >= 88 and rising >= 2 pts/sample)' : 'OOM_RISK.enter: host memPct >= 92',
    evidence: { gpuMemPct: gm, risingPtsPerSample: prev != null ? round(gm - num(prev.gpuMemPct, 0), 1) : null, hostMemPct: hm, reqMemGb: num(job.reqMemGb, null), enter: 'GPU mem >= 95% (88% rising) or host mem >= 92%', exit: 'GPU mem < 90% and host mem < 88%' },
    message: gpus > 0 && gm >= hm
      ? 'GPU memory at ' + round(gm, 1) + '%' + (rising ? ' and rising (+' + round(gm - num(prev.gpuMemPct, 0), 1) + ' pts per sample)' : '') + '. Checkpoint now; next run use gradient checkpointing, a smaller batch or an 80 GB GPU.'
      : 'Host memory at ' + round(hm, 1) + '% of the ' + round(job.reqMemGb, 0) + ' GB requested; the job will be OOM-killed if it grows. Checkpoint now and request +25% memory next time.',
  });

  // walltime
  var elapsed = num(job.elapsedHours, 0);
  var limit = num(job.timelimitHours, 0);
  var remainingMin = (limit - elapsed) * 60;
  var ckptAge = num(last.checkpointAgeMin, 0);
  if (limit > 0) {
    var expected = estimate ? estimate.hours : null;
    var overrun = expected != null && expected - elapsed > limit - elapsed + 0.01;
    var enterWindow = Math.max(60, 2 * ap.checkpointBeforeTimeoutMin);
    var near = remainingMin <= enterWindow || (remainingMin <= 180 && ckptAge > 60);
    var crit = remainingMin <= Math.max(15, ap.checkpointBeforeTimeoutMin);
    push('WALLTIME_RISK', active.WALLTIME_RISK, overrun || near, overrun || remainingMin <= enterWindow * 1.5, {
      severity: crit ? 'CRITICAL' : 'WARNING',
      action: overrun ? 'EXTEND_WALLTIME' : 'CHECKPOINT_NOW',
      firedRule: overrun ? 'WALLTIME_RISK.enter: expected total (' + estimate.source + ') > time limit' : 'WALLTIME_RISK.enter: remaining <= ' + enterWindow + ' min (or <= 180 min with checkpoint > 60 min old)',
      evidence: { elapsedHours: round(elapsed, 2), timelimitHours: limit, remainingMin: Math.round(remainingMin), checkpointAgeMin: ckptAge, expectedTotalHours: expected == null ? null : round(expected, 2), expectedSource: estimate ? estimate.source : null, enter: 'expected > limit, or remaining <= ' + enterWindow + ' min', exit: 'remaining > ' + Math.round(enterWindow * 1.5) + ' min and no expected overrun' },
      message: overrun
        ? estimate.label + ' ' + round(expected, 1) + ' h in total: ' + round(expected - elapsed, 1) + ' h more, but only ' + fmtMin(remainingMin) + ' of walltime remain. Request an extension or checkpoint and chain a continuation job.'
        : 'Slurm kills the job at its ' + round(limit, 1) + ' h limit in ' + fmtMin(Math.max(0, remainingMin)) + '; the last checkpoint is ' + fmtMin(ckptAge) + ' old. Checkpoint now and chain a continuation job (--dependency=afterany) if it is not done.',
      extraProvenance: estimate ? estimate.provenance : null,
    });
  }

  // budget
  if (alloc && num(alloc.totalUnits, 0) > 0) {
    var hoursLeft = Math.max(0, (estimate ? Math.min(estimate.hours, limit) : limit) - elapsed);
    var projected = num(alloc.usedUnits, 0) + unitsPerHour(job) * hoursLeft;
    var pct = projected / Number(alloc.totalUnits);
    var remainingUnits = Number(alloc.totalUnits) - num(alloc.usedUnits, 0);
    var endMs = ms(alloc.endDate);
    var runOutDays = burnPerDay > 0 ? Math.max(0, remainingUnits) / burnPerDay : null;
    var runsOutEarly = runOutDays != null && endMs != null && Date.now() + runOutDays * 24 * HOUR_MS < endMs;
    var unitName = alloc.unitName || 'units';
    push('BUDGET_BURN', active.BUDGET_BURN, pct >= ap.budgetAlertPct, pct >= ap.budgetAlertPct - 0.03, {
      severity: pct >= 0.95 || runsOutEarly ? 'CRITICAL' : 'WARNING',
      action: 'NOTIFY_PI',
      firedRule: 'BUDGET_BURN.enter: projected allocation use >= ' + round(ap.budgetAlertPct * 100, 0) + '% (lab autopilot setting)',
      evidence: { projectedPct: round(pct, 4), usedUnits: round(num(alloc.usedUnits, 0), 1), totalUnits: round(num(alloc.totalUnits, 0), 1), jobUnitsPerHour: round(unitsPerHour(job), 2), hoursLeft: round(hoursLeft, 2), burnPerDay30d: round(burnPerDay, 1), runOutDays: runOutDays == null ? null : round(runOutDays, 1), unitName: unitName, enter: '>= ' + round(ap.budgetAlertPct * 100, 0) + '%', exit: '< ' + round((ap.budgetAlertPct - 0.03) * 100, 0) + '%' },
      message: 'At ' + round(unitsPerHour(job), 1) + ' ' + unitName + '/h this job brings the ' + (job.cluster ? job.cluster.name : '') + ' allocation to ' + round(pct * 100, 0) + '% of ' + round(alloc.totalUnits, 0) + ' ' + unitName + ' (alert at ' + round(ap.budgetAlertPct * 100, 0) + '%).' +
        (runsOutEarly ? ' At the 30-day burn of ' + round(burnPerDay, 0) + ' ' + unitName + '/day the allocation runs out in ' + Math.round(runOutDays) + ' days, before it ends on ' + new Date(endMs).toISOString().substring(0, 10) + '.' : ''),
    });
  }

  // checkpoints
  if (job.partition && job.partition.preemptible) {
    push('PREEMPTION_RISK', active.PREEMPTION_RISK, ckptAge > 30, ckptAge > 15, {
      severity: ckptAge > 60 ? 'CRITICAL' : 'WARNING',
      action: 'CHECKPOINT_NOW',
      firedRule: 'PREEMPTION_RISK.enter: preemptible partition && checkpointAgeMin > 30',
      evidence: { checkpointAgeMin: ckptAge, partitionUtilizationPct: num(job.partition.utilizationPct, 0), graceMin: 10, enter: 'checkpoint > 30 min old', exit: 'checkpoint <= 15 min old' },
      message: 'Preemptible partition (' + Math.round(num(job.partition.utilizationPct, 0)) + '% busy): a preemption gives 10 minutes notice, but the last checkpoint is ' + fmtMin(ckptAge) + ' old, so ~' + fmtMin(ckptAge) + ' of work would be lost.',
    });
  }
  if (CHECKPOINTING.indexOf(wt) >= 0) {
    push('STALE_CHECKPOINT', active.STALE_CHECKPOINT, ckptAge > 120, ckptAge > 60, {
      severity: ckptAge > 240 ? 'CRITICAL' : 'WARNING',
      action: 'CHECKPOINT_NOW',
      firedRule: 'STALE_CHECKPOINT.enter: checkpointAgeMin > 120 (training / fine-tune / simulation)',
      evidence: { checkpointAgeMin: ckptAge, enter: '> 120 min', exit: '<= 60 min' },
      message: 'No checkpoint for ' + fmtMin(ckptAge) + '. A node failure now would lose that work; checkpoint now and save every 30-60 min.',
    });
  }
  return out;
}

function loadJob(id) {
  var job = Job.make({ id: id }).get(JOB_CORE_FIELDS);
  if (job == null) throw new Error('Job ' + id + ' not found');
  return job;
}

/**
 * Expected total runtime for WALLTIME_RISK: the planner's estimate, else the AnvilRuntimeQ50Q90 champion P50 (Anvil jobs
 * with enough support), else the C3-built JobDurationModel challenger (labeled as challenger evidence).
 */
function expectedRuntime(job) {
  if (job.runRequest && job.runRequest.chosenPlan && job.runRequest.chosenPlan.estDurationHours != null) {
    return { hours: Number(job.runRequest.chosenPlan.estDurationHours), source: 'plan', label: 'The launch plan predicted', provenance: null };
  }
  if (job.cluster && String(job.cluster.id) == 'anvil' && job.partition) {
    var start = ms(job.startTime) || ms(job.submitTime) || Date.now();
    var d = new Date(start);
    var r = plainJson(
      QuantileModel.predict('AnvilRuntimeQ50Q90', {
        partition: String(job.partition.slurmPartition || job.partition.name || ''),
        reqCpus: num(job.allocCpus, 1),
        reqNodes: num(job.allocNodes, 1),
        reqMemGiB: num(job.reqMemGb, null),
        reqGpus: num(job.allocGpus, 0),
        walltimeHours: num(job.timelimitHours, null),
        submitHour: d.getUTCHours(),
        submitWeekday: (d.getUTCDay() + 6) % 7,
        submitMonth: d.getUTCMonth() + 1,
      })
    );
    if (r && r.available && !r.lowSupport && r.p50 != null) return { hours: r.p50, source: 'AnvilRuntimeQ50Q90', label: 'AnvilRuntimeQ50Q90 (historical P50) predicts', provenance: r.provenance };
  }
  if (typeof JobPrediction !== 'undefined') {
    var p = JobPrediction.make({ id: job.id }).get('predictedHours, modelId, scoredAt');
    if (p != null && p.predictedHours != null) {
      return { hours: Number(p.predictedHours), source: 'JobDurationModel (challenger)', label: 'The challenger job-duration model' + (p.modelId ? ' (' + p.modelId + ')' : '') + ' predicts', provenance: { component: 'JobDurationModel', version: p.modelId || null, method: 'C3 MlProject job-duration (native-ai)', status: 'CHALLENGER', trainingPeriod: null, sampleSupport: null, historicalOnly: false, computedAt: p.scoredAt == null ? null : new Date(ms(p.scoredAt)).toISOString() } };
    }
  }
  return null;
}

function evaluate(jobId) {
  var job = loadJob(jobId);
  var labId = job.lab ? job.lab.id : null;
  var existing = list(JobAlert.fetch({ filter: Filter.eq('job.id', job.id), limit: 100 }).objs);
  var activeList = existing.filter(function (a) {
    return a.status == 'OPEN' || a.status == 'ACKED';
  });

  if (job.state != 'RUNNING') {
    var closing = activeList.map(function (a) {
      return JobAlert.make({ id: a.id, status: 'AUTO_RESOLVED', resolvedAt: toDt(Date.now()) });
    });
    if (closing.length) JobAlert.mergeBatch(closing);
    return [];
  }

  var samples = recentMetrics(job.id, 48);
  if (!samples.length) return activeList;
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
  var activeTypes = {};
  activeList.forEach(function (a) {
    activeTypes[a.alertType] = true;
  });
  var under = num(job.allocGpus, 0) > 0 ? plainJson(GPUUnderuseDetector.analyze(job.id)) : null;
  var found = detect(job, samples, autopilotFor(labId), alloc, burnPerDay, expectedRuntime(job), activeTypes, under);
  var foundTypes = {};
  found.forEach(function (f) {
    foundTypes[f.alertType] = f;
  });
  var eng = engineProvenance(samples);

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
    var prov = [eng].concat(f.extraProvenance ? [f.extraProvenance] : []);
    var a = byType[f.alertType];
    if (a && (a.status == 'OPEN' || a.status == 'ACKED')) {
      var upd = { id: a.id, severity: f.severity, message: f.message, recommendedAction: f.action, evidence: f.evidence, provenance: prov };
      if (f.state == 'ENTER') upd.firedRule = f.firedRule;
      writes.push(JobAlert.make(upd));
      return;
    }
    if (f.state != 'ENTER') return;
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
        firedRule: f.firedRule,
        evidence: f.evidence,
        provenance: prov,
      })
    );
  });
  activeList.forEach(function (a) {
    if (!foundTypes[a.alertType]) writes.push(JobAlert.make({ id: a.id, status: 'AUTO_RESOLVED', resolvedAt: toDt(lastTs) }));
  });
  if (writes.length) JobAlert.mergeBatch(writes);
  log.info('evaluate {}: {} guardrails active', job.id, found.length);

  return list(JobAlert.fetch({ filter: Filter.eq('job.id', job.id).and().intersects('status', ['OPEN', 'ACKED']), limit: 50 }).objs).sort(function (a, b) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || ms(b.detectedAt) - ms(a.detectedAt);
  });
}
