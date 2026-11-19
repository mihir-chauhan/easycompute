/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('LabFairShareAllocator');

var VERSION = 'drr-maxmin-v1';
var DAY_MS = 24 * 3600 * 1000;
/** Project weight by priority (1 high .. 3 low); deadlines within 14 days get x1.5. */
var PRIORITY_WEIGHT = { 1: 3, 2: 2, 3: 1 };
/** Deficit round robin quantum per unit of weight, in GPU-hours. */
var QUANTUM_GPU_HOURS = 8;

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

function list(arr) {
  var out = [];
  if (arr == null) return out;
  for (var i = 0; i < arr.length; i++) out.push(arr[i]);
  return out;
}

function provenance(note) {
  return { component: 'LabFairShareAllocator', version: VERSION, method: 'weighted deficit round robin (queued work) + weighted max-min (portfolio); lab-level ordering only, Slurm priority unchanged', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: null, historicalOnly: false, computedAt: new Date().toISOString(), note: note || null };
}

/** Projects of the lab with weight, 30-day GPU-hours, fair share and deficit (GPU-hours below fair share). */
function projectState(labId) {
  var now = Date.now();
  var projects = list(Project.fetch({ filter: Filter.eq('lab.id', labId), limit: 200 }).objs).map(function (p) {
    var w = PRIORITY_WEIGHT[num(p.priority, 2)] || 2;
    var dl = ms(p.deadline);
    var urgent = dl != null && dl > now && dl - now <= 14 * DAY_MS;
    return { projectId: p.id, name: p.name, priority: num(p.priority, 2), deadline: p.deadline == null ? null : new Date(dl).toISOString(), deadlineLabel: p.deadlineLabel || null, weight: urgent ? w * 1.5 : w, urgent: urgent, used: 0, usedUsd: 0 };
  });
  var byId = {};
  projects.forEach(function (p) {
    byId[p.projectId] = p;
  });
  var since = new Date(now - 30 * DAY_MS).toISOString().substring(0, 10);
  Job.fetchObjStream({ filter: Filter.eq('lab.id', labId).and("submitTime >= dateTime('" + since + "')"), include: 'project, allocGpus, elapsedHours, costUsd' }).each(function (j) {
    var p = j.project ? byId[j.project.id] : null;
    if (!p) return;
    p.used += num(j.allocGpus, 0) * num(j.elapsedHours, 0);
    p.usedUsd += num(j.costUsd, 0);
  });
  var wSum = projects.reduce(function (s, p) { return s + p.weight; }, 0) || 1;
  var used = projects.reduce(function (s, p) { return s + p.used; }, 0);
  projects.forEach(function (p) {
    p.share = p.weight / wSum;
    p.usageShare = used > 0 ? p.used / used : 0;
    p.deficit = p.share * used - p.used;
  });
  return { projects: projects, byId: byId, totalUsed: used };
}

function projectWeights(labId, projectId) {
  var st = projectState(labId);
  var p = projectId ? st.byId[projectId] : null;
  if (!p) return { projectId: projectId || null, weight: null, share: null, usageShare: null, deficitGpuHours: null, costWeightShift: 0, provenance: provenance('No project: plans ranked on time, cost and risk only.') };
  // a project above its fair share leans toward cheaper plans; one below it toward faster plans
  var rel = st.totalUsed > 0 ? p.deficit / st.totalUsed : 0;
  var shift = Math.max(-0.1, Math.min(0.1, -rel * 0.5));
  return {
    projectId: p.projectId,
    name: p.name,
    weight: round(p.weight, 2),
    share: round(p.share, 4),
    usageShare: round(p.usageShare, 4),
    deficitGpuHours: round(p.deficit, 1),
    costWeightShift: round(shift, 3),
    provenance: provenance(p.name + ' has used ' + round(p.usageShare * 100, 0) + '% of the lab\'s 30-day GPU-hours against a ' + round(p.share * 100, 0) + '% weighted share' + (shift > 0 ? ': cost is weighted higher.' : shift < 0 ? ': finish time is weighted higher.' : '.')),
  };
}

function launchOrder(labId) {
  var st = projectState(labId);
  var queues = {};
  st.projects.forEach(function (p) {
    queues[p.projectId] = [];
  });
  queues._none = [];
  RunRequest.fetchObjStream({ filter: Filter.eq('lab.id', labId).and().intersects('status', ['CHECKED', 'PLANNED']), include: 'id, name, project, estGpuHours, requestedGpus, requestedWalltimeHours, deadline, createdAt, approvalStatus' }).each(function (r) {
    var demand = num(r.estGpuHours, 0) || num(r.requestedGpus, 1) * num(r.requestedWalltimeHours, 4);
    (queues[r.project ? r.project.id : '_none'] || queues._none).push({ kind: 'RUN_REQUEST', id: r.id, name: r.name, projectId: r.project ? r.project.id : null, demand: demand, deadline: r.deadline, createdAt: r.createdAt, blocked: r.approvalStatus == 'PENDING' });
  });
  Job.fetchObjStream({ filter: Filter.eq('lab.id', labId).and().eq('isLive', true).and().eq('state', 'PENDING'), include: 'id, jobName, project, allocGpus, timelimitHours, submitTime' }).each(function (j) {
    (queues[j.project ? j.project.id : '_none'] || queues._none).push({ kind: 'PENDING_JOB', id: j.id, name: j.jobName, projectId: j.project ? j.project.id : null, demand: num(j.allocGpus, 1) * num(j.timelimitHours, 4), deadline: null, createdAt: j.submitTime, blocked: false });
  });
  Object.keys(queues).forEach(function (k) {
    queues[k].sort(function (a, b) {
      return (ms(a.deadline) || 9e15) - (ms(b.deadline) || 9e15) || (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0);
    });
  });
  var lanes = st.projects.map(function (p) {
    return { p: p, q: queues[p.projectId], counter: Math.max(0, p.deficit) };
  });
  if (queues._none.length) lanes.push({ p: { projectId: null, name: 'No project', weight: 1, deficit: 0 }, q: queues._none, counter: 0 });
  var out = [];
  for (var round_ = 0; round_ < 1000 && lanes.some(function (l) { return l.q.length; }); round_++) {
    lanes.forEach(function (l) {
      if (!l.q.length) return;
      l.counter += l.p.weight * QUANTUM_GPU_HOURS;
      while (l.q.length && l.q[0].demand <= l.counter) {
        var it = l.q.shift();
        l.counter -= it.demand;
        out.push({
          position: out.length + 1,
          kind: it.kind,
          id: it.id,
          name: it.name,
          projectId: l.p.projectId,
          projectName: l.p.name,
          weight: round(l.p.weight, 2),
          deficitGpuHours: round(l.p.deficit, 1),
          demandGpuHours: round(it.demand, 1),
          deadline: it.deadline == null ? null : new Date(ms(it.deadline)).toISOString(),
          blockedByApproval: it.blocked,
          reason: l.p.name + ' (weight ' + round(l.p.weight, 1) + (l.p.deficit > 0 ? ', ' + round(l.p.deficit, 0) + ' GPU-h below its fair share' : '') + ') reached ' + round(it.demand, 0) + ' GPU-h of credit in round ' + (round_ + 1) + '.',
        });
      }
      if (!l.q.length) l.counter = 0;
    });
  }
  log.info('launchOrder {}: {} items', labId, out.length);
  return { labId: labId, queue: out, projects: st.projects.map(function (p) { return { projectId: p.projectId, name: p.name, weight: round(p.weight, 2), share: round(p.share, 4), usageShare: round(p.usageShare, 4), deficitGpuHours: round(p.deficit, 1) }; }), provenance: provenance('Quantum ' + QUANTUM_GPU_HOURS + ' GPU-h per unit weight per round; weights 3/2/1 by priority, x1.5 within 14 days of a deadline.') };
}

function portfolio(labId) {
  var st = projectState(labId);
  var now = Date.now();
  var budgetUsd = 0;
  list(Allocation.fetch({ filter: Filter.eq('lab.id', labId), include: 'totalUnits, usedUnits, endDate, cluster.usdPerUnit', limit: 200 }).objs).forEach(function (a) {
    var end = ms(a.endDate);
    if (end != null && end < now) return;
    budgetUsd += Math.max(0, num(a.totalUnits, 0) - num(a.usedUnits, 0)) * num(a.cluster && a.cluster.usdPerUnit, 0);
  });
  // demand: open requests (USD at the lab's recent $/GPU-h) or, without any, the project's last 30 days of spend
  var spent = st.projects.reduce(function (s, p) { return s + p.usedUsd; }, 0);
  var used = st.projects.reduce(function (s, p) { return s + p.used; }, 0);
  var usdPerGh = used > 0 ? spent / used : 2;
  var open = {};
  RunRequest.fetchObjStream({ filter: Filter.eq('lab.id', labId).and().intersects('status', ['DRAFT', 'CHECKED', 'PLANNED']), include: 'project, estGpuHours, requestedGpus, requestedWalltimeHours' }).each(function (r) {
    if (!r.project) return;
    open[r.project.id] = (open[r.project.id] || 0) + (num(r.estGpuHours, 0) || num(r.requestedGpus, 1) * num(r.requestedWalltimeHours, 4)) * usdPerGh;
  });
  var rows = st.projects.map(function (p) {
    return { projectId: p.projectId, name: p.name, weight: p.weight, demand: Math.max(open[p.projectId] || 0, p.usedUsd), allocated: 0, usedRecent: p.usedUsd };
  });
  // weighted max-min (water-filling): split what is left by weight among unsatisfied projects, cap at demand, repeat
  var left = budgetUsd;
  var active = rows.filter(function (r) { return r.demand > 0; });
  for (var it = 0; it < 50 && left > 1e-6 && active.length; it++) {
    var w = active.reduce(function (s, r) { return s + r.weight; }, 0);
    var next = [];
    var given = 0;
    active.forEach(function (r) {
      var take = Math.min(r.demand - r.allocated, (left * r.weight) / w);
      r.allocated += take;
      given += take;
      if (r.demand - r.allocated > 1e-6) next.push(r);
    });
    left -= given;
    if (given < 1e-9) break;
    active = next;
  }
  var wAll = rows.reduce(function (s, r) { return s + r.weight; }, 0) || 1;
  return {
    labId: labId,
    budgetUnits: round(budgetUsd, 2),
    unitName: 'USD',
    unallocated: round(left, 2),
    projects: rows.map(function (r) {
      var fair = (budgetUsd * r.weight) / wAll;
      return { projectId: r.projectId, name: r.name, weight: round(r.weight, 2), demand: round(r.demand, 2), fairShare: round(fair, 2), allocated: round(r.allocated, 2), usedRecent: round(r.usedRecent, 2), status: r.usedRecent > fair * 1.2 ? 'OVER' : r.usedRecent < fair * 0.5 ? 'UNDER' : 'FAIR' };
    }),
    provenance: provenance('Budget = remaining allocations in USD; demand = open requests at the lab\'s recent $' + round(usdPerGh, 2) + '/GPU-h, or the last 30 days of spend.'),
  };
}
