/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('Insights');

var DAY_MS = 24 * 3600 * 1000;
var WORKLOADS = ['TRAINING', 'FINETUNE', 'INFERENCE', 'SIMULATION', 'DATA_PROCESSING', 'INTERACTIVE'];
var STATES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'OUT_OF_MEMORY', 'PREEMPTED'];
/** A100-40GB GPU-hours of a typical job when there is no history (core-hours for CPU work). */
var PRIOR_WORK = { TRAINING: 40, FINETUNE: 12, INFERENCE: 2, SIMULATION: 24, DATA_PROCESSING: 4, INTERACTIVE: 3 };
var PRIOR_CPU_WORK = { TRAINING: 256, FINETUNE: 128, INFERENCE: 32, SIMULATION: 1536, DATA_PROCESSING: 96, INTERACTIVE: 8 };
/** Model size (billions of parameters) the history medians are assumed to describe. */
var REF_PARAMS_B = { TRAINING: 1, FINETUNE: 7, INFERENCE: 7 };

// ---------------------------------------------------------------- helpers

function plainJson(v) {
  if (v == null) return v;
  if (typeof v === 'string') return JSON.parse(v);
  if (typeof v.type === 'string' && /^Boxed/.test(v.type) && v.value != null) return v.value;
  return v;
}

function ms(v) {
  return v == null ? null : Date.parse(String(v));
}

function iso(v) {
  var t = ms(v);
  return t == null || isNaN(t) ? null : new Date(t).toISOString();
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

function cellNum(tuple, idx) {
  var v = cellValue(tuple, idx);
  return v == null ? 0 : Number(v);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  var pos = (sorted.length - 1) * q;
  var lo = Math.floor(pos);
  var hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function fmtHours(h) {
  if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min';
  if (h < 48) return round(h, 1) + ' h';
  return round(h / 24, 1) + ' days';
}

/** Monday (UTC) of the ISO week containing t, as YYYY-MM-DD. */
function weekKey(t) {
  var d = new Date(t);
  var day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().substring(0, 10);
}

function lastWeeks(n, now) {
  var keys = [];
  var monday = Date.parse(weekKey(now) + 'T00:00:00Z');
  for (var i = n - 1; i >= 0; i--) keys.push(new Date(monday - i * 7 * DAY_MS).toISOString().substring(0, 10));
  return keys;
}

function gpuTypeMap() {
  var m = {};
  list(GpuType.fetch({ limit: 200 }).objs).forEach(function (g) {
    m[g.id] = g;
  });
  return m;
}

/** GPU-hours of a job (allocated GPUs x elapsed hours). */
function jobGpuHours(j) {
  return num(j.allocGpus, 0) * num(j.elapsedHours, 0);
}

/** GPU-hours allocated but idle: GPU-hours x (100 - average GPU utilization) / 100; 0 without utilization data. */
function jobWastedGpuHours(j) {
  return j.gpuUtilAvg == null ? 0 : (jobGpuHours(j) * (100 - num(j.gpuUtilAvg, 0))) / 100;
}

// ---------------------------------------------------------------- predictDuration

function memoryNeedGb(workloadType, paramsB) {
  if (!(paramsB > 0)) return 0;
  if (workloadType == 'TRAINING' || workloadType == 'FINETUNE') return paramsB * 16 * 1.2;
  if (workloadType == 'INFERENCE' || workloadType == 'INTERACTIVE') return paramsB * 2 * 1.2;
  return 0;
}

function predictDuration(workloadType, gpuTypeId, gpus, modelParamsB, labId) {
  var wt = String(workloadType || 'TRAINING').toUpperCase();
  if (WORKLOADS.indexOf(wt) < 0) throw new Error('Unknown workloadType ' + workloadType + '; use one of ' + WORKLOADS.join(', '));
  var cpu = gpuTypeId == null || String(gpuTypeId).toUpperCase() == 'CPU' || gpuTypeId === '';
  var types = gpuTypeMap();
  var target = cpu ? null : types[gpuTypeId];
  if (!cpu && target == null) throw new Error('GpuType ' + gpuTypeId + ' not found');
  gpus = Math.max(1, num(gpus, 1));
  var paramsB = num(modelParamsB, 0);

  // per-job work in A100-40GB GPU-hours (GPU) or core-hours (CPU) over completed jobs of this workload
  var all = [];
  var same = [];
  var mine = [];
  var filter = Filter.eq('workloadType', wt).and().eq('state', 'COMPLETED').and(cpu ? 'allocGpus == 0 && elapsedHours >= 0.25' : 'allocGpus > 0 && elapsedHours >= 0.25');
  Job.fetchObjStream({ filter: filter, include: 'elapsedHours, allocGpus, allocCpus, gpuType, lab' }).each(function (j) {
    var w;
    if (cpu) {
      w = num(j.elapsedHours, 0) * Math.max(1, num(j.allocCpus, 1));
    } else {
      var g = j.gpuType ? types[j.gpuType.id] : null;
      w = num(j.elapsedHours, 0) * num(j.allocGpus, 1) * (g ? num(g.relativeThroughput, 1) : 1);
      if (j.gpuType && j.gpuType.id == gpuTypeId) same.push(w);
    }
    all.push(w);
    if (labId && j.lab && j.lab.id == labId) mine.push(w);
  });
  var numSort = function (a, b) {
    return a - b;
  };
  all.sort(numSort);
  same.sort(numSort);
  mine.sort(numSort);

  var basis = 'workload-prior';
  var p50;
  var p90;
  var explanation;
  var unit = cpu ? 'core-hours' : 'A100-equivalent GPU-hours';
  if (all.length >= 5) {
    basis = 'history';
    // all GPU types, normalized to A100-equivalent hours (a same-GPU subset skews toward whatever ran there)
    var src = all;
    p50 = quantile(src, 0.5);
    p90 = quantile(src, 0.9);
    explanation = 'Median of ' + src.length + ' completed ' + wt + ' jobs' + '' + ': ' + round(p50, 1) + ' ' + unit + ' per job (p90 ' + round(p90, 1) + ').';
    if (mine.length >= 5) {
      var m50 = quantile(mine, 0.5);
      var m90 = quantile(mine, 0.9);
      p50 = 0.5 * p50 + 0.5 * m50;
      p90 = 0.5 * p90 + 0.5 * m90;
      explanation += " Blended 50/50 with the lab's own " + mine.length + ' jobs (median ' + round(m50, 1) + ').';
    }
  } else {
    p50 = cpu ? PRIOR_CPU_WORK[wt] : PRIOR_WORK[wt];
    p90 = p50 * 2;
    explanation = 'Only ' + all.length + ' similar completed jobs, so a typical ' + wt + ' job of ' + p50 + ' ' + unit + ' is assumed.';
  }

  var sizeScale = 1;
  if (!cpu && paramsB > 0 && REF_PARAMS_B[wt]) {
    sizeScale = Math.min(20, Math.max(0.1, Math.pow(paramsB / REF_PARAMS_B[wt], 0.85)));
    explanation += ' Scaled x' + round(sizeScale, 2) + ' for a ' + paramsB + 'B-parameter model (history ~' + REF_PARAMS_B[wt] + 'B).';
  }
  p50 = p50 * sizeScale;
  p90 = Math.max(p90 * sizeScale, p50);

  var rel = cpu ? 1 : num(target.relativeThroughput, 1);
  var gpusPerNode = 8;
  var nodes = Math.ceil(gpus / gpusPerNode);
  var eff = Math.pow(0.9, Math.log(gpus) / Math.LN2) * (nodes > 1 ? 0.9 : 1);
  var capacity = cpu ? 128 * gpus * eff : gpus * rel * eff;
  var est = p50 / capacity;
  var est90 = p90 / capacity;
  var mem = memoryNeedGb(wt, paramsB);
  var perGpu = cpu ? 0 : num(target.memoryGb, 40) * 0.9;
  var minGpus = mem > 0 && perGpu > 0 ? Math.max(1, Math.ceil(mem / perGpu)) : 1;
  if (!cpu) explanation += ' On ' + gpus + ' x ' + gpuTypeId + ' (' + rel + 'x A100 throughput, ' + Math.round(eff * 100) + '% scaling efficiency): ' + fmtHours(est) + '.';

  // AnvilRuntimeQ50Q90 champion: historical P50/P90 for the equivalent Anvil request (A100 'gpu' / CPU 'standard')
  var anvilPart = cpu ? 'standard' : /A100-40GB/.test(String(gpuTypeId)) ? 'gpu' : 'other';
  var d = new Date();
  var champ = plainJson(
    QuantileModel.predict('AnvilRuntimeQ50Q90', {
      partition: anvilPart,
      reqCpus: cpu ? 128 * gpus : 32 * gpus,
      reqNodes: cpu ? gpus : Math.ceil(gpus / 4),
      reqMemGiB: null,
      reqGpus: cpu ? 0 : gpus,
      walltimeHours: Math.max(1, Math.ceil(est90 * 1.2)),
      submitHour: d.getUTCHours(),
      submitWeekday: (d.getUTCDay() + 6) % 7,
      submitMonth: d.getUTCMonth() + 1,
    })
  );
  var champUsable = champ && champ.available && !champ.lowSupport;
  var heuristicProv = { component: 'AnvilRuntimeQ50Q90', version: 'fallback', method: 'history median of similar completed jobs (A100-equivalent GPU-hours) scaled by model size, GPU throughput and scaling efficiency', status: 'FALLBACK_HEURISTIC', trainingPeriod: null, sampleSupport: all.length, historicalOnly: true, computedAt: d.toISOString(), note: 'Workload-aware estimate used by the planner outside supported Anvil partitions.' };
  return {
    provenance: champUsable ? [champ.provenance, heuristicProv] : [heuristicProv],
    anvilRuntime: champUsable ? { partition: anvilPart, p50Hours: champ.p50, p90Hours: champ.p90, label: 'historical only' } : null,
    workloadType: wt,
    gpuTypeId: cpu ? 'CPU' : String(gpuTypeId),
    gpus: gpus,
    modelParamsB: paramsB,
    basis: basis,
    sampleSize: all.length,
    sameGpuSamples: same.length,
    labSamples: mine.length,
    a100HoursP50: round(p50, 2),
    a100HoursP90: round(p90, 2),
    sizeScale: round(sizeScale, 3),
    relativeThroughput: rel,
    scalingEfficiency: round(eff, 3),
    estDurationHours: round(est, 2),
    p90DurationHours: round(est90, 2),
    recommendedWalltimeHours: Math.max(1, Math.ceil(est90 * 1.2)),
    gpuHours: cpu ? 0 : round(est * gpus, 2),
    memoryNeedGb: round(mem, 1),
    minGpus: minGpus,
    fits: cpu || mem <= 0 || gpus >= minGpus,
    explanation: explanation,
  };
}

// ---------------------------------------------------------------- labSummary

function allocationRows(labId, now, burnByCluster) {
  return list(Allocation.fetch({ filter: Filter.eq('lab.id', labId), include: 'this, cluster.name, cluster.usdPerUnit', limit: 200 }).objs).map(function (a) {
    var total = num(a.totalUnits, 0);
    var used = num(a.usedUnits, 0);
    var remaining = Math.max(0, total - used);
    var end = ms(a.endDate);
    var daysLeft = end == null ? null : Math.round((end - now) / DAY_MS);
    var burn = burnByCluster[a.cluster.id] || 0;
    var runOut = burn > 0 ? now + (remaining / burn) * DAY_MS : null;
    return {
      id: a.id,
      name: a.name,
      clusterId: a.cluster.id,
      clusterName: a.cluster.name,
      source: a.source,
      grantName: a.grantName,
      unitName: a.unitName,
      totalUnits: round(total, 1),
      usedUnits: round(used, 1),
      remainingUnits: round(remaining, 1),
      pctUsed: total > 0 ? round(used / total, 4) : 0,
      remainingUsd: round(remaining * num(a.cluster.usdPerUnit, 0), 2),
      startDate: iso(a.startDate),
      endDate: iso(a.endDate),
      daysLeft: daysLeft,
      burnPerDay: round(burn, 2),
      projectedRunOut: runOut == null ? null : new Date(runOut).toISOString(),
      runsOutBeforeEnd: runOut != null && end != null && runOut < end,
    };
  });
}

function labSummary(labId) {
  var lab = Lab.make({ id: labId }).get('this');
  if (lab == null) throw new Error('Lab ' + labId + ' not found');
  var now = Date.now();
  var weeks = lastWeeks(12, now);
  var weekIdx = {};
  weeks.forEach(function (w, i) {
    weekIdx[w] = i;
  });
  var weekly = weeks.map(function (w) {
    return { week: w, jobs: 0, gpuHours: 0, costUsd: 0 };
  });

  var k = { jobs: 0, gpuHours: 0, costUsd: 0, wasted: 0, failed: 0, gpuHours30d: 0, costUsd30d: 0, utilSum: 0, utilW: 0 };
  var eff = { cpu: 0, cpuN: 0, mem: 0, memN: 0, time: 0, timeN: 0 };
  var byCluster = {};
  var byUser = {};
  var byWorkload = {};
  var stateCounts = {};
  var burnUnits30d = {};
  var oversized = 0;
  var walltimeOver = 0;
  var walltimeN = 0;
  var oom = 0;

  Job.fetchObjStream({
    filter: Filter.eq('lab.id', labId),
    include: 'user, cluster, state, submitTime, timelimitHours, elapsedHours, allocGpus, gpuUtilAvg, cpuEfficiency, memEfficiency, costUnits, costUsd, workloadType, isLive',
  }).each(function (j) {
    var st = String(j.state);
    stateCounts[st] = (stateCounts[st] || 0) + 1;
    if (j.isLive && (st == 'RUNNING' || st == 'PENDING')) return;
    var gh = jobGpuHours(j);
    var cost = num(j.costUsd, 0);
    var wasted = jobWastedGpuHours(j);
    var t = ms(j.submitTime);
    k.jobs++;
    k.gpuHours += gh;
    k.costUsd += cost;
    k.wasted += wasted;
    if (st == 'FAILED' || st == 'TIMEOUT' || st == 'OUT_OF_MEMORY') k.failed++;
    if (st == 'OUT_OF_MEMORY') oom++;
    if (t != null && now - t <= 30 * DAY_MS) {
      k.gpuHours30d += gh;
      k.costUsd30d += cost;
      if (j.cluster) burnUnits30d[j.cluster.id] = (burnUnits30d[j.cluster.id] || 0) + num(j.costUnits, 0);
    }
    if (j.gpuUtilAvg != null && gh > 0) {
      k.utilSum += Number(j.gpuUtilAvg) * gh;
      k.utilW += gh;
      if (Number(j.gpuUtilAvg) < 30) oversized++;
    }
    if (j.cpuEfficiency != null) {
      eff.cpu += Number(j.cpuEfficiency);
      eff.cpuN++;
    }
    if (j.memEfficiency != null) {
      eff.mem += Number(j.memEfficiency);
      eff.memN++;
    }
    var te = num(j.timelimitHours, 0) > 0 ? Math.min(1, num(j.elapsedHours, 0) / Number(j.timelimitHours)) : null;
    if (te != null && st == 'COMPLETED') {
      eff.time += te;
      eff.timeN++;
      walltimeN++;
      if (te < 0.3) walltimeOver++;
    }
    if (j.cluster) {
      var c = (byCluster[j.cluster.id] = byCluster[j.cluster.id] || { clusterId: j.cluster.id, jobs: 0, gpuHours: 0, costUsd: 0 });
      c.jobs++;
      c.gpuHours += gh;
      c.costUsd += cost;
    }
    var u = String(j.user || 'unknown');
    var ur = (byUser[u] = byUser[u] || { user: u, jobs: 0, gpuHours: 0, costUsd: 0, wastedGpuHours: 0, utilSum: 0, utilW: 0, cpuSum: 0, cpuN: 0, teSum: 0, teN: 0 });
    ur.jobs++;
    ur.gpuHours += gh;
    ur.costUsd += cost;
    ur.wastedGpuHours += wasted;
    if (j.gpuUtilAvg != null && gh > 0) {
      ur.utilSum += Number(j.gpuUtilAvg) * gh;
      ur.utilW += gh;
    }
    if (j.cpuEfficiency != null) {
      ur.cpuSum += Number(j.cpuEfficiency);
      ur.cpuN++;
    }
    if (te != null) {
      ur.teSum += te;
      ur.teN++;
    }
    var wt = String(j.workloadType || 'UNKNOWN');
    var wr = (byWorkload[wt] = byWorkload[wt] || { workloadType: wt, jobs: 0, gpuHours: 0, utilSum: 0, utilW: 0 });
    wr.jobs++;
    wr.gpuHours += gh;
    if (j.gpuUtilAvg != null && gh > 0) {
      wr.utilSum += Number(j.gpuUtilAvg) * gh;
      wr.utilW += gh;
    }
    if (t != null) {
      var wi = weekIdx[weekKey(t)];
      if (wi != null) {
        weekly[wi].jobs++;
        weekly[wi].gpuHours += gh;
        weekly[wi].costUsd += cost;
      }
    }
  });

  var clusterNames = {};
  list(ComputeCluster.fetch({ include: 'name', limit: 200 }).objs).forEach(function (c) {
    clusterNames[c.id] = c.name;
  });
  var burnPerDay = {};
  Object.keys(burnUnits30d).forEach(function (c) {
    burnPerDay[c] = burnUnits30d[c] / 30;
  });
  var allocations = allocationRows(labId, now, burnPerDay);
  var fc = plainJson(AllocationBurnForecaster.forecast(labId));
  var fcById = {};
  (fc.allocations || []).forEach(function (f) {
    fcById[f.id] = f;
  });
  allocations.forEach(function (a) {
    var f = fcById[a.id];
    if (!f) return;
    a.committedUnits = f.committedUnits;
    a.remainingAfterCommitted = f.remainingUnits;
    a.burnPerDay = f.scenarios.baseline.perDay;
    a.projectedRunOut = f.scenarios.baseline.runOut;
    a.runsOutBeforeEnd = f.runsOutBeforeEnd;
    a.scenarios = f.scenarios;
    a.deadlineRisk = f.deadlineRisk;
  });

  var liveJobs = Job.fetchCount({ filter: Filter.eq('lab.id', labId).and().eq('isLive', true).and().intersects('state', ['RUNNING', 'PENDING']) });
  var running = 0;
  var runningGpus = 0;
  Job.fetchObjStream({ filter: Filter.eq('lab.id', labId).and().eq('state', 'RUNNING').and().eq('isLive', true), include: 'allocGpus' }).each(function (j) {
    running++;
    runningGpus += num(j.allocGpus, 0);
  });
  var activeAlerts = Filter.eq('lab.id', labId).and().intersects('status', ['OPEN', 'ACKED']);
  var openAlerts = JobAlert.fetchCount({ filter: activeAlerts });
  var criticalAlerts = JobAlert.fetchCount({ filter: Filter.eq('lab.id', labId).and().intersects('status', ['OPEN', 'ACKED']).and().eq('severity', 'CRITICAL') });

  var deadlines = list(Project.fetch({ filter: Filter.eq('lab.id', labId), limit: 200 }).objs)
    .filter(function (p) {
      return p.deadline != null;
    })
    .map(function (p) {
      var d = ms(p.deadline);
      return { projectId: p.id, name: p.name, deadline: iso(p.deadline), deadlineLabel: p.deadlineLabel, daysLeft: Math.round((d - now) / DAY_MS), priority: p.priority, workloadType: p.workloadType };
    })
    .sort(function (a, b) {
      var fa = a.daysLeft < 0 ? 1e6 - a.daysLeft : a.daysLeft;
      var fb = b.daysLeft < 0 ? 1e6 - b.daysLeft : b.daysLeft;
      return fa - fb;
    });

  var avgUtil = k.utilW > 0 ? k.utilSum / k.utilW : null;
  var recs = [];
  if (walltimeN >= 5 && walltimeOver / walltimeN > 0.25) {
    recs.push({ kind: 'WALLTIME', title: 'Request shorter walltimes', detail: round((walltimeOver / walltimeN) * 100, 0) + '% of completed jobs used under 30% of their time limit. Tighter limits backfill sooner; the planner sizes walltime at 1.2 x predicted p90.', impact: 'Shorter queue waits' });
  }
  if (k.wasted > 0 && k.gpuHours > 0 && k.wasted / k.gpuHours > 0.3) {
    recs.push({ kind: 'IDLE', title: 'Cut idle GPU time', detail: round(k.wasted, 0) + ' of ' + round(k.gpuHours, 0) + ' GPU-hours (' + round((k.wasted / k.gpuHours) * 100, 0) + '%) were allocated but idle. Enable autopilot idle cancellation and fix data-loader stalls.', impact: '~$' + round((k.costUsd * k.wasted) / k.gpuHours, 0) + ' recoverable' });
  }
  if (oversized >= 5) {
    recs.push({ kind: 'OVERSIZED_GPU', title: 'Use smaller GPUs for light jobs', detail: oversized + ' jobs averaged under 30% GPU utilization. A30, L40S or a single GPU would cost less with little slowdown.', impact: 'Lower cost per job' });
  }
  if (eff.memN >= 5 && eff.mem / eff.memN < 0.3) {
    recs.push({ kind: 'MEMORY', title: 'Request less host memory', detail: 'Jobs used ' + round((eff.mem / eff.memN) * 100, 0) + '% of requested memory on average.', impact: 'Faster scheduling' });
  }
  if (oom >= 3) {
    recs.push({ kind: 'FAILURES', title: 'Out-of-memory failures', detail: oom + ' jobs ran out of memory. Request +25% memory or use gradient checkpointing / larger-memory GPUs.', impact: 'Fewer reruns' });
  }
  allocations.forEach(function (a) {
    if (a.runsOutBeforeEnd) {
      recs.push({ kind: 'BUDGET', title: a.clusterName + ' allocation runs out early', detail: 'At ' + a.burnPerDay + ' ' + a.unitName + '/day it runs out ' + a.projectedRunOut.substring(0, 10) + ', before its end date ' + String(a.endDate).substring(0, 10) + '. Shift work to preemptible QOS (0.25x) or another allocation.', impact: a.remainingUnits + ' ' + a.unitName + ' left' });
    } else if (a.pctUsed >= 0.85) {
      recs.push({ kind: 'BUDGET', title: a.clusterName + ' allocation ' + round(a.pctUsed * 100, 0) + '% used', detail: 'Only ' + a.remainingUnits + ' ' + a.unitName + ' left until ' + String(a.endDate).substring(0, 10) + '.', impact: 'Plan remaining runs' });
    }
  });
  deadlines.forEach(function (d) {
    if (d.daysLeft >= 0 && d.daysLeft <= 21) {
      recs.push({ kind: 'DEADLINE', title: (d.deadlineLabel || d.name) + ' in ' + d.daysLeft + ' days', detail: 'Plan ' + d.name + ' runs now; the planner flags options that would miss it.', impact: 'Priority ' + d.priority });
    }
  });

  var states = STATES.map(function (s) {
    return { state: s, count: stateCounts[s] || 0 };
  });
  var remainingUsd = allocations.reduce(function (s, a) {
    return s + a.remainingUsd;
  }, 0);

  log.info('labSummary {}: {} jobs', labId, k.jobs);
  return {
    provenance: [fc.provenance],
    asOf: new Date(now).toISOString(),
    lab: { id: lab.id, name: lab.name, piName: lab.piName, piEmail: lab.piEmail, department: lab.department, researchArea: lab.researchArea, fairShareTarget: lab.fairShareTarget, slurmAccounts: lab.slurmAccounts, preferredClusters: lab.preferredClusters },
    kpis: {
      liveJobs: liveJobs,
      runningJobs: running,
      pendingJobs: Math.max(0, liveJobs - running),
      runningGpus: runningGpus,
      openAlerts: openAlerts,
      criticalAlerts: criticalAlerts,
      jobs: k.jobs,
      gpuHours: round(k.gpuHours, 1),
      costUsd: round(k.costUsd, 2),
      wastedGpuHours: round(k.wasted, 1),
      wastePct: k.gpuHours > 0 ? round(k.wasted / k.gpuHours, 4) : 0,
      avgGpuUtil: avgUtil == null ? null : round(avgUtil, 1),
      failedJobs: k.failed,
      failRate: k.jobs > 0 ? round(k.failed / k.jobs, 4) : 0,
      gpuHours30d: round(k.gpuHours30d, 1),
      costUsd30d: round(k.costUsd30d, 2),
      allocationRemainingUsd: round(remainingUsd, 2),
    },
    allocations: allocations,
    deadlines: deadlines,
    usageByCluster: Object.keys(byCluster)
      .map(function (c) {
        var r = byCluster[c];
        return { clusterId: c, name: clusterNames[c] || c, jobs: r.jobs, gpuHours: round(r.gpuHours, 1), costUsd: round(r.costUsd, 2) };
      })
      .sort(function (a, b) {
        return b.gpuHours - a.gpuHours || b.jobs - a.jobs;
      }),
    usageByUser: Object.keys(byUser)
      .map(function (u) {
        var r = byUser[u];
        return {
          user: u,
          jobs: r.jobs,
          gpuHours: round(r.gpuHours, 1),
          costUsd: round(r.costUsd, 2),
          avgGpuUtil: r.utilW > 0 ? round(r.utilSum / r.utilW, 1) : null,
          wastedGpuHours: round(r.wastedGpuHours, 1),
          avgCpuEfficiency: r.cpuN > 0 ? round(r.cpuSum / r.cpuN, 3) : null,
          timeEfficiency: r.teN > 0 ? round(r.teSum / r.teN, 3) : null,
        };
      })
      .sort(function (a, b) {
        return b.gpuHours - a.gpuHours || b.jobs - a.jobs;
      }),
    usageByWorkload: Object.keys(byWorkload).map(function (w) {
      var r = byWorkload[w];
      return { workloadType: w, jobs: r.jobs, gpuHours: round(r.gpuHours, 1), avgGpuUtil: r.utilW > 0 ? round(r.utilSum / r.utilW, 1) : null };
    }),
    stateMix: states,
    efficiency: {
      avgCpuEfficiency: eff.cpuN > 0 ? round(eff.cpu / eff.cpuN, 3) : null,
      avgMemEfficiency: eff.memN > 0 ? round(eff.mem / eff.memN, 3) : null,
      avgGpuUtil: avgUtil == null ? null : round(avgUtil, 1),
      timeEfficiency: eff.timeN > 0 ? round(eff.time / eff.timeN, 3) : null,
    },
    weekly: weekly.map(function (w) {
      return { week: w.week, jobs: w.jobs, gpuHours: round(w.gpuHours, 1), costUsd: round(w.costUsd, 2) };
    }),
    recommendations: recs,
  };
}

// ---------------------------------------------------------------- universityOverview

function universityOverview() {
  return ClusterCapacityAggregator.overview();
}
