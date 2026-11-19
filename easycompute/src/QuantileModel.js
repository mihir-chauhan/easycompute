/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/*
 * QuantileModel: the MODEL_MAP Anvil quantile baselines (AnvilRuntimeQ50Q90, AnvilQueueWaitQ50Q90, AnvilHostMemoryQ50Q90,
 * AnvilTaskCPUQ50Q90). The predictor below is the ML trainer's reference implementation (project/tools/ml/quantile_model.js),
 * ported verbatim except that Math.log1p / Math.expm1 go through ES5-safe helpers; parity with
 * project/tools/ml/golden_vectors.json is checked by the backend harness.
 */

var log = Logger.for('QuantileModel');

var COMPONENTS = ['AnvilRuntimeQ50Q90', 'AnvilQueueWaitQ50Q90', 'AnvilHostMemoryQ50Q90', 'AnvilTaskCPUQ50Q90'];

function qmLog1p(x) {
  return typeof Math.log1p === 'function' ? Math.log1p(x) : Math.abs(x) < 1e-5 ? x - (x * x) / 2 + (x * x * x) / 3 : Math.log(1 + x);
}

function qmExpm1(x) {
  return typeof Math.expm1 === 'function' ? Math.expm1(x) : Math.abs(x) < 1e-5 ? x + (x * x) / 2 + (x * x * x) / 6 : Math.exp(x) - 1;
}

var QM_PARTITIONS = ['shared', 'standard', 'gpu', 'gpu-debug', 'highmem', 'wide', 'debug', 'other'];
var QM_LOW_SUPPORT = 30;

function qmNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  var n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

function qmWeekdayMon0(y, m, d) {
  var t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  var yy = m < 3 ? y - 1 : y;
  var sun0 = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7;
  return (sun0 + 6) % 7;
}

function qmPartition(p) {
  var s = String(p === null || p === undefined ? '' : p).replace(/^\s+|\s+$/g, '').toLowerCase();
  return QM_PARTITIONS.indexOf(s) >= 0 ? s : 'other';
}

/** Raw (unscaled) feature map + list of missing (neutral) feature names. */
function qmRawFeatures(f) {
  var x = {}, missing = [];
  var i;
  for (i = 0; i < QM_PARTITIONS.length; i++) x['part_' + QM_PARTITIONS[i]] = 0;
  x['part_' + qmPartition(f.partition)] = 1;
  x.log1p_req_cpus = qmLog1p(qmNum(f.reqCpus));
  x.log1p_req_nodes = qmLog1p(qmNum(f.reqNodes));
  x.log1p_req_gpus = qmLog1p(qmNum(f.reqGpus));
  var mem = qmNum(f.reqMemGiB !== null && f.reqMemGiB !== undefined ? f.reqMemGiB : f.reqMemGib); // API.md alias
  x.log1p_req_mem_gib = qmLog1p(mem);
  x.mem_missing = mem > 0 ? 0 : 1;
  var wall = qmNum(f.walltimeHours);
  x.log1p_walltime_hours = wall > 0 ? qmLog1p(wall) : 0;
  if (!(wall > 0)) missing.push('log1p_walltime_hours');

  var hour = null, wd = null, month = null;
  if (f.submitTime) {
    var s = String(f.submitTime);
    var y = parseInt(s.substr(0, 4), 10), mo = parseInt(s.substr(5, 2), 10), d = parseInt(s.substr(8, 2), 10);
    hour = parseInt(s.substr(11, 2), 10);
    wd = qmWeekdayMon0(y, mo, d);
    month = mo;
  } else {
    if (f.submitHour !== null && f.submitHour !== undefined) hour = parseInt(f.submitHour, 10);
    if (f.submitWeekday !== null && f.submitWeekday !== undefined) wd = parseInt(f.submitWeekday, 10);
    if (f.submitMonth !== null && f.submitMonth !== undefined) month = parseInt(f.submitMonth, 10);
  }
  var cyc = [['hour', hour, 24, 0], ['weekday', wd, 7, 0], ['month', month, 12, 1]];
  for (i = 0; i < cyc.length; i++) {
    var name = cyc[i][0], val = cyc[i][1];
    if (val === null || isNaN(val)) {
      x[name + '_sin'] = 0; x[name + '_cos'] = 0;
      missing.push(name + '_sin', name + '_cos');
    } else {
      var a = 2 * Math.PI * (val - cyc[i][3]) / cyc[i][2];
      x[name + '_sin'] = Math.sin(a); x[name + '_cos'] = Math.cos(a);
    }
  }
  return { x: x, missing: missing };
}

/** Returns { p50, p90, unit, ... provenance }. */
function quantileModelPredict(record, features) {
  if (typeof record === 'string') record = JSON.parse(record);
  if (typeof features === 'string') features = JSON.parse(features);
  features = features || {};
  var payload = record.payload || record;
  if (typeof payload === 'string') payload = JSON.parse(payload);
  var schema = payload.featureSchema, names = schema.features;
  var mean = schema.scaling.mean, std = schema.scaling.std;
  var raw = qmRawFeatures(features);
  var z = [], i;
  for (i = 0; i < names.length; i++) {
    z.push(raw.missing.indexOf(names[i]) >= 0 ? 0 : (raw.x[names[i]] - mean[i]) / std[i]);
  }
  var tgt = payload.target, out = {};
  var keys = ['p50', 'p90'];
  for (var k = 0; k < keys.length; k++) {
    var h = payload.heads[keys[k]], t = h.intercept;
    for (i = 0; i < z.length; i++) t += h.coefficients[i] * z[i];
    out[keys[k]] = Math.max(0, qmExpm1(t) / tgt.scale);
  }
  out.p90 = Math.max(out.p90, out.p50);
  var wall = qmNum(features.walltimeHours);
  if (tgt.clipToWalltime && wall > 0) {
    out.p50 = Math.min(out.p50, wall);
    out.p90 = Math.min(out.p90, wall);
  }
  var part = qmPartition(features.partition);
  var support = payload.sampleSupport || {};
  var partSupport = (support.byPartition && support.byPartition[part]) || 0;
  return {
    modelId: record.id || null,
    component: record.name || payload.component,
    version: record.modelVersion || 'v1',
    p50: out.p50,
    p90: out.p90,
    unit: tgt.unit,
    target: tgt.name,
    partitionCategory: part,
    trainingPeriod: record.trainingPeriod || null,
    sampleSupport: support.total || record.sampleSupport || 0,
    partitionSupport: partSupport,
    lowSupport: partSupport < QM_LOW_SUPPORT,
    confidence: payload.confidence,
    historicalOnly: true,
    label: 'historical only'
  };
}

function plain(v) {
  if (v == null) return v;
  if (typeof v === 'string') return JSON.parse(v);
  if (typeof v.toJsonString === 'function') return JSON.parse(v.toJsonString());
  return v;
}

/** The seeded record for an artifact id or a component name, as a plain object; null when not loaded. */
function loadRecord(id) {
  var m = QuantileModel.make({ id: id }).get('this');
  if (m == null) m = list(QuantileModel.fetch({ filter: Filter.eq('name', id), order: 'descending(modelVersion)', limit: 1 }).objs)[0] || null;
  if (m == null || m.payload == null) return null;
  return { id: String(m.id), name: String(m.name), modelVersion: m.modelVersion, trainingPeriod: m.trainingPeriod, sampleSupport: m.sampleSupport, status: m.status || 'CHAMPION', payload: plain(m.payload) };
}

function list(arr) {
  var out = [];
  if (arr == null) return out;
  for (var i = 0; i < arr.length; i++) out.push(arr[i]);
  return out;
}

function provenanceOf(rec, r) {
  return {
    component: rec.name,
    version: rec.modelVersion || 'v1',
    modelId: rec.id,
    method: (rec.payload && rec.payload.family) || 'LinearQuantileRegressor/NumPyPinballAdam',
    status: rec.status || 'CHAMPION',
    trainingPeriod: rec.trainingPeriod || null,
    sampleSupport: r ? r.sampleSupport : rec.sampleSupport == null ? null : Number(rec.sampleSupport),
    partitionSupport: r ? r.partitionSupport : null,
    lowSupport: r ? r.lowSupport : null,
    confidence: r ? r.confidence : rec.payload ? rec.payload.confidence : null,
    historicalOnly: true,
    label: 'historical only',
    computedAt: new Date().toISOString(),
  };
}

function notLoaded(id) {
  return { component: id, version: null, modelId: null, method: 'not loaded', status: 'FALLBACK_HEURISTIC', trainingPeriod: null, sampleSupport: null, historicalOnly: true, label: 'historical only', computedAt: new Date().toISOString(), note: 'No QuantileModel row for ' + id + '; callers use their labeled heuristic.' };
}

function predictBatch(id, featuresListJson) {
  var items = plain(featuresListJson) || [];
  var rec = loadRecord(id);
  if (rec == null) return { predictions: null, unit: null, available: false, provenance: notLoaded(id) };
  var preds = items.map(function (f) {
    var r = quantileModelPredict(rec, plain(f));
    return { p50: r.p50, p90: r.p90, partitionCategory: r.partitionCategory, partitionSupport: r.partitionSupport, lowSupport: r.lowSupport };
  });
  var first = items.length ? quantileModelPredict(rec, plain(items[0])) : null;
  return { predictions: preds, unit: rec.payload.target.unit, available: true, provenance: provenanceOf(rec, first) };
}

function predict(id, featuresJson) {
  var rec = loadRecord(id);
  if (rec == null) return { p50: null, p90: null, unit: null, available: false, provenance: notLoaded(id) };
  var r = quantileModelPredict(rec, plain(featuresJson));
  return { p50: r.p50, p90: r.p90, unit: r.unit, target: r.target, partitionCategory: r.partitionCategory, lowSupport: r.lowSupport, available: true, provenance: provenanceOf(rec, r) };
}

function registry() {
  var models = COMPONENTS.map(function (c) {
    var m = list(QuantileModel.fetch({ filter: Filter.eq('name', c), limit: 5 }).objs)[0];
    return {
      id: m ? m.id : null,
      component: c,
      status: m ? m.status || 'CHAMPION' : 'FALLBACK_HEURISTIC',
      modelVersion: m ? m.modelVersion : null,
      family: m ? m.family : null,
      confidence: m ? m.confidence : null,
      targetName: m ? m.targetName : null,
      targetUnit: m ? m.targetUnit : null,
      trainingPeriod: m ? m.trainingPeriod : null,
      sampleSupport: m && m.sampleSupport != null ? Number(m.sampleSupport) : null,
      trainCount: m && m.trainCount != null ? Number(m.trainCount) : null,
      testCount: m && m.testCount != null ? Number(m.testCount) : null,
      splitLabel: m ? m.splitLabel : null,
      metrics: m && m.metrics != null ? plain(m.metrics) : null,
      historicalOnly: true,
      hasArtifact: !!(m && m.payload != null),
    };
  });
  var challenger = { id: 'JobDurationModel', component: 'JobDurationModel', status: 'CHALLENGER', deployed: false, predictions: 0, note: 'C3 Code-built job-duration model (native-ai MlProject job-duration); evaluated, not used by the planner.' };
  if (typeof JobPrediction !== 'undefined') {
    challenger.deployed = true;
    challenger.predictions = JobPrediction.fetchCount();
  }
  log.info('registry: {} champion artifacts', models.filter(function (x) { return x.hasArtifact; }).length);
  return { models: models, challenger: challenger, computedAt: new Date().toISOString() };
}
