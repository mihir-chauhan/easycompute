/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('DataLineage');

var HOUR_MS = 3600 * 1000;

/** Ingestion feeds built by the native data pipelines (FileSourceCollection names) and the entities they load. */
var FEEDS = [
  { name: 'SlurmSacctFeed', label: 'Slurm sacct export', detail: 'Accounting records (sacct, pipe-delimited) from Anvil, Gilbreth, Gautschi, Negishi', targets: ['Job'] },
  { name: 'JobTelemetryFeed', label: 'Job telemetry', detail: 'Per-job GPU/CPU/memory/I/O samples (DCGM + cgroup exporters)', targets: ['JobMetric'] },
  { name: 'AllocationLedgerFeed', label: 'Allocation ledger', detail: 'Node-share / GPU-hour bank / ACCESS SU balances per lab', targets: ['Allocation'] },
  { name: 'ClusterStatusFeed', label: 'Cluster status', detail: 'Partition utilization and limits (sinfo/showpartitions)', targets: ['Partition', 'ComputeCluster'] },
];

/** Package entities: group, freshness field (the record's own timestamp) and whether it is a live feed. */
var ENTITIES = [
  { type: 'ComputeCluster', group: 'reference' },
  { type: 'Partition', group: 'reference' },
  { type: 'GpuType', group: 'reference' },
  { type: 'Lab', group: 'reference' },
  { type: 'LabMember', group: 'reference' },
  { type: 'Allocation', group: 'reference', ts: 'startDate' },
  { type: 'Project', group: 'reference' },
  { type: 'Policy', group: 'reference' },
  { type: 'AutopilotPolicy', group: 'reference' },
  { type: 'RunRequest', group: 'planner', ts: 'createdAt' },
  { type: 'RuleCheck', group: 'planner', ts: 'checkedAt' },
  { type: 'RunPlan', group: 'planner', ts: 'finishBy' },
  { type: 'Job', group: 'monitor', ts: 'submitTime', live: true },
  { type: 'JobMetric', group: 'monitor', ts: 'ts', live: true },
  { type: 'JobAlert', group: 'monitor', ts: 'detectedAt' },
  { type: 'ActionLogEntry', group: 'monitor', ts: 'actedAt' },
  { type: 'AppUser', group: 'reference', ts: 'lastActive' },
  { type: 'JobPrediction', group: 'monitor', ts: 'scoredAt', optional: true },
];

function ms(v) {
  return v == null ? null : Date.parse(String(v));
}

function round(v, digits) {
  var f = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(Number(v || 0) * f) / f;
}

function list(arr) {
  var out = [];
  if (arr == null) return out;
  for (var i = 0; i < arr.length; i++) out.push(arr[i]);
  return out;
}

/** A type by name, or null when it is not deployed in this package (pipelines are added by another workstream). */
function typeOrNull(name) {
  try {
    var t = eval(name);
    return t != null && typeof t.fetchCount === 'function' ? t : null;
  } catch (e) {
    return null;
  }
}

function latest(type, field) {
  var res = type.evaluate({ projection: 'max(' + field + ')' });
  var c = res.tuples && res.tuples.length ? res.tuples[0].cells[0] : null;
  var t = c == null ? null : ms(c.value());
  return t == null || isNaN(t) ? null : t;
}

function entityNode(e, now) {
  var T = typeOrNull(e.type);
  var rows = T ? T.fetchCount() : 0;
  var last = T && e.ts && rows > 0 ? latest(T, e.ts) : null;
  var fresh = last == null ? null : round((now - last) / HOUR_MS, 1);
  var status = rows === 0 ? 'EMPTY' : e.live && fresh != null && fresh > 24 ? 'STALE' : 'OK';
  return {
    id: 'ent:' + e.type,
    kind: 'ENTITY',
    label: e.type,
    detail: e.type + ' records in the EasyCompute package',
    group: e.group,
    stats: { rows: rows, lastLoad: last == null ? null : new Date(last).toISOString(), rejected: 0, freshnessHours: fresh, status: status },
  };
}

/** Load statistics of a deployed FileSourceCollection feed, or NOT_DEPLOYED. */
function feedStats(feed) {
  var stats = { rows: 0, lastLoad: null, rejected: 0, freshnessHours: null, status: 'NOT_DEPLOYED', files: 0, failedFiles: 0 };
  var FSC = typeOrNull('FileSourceCollection');
  if (FSC == null) return stats;
  var coll = list(FSC.fetch({ filter: Filter.eq('name', feed.name), limit: 1 }).objs)[0];
  if (coll == null) return stats;
  stats.status = 'EMPTY';
  var SF = typeOrNull('SourceFile');
  if (SF != null) {
    list(SF.fetch({ filter: Filter.eq('sourceCollectionName', feed.name), include: 'id, status, meta', limit: 500 }).objs).forEach(function (f) {
      stats.files++;
      var st = f.status && f.status.state ? String(f.status.state).toLowerCase() : '';
      if (st == 'failed' || st == 'rejected') stats.failedFiles++;
      var t = f.meta ? ms(f.meta.updated) : null;
      if (t != null && (stats.lastLoad == null || t > Date.parse(stats.lastLoad))) stats.lastLoad = new Date(t).toISOString();
    });
  }
  var REJ = typeOrNull('IngestRejection');
  if (REJ != null) stats.rejected = REJ.fetchCount({ filter: Filter.eq('feed', feed.name) });
  if (stats.files > 0) stats.status = stats.failedFiles > 0 ? 'ERRORS' : 'OK';
  return stats;
}

function graph() {
  var now = Date.now();
  var nodes = [];
  var edges = [];
  var entityRows = {};

  ENTITIES.forEach(function (e) {
    if (e.optional && typeOrNull(e.type) == null) return;
    var n = entityNode(e, now);
    entityRows[e.type] = n.stats.rows;
    nodes.push(n);
  });

  // ingestion feeds: source -> pipeline -> entities
  var rejectedTotal = 0;
  FEEDS.forEach(function (f) {
    var st = feedStats(f);
    rejectedTotal += st.rejected;
    var deployed = st.status != 'NOT_DEPLOYED';
    if (st.lastLoad) st.freshnessHours = round((now - Date.parse(st.lastLoad)) / HOUR_MS, 1);
    st.rows = f.targets.reduce(function (s, t) {
      return s + (entityRows[t] || 0);
    }, 0);
    nodes.push({ id: 'src:' + f.name, kind: 'SOURCE', label: f.label, detail: f.detail, group: 'ingest', stats: { rows: deployed ? st.rows : 0, lastLoad: st.lastLoad, rejected: 0, freshnessHours: st.freshnessHours, status: st.status, files: st.files, failedFiles: st.failedFiles } });
    nodes.push({ id: 'pipe:' + f.name, kind: 'PIPELINE', label: f.name, detail: 'FileSourceCollection ' + f.name + ' -> Canonical -> Transform' + (deployed ? '' : ' (not deployed yet; data currently comes from package seed)'), group: 'ingest', stats: st });
    edges.push({ from: 'src:' + f.name, to: 'pipe:' + f.name, label: 'files', rows: deployed ? st.rows : 0 });
    f.targets.forEach(function (t) {
      edges.push({ from: 'pipe:' + f.name, to: 'ent:' + t, label: 'transform', rows: deployed ? entityRows[t] || 0 : 0 });
    });
  });

  // other sources
  var seedRows = 0;
  ENTITIES.forEach(function (e) {
    if (e.type != 'AppUser') seedRows += entityRows[e.type] || 0;
  });
  nodes.push({ id: 'src:seed', kind: 'SOURCE', label: 'Historical accounting archive', detail: 'Bulk-loaded Slurm accounting history and lab reference data (users and paths pseudonymized)', group: 'reference', stats: { rows: seedRows, lastLoad: null, rejected: 0, freshnessHours: null, status: 'OK' } });
  ['ComputeCluster', 'Partition', 'GpuType', 'Lab', 'LabMember', 'Allocation', 'Project', 'Policy', 'AutopilotPolicy', 'Job', 'JobMetric'].forEach(function (t) {
    edges.push({ from: 'src:seed', to: 'ent:' + t, label: 'seed', rows: entityRows[t] || 0 });
  });
  var metricNode = nodes.filter(function (n) {
    return n.id == 'ent:JobMetric';
  })[0];
  nodes.push({ id: 'src:simulator', kind: 'SOURCE', label: 'Live run simulator', detail: 'RunMonitor.tick: 15-minute steps for live jobs (CronJob EasyComputeMonitorTick or "Simulate next 15 min")', group: 'monitor', stats: { rows: entityRows.JobMetric || 0, lastLoad: metricNode.stats.lastLoad, rejected: 0, freshnessHours: metricNode.stats.freshnessHours, status: metricNode.stats.status } });
  edges.push({ from: 'src:simulator', to: 'ent:JobMetric', label: 'samples', rows: entityRows.JobMetric || 0 });
  edges.push({ from: 'src:simulator', to: 'ent:JobAlert', label: 'health rules', rows: entityRows.JobAlert || 0 });
  edges.push({ from: 'src:simulator', to: 'ent:ActionLogEntry', label: 'autopilot', rows: entityRows.ActionLogEntry || 0 });
  nodes.push({ id: 'src:labs', kind: 'SOURCE', label: 'Lab input', detail: 'Lab context dumps and run descriptions typed in the app', group: 'planner', stats: { rows: (entityRows.RunRequest || 0) + (entityRows.Lab || 0), lastLoad: null, rejected: 0, freshnessHours: null, status: 'OK' } });
  edges.push({ from: 'src:labs', to: 'ent:RunRequest', label: 'run requests', rows: entityRows.RunRequest || 0 });
  edges.push({ from: 'src:labs', to: 'ent:Lab', label: 'context', rows: entityRows.Lab || 0 });
  edges.push({ from: 'ent:RunRequest', to: 'ent:RuleCheck', label: 'checkRules', rows: entityRows.RuleCheck || 0 });
  edges.push({ from: 'ent:RunRequest', to: 'ent:RunPlan', label: 'recommendPlans', rows: entityRows.RunPlan || 0 });
  edges.push({ from: 'ent:RunPlan', to: 'ent:Job', label: 'submit', rows: null });

  // consumers
  var consumers = [
    { id: 'use:planner', label: 'Launch planner', detail: 'RunRequest.checkRules / recommendPlans / submit', from: ['Policy', 'Partition', 'Allocation', 'Job', 'Project'] },
    { id: 'use:monitor', label: 'Live monitor + autopilot', detail: 'Job.evaluateHealth, Job.applyAction, RunMonitor.tick', from: ['JobMetric', 'Job', 'AutopilotPolicy', 'Allocation'] },
    { id: 'use:insights', label: 'Dashboards', detail: 'Insights.labSummary / universityOverview', from: ['Job', 'Allocation', 'Partition', 'ComputeCluster', 'JobAlert'] },
    { id: 'use:advisor', label: 'AI Advisor', detail: 'Advisor agent tools over planner, monitor and insights', from: ['Lab', 'RunRequest', 'Job', 'Policy'] },
  ];
  var ml = typeOrNull('JobDurationModel') || typeOrNull('JobPrediction');
  consumers.push({ id: 'use:ml', label: 'ML duration model', detail: ml ? 'Trained on completed Job history' : 'Planned: trained on completed Job history (not deployed yet)', from: ['Job'], notDeployed: !ml });
  consumers.forEach(function (c) {
    nodes.push({ id: c.id, kind: 'CONSUMER', label: c.label, detail: c.detail, group: 'consumer', stats: { rows: null, lastLoad: null, rejected: 0, freshnessHours: null, status: c.notDeployed ? 'NOT_DEPLOYED' : 'OK' } });
    c.from.forEach(function (t) {
      edges.push({ from: 'ent:' + t, to: c.id, label: 'reads', rows: entityRows[t] || 0 });
    });
  });
  if (entityRows.JobPrediction !== undefined) {
    edges.push({ from: 'use:ml', to: 'ent:JobPrediction', label: 'scoreLive (hourly)', rows: entityRows.JobPrediction });
    edges.push({ from: 'ent:JobPrediction', to: 'use:monitor', label: 'walltime risk', rows: entityRows.JobPrediction });
  }

  var count = function (kind) {
    return nodes.filter(function (n) {
      return n.kind == kind;
    }).length;
  };
  var totalRows = ENTITIES.filter(function (e) {
    return entityRows[e.type] !== undefined;
  }).reduce(function (s, e) {
    return s + (entityRows[e.type] || 0);
  }, 0);
  log.info('graph: {} nodes, {} edges', nodes.length, edges.length);
  return {
    asOf: new Date(now).toISOString(),
    nodes: nodes,
    edges: edges,
    summary: {
      sources: count('SOURCE'),
      pipelines: count('PIPELINE'),
      entities: count('ENTITY'),
      consumers: count('CONSUMER'),
      totalRows: totalRows,
      rejectedRows: rejectedTotal,
      staleNodes: nodes.filter(function (n) {
        return n.stats.status == 'STALE' || n.stats.status == 'ERRORS';
      }).length,
    },
  };
}
