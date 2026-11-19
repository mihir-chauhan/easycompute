/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('ClusterCapacityAggregator');

var VERSION = 'capacity-normalized-v1';

var DAY_MS = 24 * 3600 * 1000;
var BILLINGS = ['IN_HOUSE_NODE_SHARE', 'ACCESS_SU', 'THIRD_PARTY_HOURLY'];

// ---------------------------------------------------------------- helpers

function ms(v) {
  return v == null ? null : Date.parse(String(v));
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

function overview() {
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
        ? 'Add ' + gt + ' capacity or shift work: forecast ' + Math.round(forecast) + '% utilization.'
        : pressure == 'MEDIUM' ? 'Watch: ' + Math.round(forecast) + '% forecast utilization.' : 'Headroom available (' + Math.round(100 - r.util) + '% idle); steer new work here.';
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
    var e = (byGt[d.gpuTypeId] = byGt[d.gpuTypeId] || { gpuTypeId: d.gpuTypeId, score: 0, n: 0, util: 0 });
    e.score += d.pressure == 'HIGH' ? 2 : d.pressure == 'MEDIUM' ? 1 : 0;
    e.n++;
    e.util = Math.max(e.util, d.forecastUtilizationPct);
  });
  var needs = Object.keys(byGt)
    .map(function (g) {
      var e = byGt[g];
      var avg = e.score / e.n;
      return {
        gpuTypeId: g,
        pressure: avg >= 1.5 ? 'HIGH' : avg >= 0.75 ? 'MEDIUM' : 'LOW',
        score: round(avg, 2),
        reason: 'Up to ' + Math.round(e.util) + '% forecast utilization' + (gtTrend[g] != null ? '; demand ' + (gtTrend[g] >= 0 ? '+' : '') + round(gtTrend[g] * 100, 1) + '%/week' : '') + '.',
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

  // normalized units: A100-40GB-equivalent GPUs (GpuType.relativeThroughput) and USD per A100-equivalent hour
  clusterRows.forEach(function (c) {
    var eq = 0;
    var busyEq = 0;
    partRows.forEach(function (r) {
      if (r.p.cluster.id != c.id || r.p.gpuType == null) return;
      var g = types[r.p.gpuType.id];
      var rel = g ? num(g.relativeThroughput, 1) : 1;
      eq += r.gpus * rel;
      busyEq += ((r.gpus * r.util) / 100) * rel;
    });
    var cost = c.gpuHours > 0 ? c.costUsd / c.gpuHours : null;
    c.normalized = { a100EqGpus: round(eq, 1), busyA100EqGpus: round(busyEq, 1), usdPerGpuHour: cost == null ? null : round(cost, 2) };
  });
  var latestOf = function (T, field) {
    var res = T.evaluate({ projection: 'max(' + field + ')' });
    var c = res.tuples && res.tuples.length ? res.tuples[0].cells[0] : null;
    var t = c == null ? null : ms(c.value());
    return t == null || isNaN(t) ? null : new Date(t).toISOString();
  };
  var sources = {
    jobsAt: latestOf(Job, 'submitTime'),
    metricsAt: latestOf(JobMetric, 'ts'),
    allocationsAt: latestOf(Allocation, 'startDate'),
    partitionsAt: null,
    note: 'Partition queue/utilization snapshots come from the package seed (ClusterStatusFeed when deployed).',
  };
  log.info('overview: {} clusters, {} labs', clusters.length, labs.length);
  return {
    provenance: { component: 'ClusterCapacityAggregator', version: VERSION, method: 'normalized metrics (A100-equivalent GPUs, USD) from cluster inventory, partition state, job ledger and allocations; constrained ranking of demand', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: clusters.length, historicalOnly: false, computedAt: new Date(now).toISOString() },
    sources: sources,
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
