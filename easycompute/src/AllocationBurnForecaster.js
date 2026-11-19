/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('AllocationBurnForecaster');

var VERSION = 'ledger-ewma-v1';
var DAY_MS = 24 * 3600 * 1000;
var LAMBDA = 0.3;
var DAYS = 30;

function num(v, dflt) {
  return v == null || isNaN(Number(v)) ? dflt : Number(v);
}

function round(v, digits) {
  var f = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(Number(v || 0) * f) / f;
}

function ms(v) {
  return v == null ? null : Date.parse(String(v));
}

function iso(t) {
  return t == null || !isFinite(t) ? null : new Date(t).toISOString();
}

function list(arr) {
  var out = [];
  if (arr == null) return out;
  for (var i = 0; i < arr.length; i++) out.push(arr[i]);
  return out;
}

function quantile(xs, q) {
  var s = xs.slice().sort(function (a, b) {
    return a - b;
  });
  if (!s.length) return 0;
  var pos = (s.length - 1) * q;
  var lo = Math.floor(pos);
  var hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function scenario(remaining, perDay, now, end) {
  var days = perDay > 0 ? Math.max(0, remaining) / perDay : null;
  var runOut = days == null ? null : now + days * DAY_MS;
  return { perDay: round(perDay, 2), runOut: iso(runOut), daysLeft: days == null ? null : round(days, 1), beforeEnd: runOut != null && end != null && runOut < end };
}

/**
 * Per allocation: daily charges from the job ledger (Job.costUnits by submit day, 30 days), EWMA (lambda 0.3) of that
 * series as the baseline burn, low / high scenarios from the 25th / 90th percentile of daily burn, units already
 * committed by running and queued work, and the run-out date for each scenario versus the allocation end and the lab's
 * project deadlines.
 */
function forecast(labId) {
  var now = Date.now();
  var dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  var allocs = list(Allocation.fetch({ filter: Filter.eq('lab.id', labId), include: 'this, cluster.name', limit: 200 }).objs);
  var clusterIds = {};
  allocs.forEach(function (a) {
    clusterIds[a.cluster.id] = true;
  });

  // ledger: charges per cluster per day (index 0 = oldest)
  var daily = {};
  Object.keys(clusterIds).forEach(function (c) {
    daily[c] = [];
    for (var i = 0; i < DAYS; i++) daily[c].push(0);
  });
  var committed = {};
  var since = new Date(dayStart - (DAYS - 1) * DAY_MS).toISOString().substring(0, 10);
  Job.fetchObjStream({ filter: Filter.eq('lab.id', labId).and("submitTime >= dateTime('" + since + "')"), include: 'cluster, submitTime, costUnits' }).each(function (j) {
    if (!j.cluster || !daily[j.cluster.id]) return;
    var idx = DAYS - 1 - Math.floor((dayStart - Math.floor(ms(j.submitTime) / DAY_MS) * DAY_MS) / DAY_MS);
    if (idx >= 0 && idx < DAYS) daily[j.cluster.id][idx] += num(j.costUnits, 0);
  });
  // commitments: remaining charge of running jobs, full limit of pending jobs
  Job.fetchObjStream({ filter: Filter.eq('lab.id', labId).and().eq('isLive', true).and().intersects('state', ['RUNNING', 'PENDING']), include: 'cluster, state, allocGpus, allocCpus, elapsedHours, timelimitHours, costUnits, partition.chargeFactor' }).each(function (j) {
    if (!j.cluster) return;
    var res = num(j.allocGpus, 0) > 0 ? num(j.allocGpus, 0) : num(j.allocCpus, 1);
    var rate = num(j.elapsedHours, 0) > 0 && num(j.costUnits, 0) > 0 ? num(j.costUnits, 0) / num(j.elapsedHours, 1) : res * num(j.partition && j.partition.chargeFactor, 1);
    var hours = Math.max(0, num(j.timelimitHours, 0) - num(j.elapsedHours, 0));
    committed[j.cluster.id] = (committed[j.cluster.id] || 0) + rate * hours;
  });
  // planned-but-not-submitted runs: the rank-1 plan's cost
  RunRequest.fetchObjStream({ filter: Filter.eq('lab.id', labId).and().eq('status', 'PLANNED'), include: 'id' }).each(function (r) {
    var plan = list(RunPlan.fetch({ filter: Filter.eq('runRequest.id', r.id).and().eq('rank', 1), include: 'cluster, estCostUnits', limit: 1 }).objs)[0];
    if (plan && plan.cluster) committed[plan.cluster.id] = (committed[plan.cluster.id] || 0) + num(plan.estCostUnits, 0);
  });

  var deadlines = list(Project.fetch({ filter: Filter.eq('lab.id', labId), include: 'id, name, deadline, deadlineLabel', limit: 200 }).objs).filter(function (p) {
    return p.deadline != null && ms(p.deadline) > now;
  });

  var out = allocs.map(function (a) {
    var cid = a.cluster.id;
    var series = daily[cid] || [];
    var ewma = series.length ? series[0] : 0;
    series.forEach(function (v) {
      ewma = LAMBDA * v + (1 - LAMBDA) * ewma;
    });
    var nonZero = series.filter(function (v) {
      return v > 0;
    });
    var low = Math.min(ewma, quantile(series, 0.25));
    var high = Math.max(ewma, nonZero.length ? quantile(nonZero, 0.9) : ewma);
    var total = num(a.totalUnits, 0);
    var used = num(a.usedUnits, 0);
    // a lab with several allocations on one cluster: commitments are charged to the allocation that ends last
    var lastOnCluster = allocs.filter(function (b) { return b.cluster.id == cid; }).sort(function (x, y) { return (ms(y.endDate) || 0) - (ms(x.endDate) || 0); })[0];
    var comm = lastOnCluster && lastOnCluster.id == a.id ? committed[cid] || 0 : 0;
    var remaining = total - used - comm;
    var end = ms(a.endDate);
    var sc = { baseline: scenario(remaining, ewma, now, end), low: scenario(remaining, low, now, end), high: scenario(remaining, high, now, end) };
    return {
      id: a.id,
      name: a.name,
      clusterId: cid,
      clusterName: a.cluster.name,
      unitName: a.unitName,
      totalUnits: round(total, 1),
      usedUnits: round(used, 1),
      committedUnits: round(comm, 1),
      remainingUnits: round(remaining, 1),
      endDate: iso(end),
      dailyBurn: series.map(function (v, i) {
        return { day: new Date(dayStart - (DAYS - 1 - i) * DAY_MS).toISOString().substring(0, 10), units: round(v, 2) };
      }),
      scenarios: sc,
      runsOutBeforeEnd: sc.baseline.beforeEnd,
      deadlineRisk: deadlines.map(function (p) {
        var d = ms(p.deadline);
        var hi = sc.high.runOut == null ? null : ms(sc.high.runOut);
        var base = sc.baseline.runOut == null ? null : ms(sc.baseline.runOut);
        return { projectId: p.id, label: p.deadlineLabel || p.name, deadline: iso(d), runOutBeforeBaseline: base != null && base < d, runOutBeforeHigh: hi != null && hi < d };
      }),
    };
  });
  log.info('forecast {}: {} allocations', labId, out.length);
  return {
    labId: labId,
    allocations: out,
    provenance: { component: 'AllocationBurnForecaster', version: VERSION, method: 'charge ledger (Job.costUnits, ' + DAYS + ' days) + committed running/queued/planned work; EWMA (lambda ' + LAMBDA + ') baseline, P25 low, P90 high daily burn', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: DAYS, historicalOnly: false, computedAt: new Date(now).toISOString() },
  };
}
