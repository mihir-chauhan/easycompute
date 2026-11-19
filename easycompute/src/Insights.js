/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('Insights');

var DAY_MS = 24 * 3600 * 1000;
var WORKLOADS = ['TRAINING', 'FINETUNE', 'INFERENCE', 'SIMULATION', 'DATA_PROCESSING', 'INTERACTIVE'];
var BILLINGS = ['IN_HOUSE_NODE_SHARE', 'ACCESS_SU', 'THIRD_PARTY_HOURLY'];
var STATES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'OUT_OF_MEMORY', 'PREEMPTED'];
/** A100-40GB GPU-hours of a typical job when there is no history (core-hours for CPU work). */
var PRIOR_WORK = { TRAINING: 40, FINETUNE: 12, INFERENCE: 2, SIMULATION: 24, DATA_PROCESSING: 4, INTERACTIVE: 3 };
var PRIOR_CPU_WORK = { TRAINING: 256, FINETUNE: 128, INFERENCE: 32, SIMULATION: 1536, DATA_PROCESSING: 96, INTERACTIVE: 8 };
/** Model size (billions of parameters) the history medians are assumed to describe. */
var REF_PARAMS_B = { TRAINING: 1, FINETUNE: 7, INFERENCE: 7 };

// ---------------------------------------------------------------- helpers

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

/** Grouped evaluate as { key: [measures...] }; null group keys are skipped (the platform omits them anyway). */
function grouped(type, group, measures, filter) {
  var spec = { projection: group + ', ' + measures.join(', '), group: group, limit: 500 };
  if (filter) spec.filter = filter;
  var out = {};
  list(type.evaluate(spec).tuples).forEach(function (t) {
    var k = cellValue(t, 0);
    if (k == null) return;
    out[String(k)] = measures.map(function (m, i) {
      return cellNum(t, i + 1);
    });
  });
  return out;
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

  return {
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

/** Least-squares slope and intercept of y over x = 0..n-1. */
function linearFit(ys) {
  var n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0 };
  var sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (var i = 0; i < n; i++) {
    sx += i;
    sy += ys[i];
    sxy += i * ys[i];
    sxx += i * i;
  }
  var slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { slope: slope, intercept: (sy - slope * sx) / n };
}

function universityOverview() {
  var now = Date.now();
  var clusters = list(ComputeCluster.fetch({ limit: 200 }).objs);
  var partitions = list(Partition.fetch({ limit: 500 }).objs);
  var labs = list(Lab.fetch({ limit: 500 }).objs);

  // history aggregates: one streamed pass (GPU-hours are computed here, not from a stored calc)
  var billingOf = {};
  clusters.forEach(function (c) {
    billingOf[c.id] = String(c.billing);
  });
  var byCluster = {};
  var byBilling = {};
  var byLab = {};
  var perJob = {};
  var add = function (m, k, vals) {
    if (k == null) return;
    var e = (m[k] = m[k] || vals.map(function () { return 0; }));
    vals.forEach(function (v, i) {
      e[i] += v;
    });
  };
  Job.fetchObjStream({ include: 'cluster, lab, partition, isLive, allocGpus, elapsedHours, gpuUtilAvg, costUsd' }).each(function (j) {
    var gh = jobGpuHours(j);
    var cost = num(j.costUsd, 0);
    var cid = j.cluster ? j.cluster.id : null;
    add(byCluster, cid, [1, gh, cost]);
    add(byBilling, cid ? billingOf[cid] : null, [1, gh, cost]);
    add(byLab, j.lab ? j.lab.id : null, [gh, cost, jobWastedGpuHours(j)]);
    if (!j.isLive) add(perJob, j.partition ? j.partition.id : null, [1, gh]);
  });
  var liveByCluster = grouped(Job, 'cluster.id', ['count()'], Filter.eq('isLive', true).and().intersects('state', ['RUNNING', 'PENDING']));

  // live jobs: running GPUs, pending GPU demand per partition, idle jobs
  var pendingGpuHours = {};
  var runningJobs = 0;
  var pendingJobs = 0;
  var liveIds = [];
  var liveJobs = {};
  Job.fetchObjStream({
    filter: Filter.eq('isLive', true).and().intersects('state', ['RUNNING', 'PENDING']),
    include: 'lab, user, partition, state, allocGpus, timelimitHours, elapsedHours',
  }).each(function (j) {
    if (j.state == 'RUNNING') {
      runningJobs++;
      liveIds.push(j.id);
      liveJobs[j.id] = j;
    } else {
      pendingJobs++;
      if (j.partition) pendingGpuHours[j.partition.id] = (pendingGpuHours[j.partition.id] || 0) + num(j.allocGpus, 0) * num(j.timelimitHours, 0);
    }
  });


  var types = gpuTypeMap();
  // partitions on the same (cluster, GPU type) are QOS views of the same hardware: share its capacity
  var clusterGpus = {};
  clusters.forEach(function (c) {
    clusterGpus[c.id] = num(c.totalGpus, 0);
  });
  var hw = {};
  var gtPerCluster = {};
  partitions.forEach(function (p) {
    if (p.gpuType == null) return;
    var key = p.cluster.id + '|' + p.gpuType.id;
    var e = (hw[key] = hw[key] || { cap: 0, n: 0 });
    e.cap = Math.max(e.cap, num(p.nodeCount, 0) * num(p.gpusPerNode, 0));
    e.n++;
    gtPerCluster[p.cluster.id] = gtPerCluster[p.cluster.id] || {};
    gtPerCluster[p.cluster.id][p.gpuType.id] = true;
  });
  Object.keys(hw).forEach(function (key) {
    var cid = key.split('|')[0];
    if (hw[key].cap <= 0) hw[key].cap = (clusterGpus[cid] || 0) / Math.max(1, Object.keys(gtPerCluster[cid]).length);
  });
  var partRows = partitions.map(function (p) {
    var e = p.gpuType != null ? hw[p.cluster.id + '|' + p.gpuType.id] : null;
    var gpus = e ? e.cap / e.n : 0;
    var util = num(p.utilizationPct, 0);
    var pj = perJob[p.id];
    var avgJobGh = pj && pj[0] > 0 ? pj[1] / pj[0] : num(p.gpusPerNode, 1) * 6;
    var backlog = num(p.currentQueueDepth, 0) * avgJobGh + (pendingGpuHours[p.id] || 0);
    return { p: p, gpus: gpus, util: util, idle: gpus * (1 - util / 100), backlog: backlog };
  });

  var clusterRows = clusters.map(function (c) {
    var parts = partRows.filter(function (r) {
      return r.p.cluster.id == c.id;
    });
    var cap = 0, busy = 0, depth = 0, waitSum = 0, backlog = 0;
    var gpuParts = parts.filter(function (r) {
      return r.p.gpuType != null;
    });
    var weighted = gpuParts.some(function (r) {
      return r.gpus > 0;
    });
    parts.forEach(function (r) {
      depth += num(r.p.currentQueueDepth, 0);
      waitSum += num(r.p.avgWaitHours, 0);
      backlog += r.backlog;
    });
    gpuParts.forEach(function (r) {
      cap += r.gpus;
      busy += (r.gpus * r.util) / 100;
    });
    var totalGpus = num(c.totalGpus, 0);
    var utilPct;
    if (weighted && cap > 0) {
      utilPct = (busy / cap) * 100;
    } else if (gpuParts.length) {
      utilPct = gpuParts.reduce(function (s, r) {
        return s + r.util;
      }, 0) / gpuParts.length;
    } else {
      utilPct = parts.length ? parts.reduce(function (s, r) { return s + r.util; }, 0) / parts.length : 0;
    }
    if (String(c.status) == 'RETIRED') utilPct = 0;
    var busyGpus = Math.round((totalGpus * utilPct) / 100);
    var h = byCluster[c.id] || [0, 0, 0];
    return {
      id: c.id,
      name: c.name,
      operator: c.operator,
      billing: c.billing,
      status: c.status,
      totalGpus: totalGpus,
      totalCores: num(c.totalCores, 0),
      storageTb: num(c.storageTb, 0),
      unitName: c.unitName,
      usdPerUnit: c.usdPerUnit,
      gpuUtilizationPct: round(utilPct, 1),
      busyGpus: busyGpus,
      idleGpus: String(c.status) == 'RETIRED' ? 0 : Math.max(0, totalGpus - busyGpus),
      queueDepth: depth,
      avgWaitHours: parts.length ? round(waitSum / parts.length, 2) : 0,
      pendingGpuHours: round(backlog, 1),
      jobs: h[0],
      gpuHours: round(h[1], 1),
      costUsd: round(h[2], 2),
      liveJobs: liveByCluster[c.id] ? liveByCluster[c.id][0] : 0,
    };
  });

  var totalCost = 0;
  var totalGh = 0;
  BILLINGS.forEach(function (b) {
    var r = byBilling[b] || [0, 0, 0];
    totalCost += r[2];
    totalGh += r[1];
  });
  var costByBilling = BILLINGS.map(function (b) {
    var r = byBilling[b] || [0, 0, 0];
    return { billing: b, jobs: r[0], gpuHours: round(r[1], 1), costUsd: round(r[2], 2), pct: totalCost > 0 ? round(r[2] / totalCost, 4) : 0 };
  });

  var labGh = 0;
  Object.keys(byLab).forEach(function (l) {
    labGh += byLab[l][0];
  });
  var fairness = labs
    .map(function (l) {
      var r = byLab[l.id] || [0, 0, 0];
      var share = labGh > 0 ? r[0] / labGh : 0;
      var target = num(l.fairShareTarget, 0);
      var ratio = target > 0 ? share / target : null;
      return {
        labId: l.id,
        name: l.name,
        department: l.department,
        fairShareTarget: round(target, 4),
        usageShare: round(share, 4),
        ratio: ratio == null ? null : round(ratio, 2),
        status: ratio == null ? 'BALANCED' : ratio > 1.25 ? 'OVER' : ratio < 0.75 ? 'UNDER' : 'BALANCED',
        gpuHours: round(r[0], 1),
        costUsd: round(r[1], 2),
        wastedGpuHours: round(r[2], 1),
      };
    })
    .sort(function (a, b) {
      return (b.ratio || 0) - (a.ratio || 0);
    });

  // idle resources
  var idleGpusNow = clusterRows.reduce(function (s, c) {
    return s + (String(c.status) == 'ONLINE' || String(c.status) == 'DEGRADED' ? c.idleGpus : 0);
  }, 0);
  var idleUsdPerDay = 0;
  partRows.forEach(function (r) {
    if (r.p.gpuType == null) return;
    var g = types[r.p.gpuType.id];
    idleUsdPerDay += r.idle * 24 * (g ? num(g.costPerGpuHourUsd, 0) : 0);
  });
  var wastedTotal = 0;
  Object.keys(byLab).forEach(function (l) {
    wastedTotal += byLab[l][2];
  });
  var idleLiveJobs = [];
  if (liveIds.length) {
    var latest = {};
    JobMetric.fetchObjStream({ filter: Filter.intersects('job.id', liveIds).and('ts >= ' + "dateTime('" + new Date(now - 3 * 3600 * 1000).toISOString().substring(0, 10) + "')"), include: 'job, ts, gpuUtilPct' }).each(function (m) {
      var jid = m.job.id;
      var t = ms(m.ts);
      var cur = latest[jid] || { lastTs: null, util: null, idleSince: null, lastBusy: null };
      if (cur.lastTs == null || t > cur.lastTs) {
        cur.lastTs = t;
        cur.util = num(m.gpuUtilPct, 0);
      }
      if (num(m.gpuUtilPct, 0) >= 5 && (cur.lastBusy == null || t > cur.lastBusy)) cur.lastBusy = t;
      latest[jid] = cur;
    });
    Object.keys(latest).forEach(function (jid) {
      var e = latest[jid];
      var j = liveJobs[jid];
      if (e.util != null && e.util < 5 && j && num(j.allocGpus, 0) > 0) {
        idleLiveJobs.push({ jobId: jid, labId: j.lab ? j.lab.id : null, user: j.user, gpus: num(j.allocGpus, 0), gpuUtilPct: round(e.util, 1), idleMinutes: e.lastBusy == null ? 180 : Math.round((e.lastTs - e.lastBusy) / 60000) });
      }
    });
    idleLiveJobs.sort(function (a, b) {
      return b.gpus * b.idleMinutes - a.gpus * a.idleMinutes;
    });
  }
  var labNames = {};
  labs.forEach(function (l) {
    labNames[l.id] = l.name;
  });
  var topWaste = Object.keys(byLab)
    .map(function (l) {
      return { labId: l, name: labNames[l] || l, wastedGpuHours: round(byLab[l][2], 1), wastePct: byLab[l][0] > 0 ? round(byLab[l][2] / byLab[l][0], 4) : 0 };
    })
    .sort(function (a, b) {
      return b.wastedGpuHours - a.wastedGpuHours;
    })
    .slice(0, 5);

  // demand: weekly submitted GPU-hours (history) with a linear trend and a 4-week forecast
  var weeks = lastWeeks(12, now);
  var wIdx = {};
  weeks.forEach(function (w, i) {
    wIdx[w] = i;
  });
  var wGh = weeks.map(function () {
    return 0;
  });
  var wJobs = weeks.map(function () {
    return 0;
  });
  var gtByWeek = {};
  var since = weeks[0];
  Job.fetchObjStream({ filter: "submitTime >= dateTime('" + since + "')", include: 'submitTime, allocGpus, elapsedHours, timelimitHours, gpuType, state' }).each(function (j) {
    var i = wIdx[weekKey(ms(j.submitTime))];
    if (i == null) return;
    var gh = j.state == 'PENDING' || j.state == 'RUNNING' ? num(j.allocGpus, 0) * num(j.timelimitHours, 0) : jobGpuHours(j);
    wGh[i] += gh;
    wJobs[i]++;
    if (j.gpuType) {
      var g = (gtByWeek[j.gpuType.id] = gtByWeek[j.gpuType.id] || weeks.map(function () { return 0; }));
      g[i] += gh;
    }
  });
  // trend on complete weeks only (the current week is partial)
  var fit = linearFit(wGh.slice(0, wGh.length - 1));
  var meanGh = wGh.slice(0, wGh.length - 1).reduce(function (s, v) { return s + v; }, 0) / Math.max(1, wGh.length - 1);
  var trendPct = meanGh > 0 ? (fit.slope / meanGh) * 100 : 0;
  var weekly = weeks.map(function (w, i) {
    return { week: w, gpuHours: round(wGh[i], 1), jobs: wJobs[i], forecast: false };
  });
  var lastMonday = Date.parse(weeks[weeks.length - 1] + 'T00:00:00Z');
  for (var f = 1; f <= 4; f++) {
    var x = wGh.length - 1 + f - 1;
    weekly.push({ week: new Date(lastMonday + f * 7 * DAY_MS).toISOString().substring(0, 10), gpuHours: round(Math.max(0, fit.intercept + fit.slope * x), 1), jobs: null, forecast: true });
  }
  var gtTrend = {};
  Object.keys(gtByWeek).forEach(function (g) {
    var ys = gtByWeek[g].slice(0, weeks.length - 1);
    var m = ys.reduce(function (s, v) { return s + v; }, 0) / Math.max(1, ys.length);
    gtTrend[g] = m > 0 ? linearFit(ys).slope / m : 0;
  });

  var clusterStatus = {};
  clusters.forEach(function (c) {
    clusterStatus[c.id] = String(c.status);
  });
  var demandParts = partRows
    .filter(function (r) {
      return r.p.gpuType != null && clusterStatus[r.p.cluster.id] != 'RETIRED';
    })
    .map(function (r) {
      var gt = r.p.gpuType.id;
      var growth = Math.max(-0.1, Math.min(0.15, gtTrend[gt] != null ? gtTrend[gt] : trendPct / 100));
      var forecast = Math.min(100, r.util * Math.pow(1 + growth, 4));
      var wait = num(r.p.avgWaitHours, 0);
      var pressure = forecast >= 90 || wait >= 8 ? 'HIGH' : forecast >= 75 || wait >= 3 ? 'MEDIUM' : 'LOW';
      var rec = pressure == 'HIGH'
        ? 'Add ' + gt + ' capacity or shift work: forecast ' + Math.round(forecast) + '% busy, ' + fmtHours(wait) + ' typical wait, ' + Math.round(r.backlog) + ' GPU-hours queued.'
        : pressure == 'MEDIUM' ? 'Watch: ' + Math.round(forecast) + '% forecast utilization.' : 'Headroom available (' + Math.round(100 - r.util) + '% idle); steer queued work here.';
      return {
        partitionId: r.p.id,
        name: r.p.name,
        clusterId: r.p.cluster.id,
        gpuTypeId: gt,
        utilizationPct: round(r.util, 1),
        queueDepth: num(r.p.currentQueueDepth, 0),
        avgWaitHours: round(wait, 2),
        pendingGpuHours: round(r.backlog, 1),
        forecastUtilizationPct: round(forecast, 1),
        pressure: pressure,
        recommendation: rec,
      };
    })
    .sort(function (a, b) {
      return b.forecastUtilizationPct - a.forecastUtilizationPct;
    });

  var byGt = {};
  demandParts.forEach(function (d) {
    var e = (byGt[d.gpuTypeId] = byGt[d.gpuTypeId] || { gpuTypeId: d.gpuTypeId, score: 0, n: 0, wait: 0, util: 0, backlog: 0 });
    e.score += d.pressure == 'HIGH' ? 2 : d.pressure == 'MEDIUM' ? 1 : 0;
    e.n++;
    e.wait = Math.max(e.wait, d.avgWaitHours);
    e.util = Math.max(e.util, d.forecastUtilizationPct);
    e.backlog += d.pendingGpuHours;
  });
  var needs = Object.keys(byGt)
    .map(function (g) {
      var e = byGt[g];
      var avg = e.score / e.n;
      return {
        gpuTypeId: g,
        pressure: avg >= 1.5 ? 'HIGH' : avg >= 0.75 ? 'MEDIUM' : 'LOW',
        score: round(avg, 2),
        reason: 'Up to ' + Math.round(e.util) + '% forecast utilization, waits up to ' + fmtHours(e.wait) + ', ' + Math.round(e.backlog) + ' GPU-hours queued' + (gtTrend[g] != null ? '; demand ' + (gtTrend[g] >= 0 ? '+' : '') + round(gtTrend[g] * 100, 1) + '%/week' : '') + '.',
      };
    })
    .sort(function (a, b) {
      return b.score - a.score;
    });

  var openAlerts = JobAlert.fetchCount({ filter: Filter.intersects('status', ['OPEN', 'ACKED']) });
  var criticalAlerts = JobAlert.fetchCount({ filter: Filter.intersects('status', ['OPEN', 'ACKED']).and().eq('severity', 'CRITICAL') });
  var onlineClusters = clusters.filter(function (c) {
    return String(c.status) == 'ONLINE' || String(c.status) == 'DEGRADED';
  });
  var totalGpus = 0, busyGpus = 0, totalCores = 0, storage = 0;
  clusterRows.forEach(function (c) {
    if (String(c.status) == 'RETIRED') return;
    totalGpus += c.totalGpus;
    busyGpus += c.busyGpus;
    totalCores += c.totalCores;
    storage += c.storageTb;
  });

  log.info('universityOverview: {} clusters, {} labs', clusters.length, labs.length);
  return {
    asOf: new Date(now).toISOString(),
    kpis: {
      clusters: clusters.length,
      onlineClusters: onlineClusters.length,
      totalGpus: totalGpus,
      totalCores: totalCores,
      storageTb: round(storage, 1),
      labs: labs.length,
      liveJobs: runningJobs + pendingJobs,
      runningJobs: runningJobs,
      pendingJobs: pendingJobs,
      busyGpus: busyGpus,
      idleGpus: idleGpusNow,
      gpuUtilizationPct: totalGpus > 0 ? round((busyGpus / totalGpus) * 100, 1) : 0,
      idleGpuHoursPerDay: round(idleGpusNow * 24, 0),
      idleUsdPerDay: round(idleUsdPerDay, 0),
      totalCostUsd: round(totalCost, 2),
      totalGpuHours: round(totalGh, 1),
      wastedGpuHours: round(wastedTotal, 1),
      openAlerts: openAlerts,
      criticalAlerts: criticalAlerts,
    },
    clusters: clusterRows,
    costByBilling: costByBilling,
    fairness: fairness,
    idle: {
      idleGpusNow: idleGpusNow,
      idleGpuHoursPerDay: round(idleGpusNow * 24, 0),
      wastedGpuHours: round(wastedTotal, 1),
      byPartition: partRows
        .filter(function (r) {
          return r.p.gpuType != null && clusterStatus[r.p.cluster.id] != 'RETIRED';
        })
        .map(function (r) {
          return { partitionId: r.p.id, name: r.p.name, clusterId: r.p.cluster.id, gpuTypeId: r.p.gpuType.id, gpus: round(r.gpus, 1), idleGpus: round(r.idle, 1), utilizationPct: round(r.util, 1) };
        })
        .sort(function (a, b) {
          return b.idleGpus - a.idleGpus;
        }),
      topWasteLabs: topWaste,
      idleLiveJobs: idleLiveJobs,
    },
    demand: { weekly: weekly, trendPctPerWeek: round(trendPct, 1), partitions: demandParts },
    needsMoreResources: needs,
  };
}
