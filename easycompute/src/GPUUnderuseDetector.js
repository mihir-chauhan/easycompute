/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('GPUUnderuseDetector');

var VERSION = 'ewma-cusum-v1';
/** EWMA smoothing, CUSUM slack k and decision threshold h (utilization points), and the absolute idle floor. */
var LAMBDA = 0.3;
var K = 5;
var H = 60;
var IDLE_PCT = 5;

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

function median(xs) {
  var s = xs.slice().sort(function (a, b) {
    return a - b;
  });
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
}

/**
 * Persistent-underuse test against the run's own baseline: baseline = median GPU utilization of the first hour
 * (at least 3 samples; 70% when the run started idle); EWMA (lambda 0.3) smooths the series; a one-sided CUSUM
 * accumulates (baseline - util - k) and signals when it exceeds h. A short dip does not trigger; a sustained drop does.
 */
function analyze(jobId) {
  var job = Job.make({ id: jobId }).get('allocGpus, state');
  if (job == null) throw new Error('Job ' + jobId + ' not found');
  var samples = list(JobMetric.fetch({ filter: Filter.eq('job.id', jobId), order: 'descending(ts)', limit: 96, include: 'ts, gpuUtilPct' }).objs).reverse();
  var gpus = num(job.allocGpus, 0);
  var prov = { component: 'GPUUnderuseDetector', version: VERSION, method: 'EWMA (lambda ' + LAMBDA + ') + one-sided CUSUM (k ' + K + ', h ' + H + ') over the run\'s own GPU-utilization baseline', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: samples.length, historicalOnly: false, computedAt: new Date().toISOString() };
  if (gpus <= 0 || samples.length < 2) {
    return { jobId: jobId, applicable: false, reason: gpus <= 0 ? 'CPU-only job' : 'not enough telemetry', points: [], provenance: prov };
  }
  var t0 = ms(samples[0].ts);
  var first = samples.filter(function (s) {
    return ms(s.ts) - t0 <= 3600 * 1000;
  }).map(function (s) {
    return num(s.gpuUtilPct, 0);
  });
  var base = first.length >= 3 ? median(first) : null;
  var baselineSource = 'first hour median';
  if (base == null || base < 20) {
    base = 70;
    baselineSource = 'default 70% (run started idle or too little history)';
  }
  var ewma = num(samples[0].gpuUtilPct, base);
  var cusum = 0;
  var alarmAt = null;
  var points = samples.map(function (s) {
    var u = num(s.gpuUtilPct, 0);
    ewma = LAMBDA * u + (1 - LAMBDA) * ewma;
    cusum = Math.max(0, cusum + (base - u - K));
    if (cusum > H && alarmAt == null) alarmAt = s.ts;
    if (cusum <= H) alarmAt = null;
    return { ts: new Date(ms(s.ts)).toISOString(), util: round(u, 1), ewma: round(ewma, 1), cusum: round(cusum, 1) };
  });
  var last = samples[samples.length - 1];
  var lastTs = ms(last.ts);
  var idleSince = null;
  for (var i = samples.length - 1; i >= 0 && num(samples[i].gpuUtilPct, 0) < IDLE_PCT; i--) idleSince = ms(samples[i].ts);
  var gap = samples.length > 1 ? (lastTs - ms(samples[samples.length - 2].ts)) / 60000 : 5;
  var idleMinutes = idleSince == null ? 0 : Math.round((lastTs - idleSince) / 60000 + gap);
  var persistent = cusum > H;
  log.info('analyze {}: baseline {} ewma {} cusum {}', jobId, base, round(ewma, 1), round(cusum, 1));
  return {
    jobId: jobId,
    applicable: true,
    gpus: gpus,
    baselineUtil: round(base, 1),
    baselineSource: baselineSource,
    ewma: round(ewma, 1),
    cusum: round(cusum, 1),
    threshold: H,
    persistentUnderuse: persistent,
    underuseSince: persistent && alarmAt != null ? new Date(ms(alarmAt)).toISOString() : null,
    dropPoints: round(base - ewma, 1),
    idleMinutes: idleMinutes,
    points: points,
    provenance: prov,
  };
}
