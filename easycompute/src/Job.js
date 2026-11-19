/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('Job');

var MIN_MS = 60 * 1000;
var HOUR_MS = 60 * MIN_MS;
var ACTIONS = ['CANCEL', 'EXTEND_WALLTIME', 'REQUEUE_STANDBY', 'CHECKPOINT_NOW', 'SCALE_DOWN', 'NOTIFY_PI', 'HOLD'];
var ACTORS = ['USER', 'AUTOPILOT', 'ADMIN'];
/** Alerts an action addresses (resolved when the action succeeds). */
var RESOLVES = {
  CANCEL: ['IDLE_GPU', 'LOW_GPU_UTIL', 'OOM_RISK', 'WALLTIME_RISK', 'BUDGET_BURN', 'HUNG_JOB', 'NODE_FAILURE', 'PREEMPTION_RISK', 'STALE_CHECKPOINT'],
  CHECKPOINT_NOW: ['STALE_CHECKPOINT', 'PREEMPTION_RISK', 'WALLTIME_RISK', 'OOM_RISK'],
  SCALE_DOWN: ['LOW_GPU_UTIL', 'IDLE_GPU'],
  REQUEUE_STANDBY: ['NODE_FAILURE', 'LOW_GPU_UTIL'],
  EXTEND_WALLTIME: ['WALLTIME_RISK'],
};
/** Actions that change a running job: autopilot proposes them and a user confirms (GuardrailRuleEngine). */
var CONSEQUENTIAL = ['CANCEL', 'SCALE_DOWN', 'REQUEUE_STANDBY'];

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

/** The job's latest samples, oldest first. */
function recentMetrics(jobId, n) {
  return list(JobMetric.fetch({ filter: Filter.eq('job.id', jobId), order: 'descending(ts)', limit: n || 48 }).objs).reverse();
}

// ---------------------------------------------------------------- health (GuardrailRuleEngine)

/** Health rules live in GuardrailRuleEngine (state machine with hysteresis, evidence, provenance). */
function evaluateHealth() {
  return GuardrailRuleEngine.evaluate(this.id);
}

function loadJob(id) {
  var job = Job.make({ id: id }).get(JOB_CORE_FIELDS);
  if (job == null) throw new Error('Job ' + id + ' not found');
  return job;
}

function activeAlerts(jobId) {
  return list(JobAlert.fetch({ filter: Filter.eq('job.id', jobId).and().intersects('status', ['OPEN', 'ACKED']), limit: 50 }).objs);
}

// ---------------------------------------------------------------- actions

/** A `json` result of another type's method as a plain object (it may arrive boxed or as a string). */
function plainJson(v) {
  if (v == null) return v;
  if (typeof v === 'string') return JSON.parse(v);
  if (typeof v.type === 'string' && /^Boxed/.test(v.type) && v.value != null) return v.value;
  return v;
}

/** Lab scope for user actions: students/staff act on their own jobs, PIs on their lab's jobs, admins on all. */
function checkActingUser(job, type) {
  var who = plainJson(UserAdmin.whoAmI());
  if (who.isDefault) return; // no demo identity chosen: default context is not lab-restricted
  var me = who.user;
  var labId = job.lab ? String(job.lab.id) : null;
  if (me.role == 'UNIVERSITY_ADMIN') return;
  if (me.role == 'PI' && me.labId == labId) return;
  if ((me.role == 'STUDENT' || me.role == 'STAFF') && me.labId == labId && String(job.user) == String(me.username)) return;
  throw new Error(me.name + ' (' + me.role + ') may not ' + type + ' job ' + job.id + ' of ' + (job.user || 'another user') + (me.role == 'PI' ? ' outside their lab.' : '; members act only on their own jobs.'));
}

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
  if (who == 'USER') checkActingUser(job, type);
  var now = Date.now();
  var sid = job.slurmJobId || job.id;
  var st = String(job.state);
  var live = st == 'RUNNING' || st == 'PENDING';
  var outcome = 'DONE';
  var detail;
  var update = null;

  if (who == 'AUTOPILOT' && CONSEQUENTIAL.indexOf(type) >= 0 && live) {
    outcome = 'PENDING_APPROVAL';
    detail = 'Autopilot proposes ' + type + ' for job ' + sid + ' (' + (job.jobName || '') + ', user ' + (job.user || '?') + '): ' +
      activeAlerts(job.id).map(function (a) { return a.alertType + ' ' + a.severity; }).join(', ') + '. Waiting for the job owner, PI or Research Computing to confirm (UserAdmin.approve).';
  } else if (!live && type != 'NOTIFY_PI') {
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
