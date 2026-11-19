/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('GPUShapeAdvisor');

var CATALOGUE_VERSION = 'purdue-gpu-catalogue-2026-11';

function num(v, dflt) {
  return v == null || isNaN(Number(v)) ? dflt : Number(v);
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

/**
 * GPU memory a workload needs (EleutherAI "Transformer Math 101" rules of thumb): full training / fine-tuning with AdamW in
 * mixed precision ~16 bytes per parameter (+20% activations); LoRA / QLoRA ~2.6 bytes per parameter; fp16 inference
 * ~2 bytes per parameter (+20% KV cache / activations); other workloads: dataset-driven, no hard floor.
 */
function memoryNeed(workloadType, paramsB, description) {
  var wt = String(workloadType || '');
  if (!(paramsB > 0)) return { gb: 0, rule: 'no model size given: no GPU memory floor' };
  if (wt == 'FINETUNE' && /q?lora|adapter|peft/i.test(String(description || ''))) return { gb: paramsB * 2.6, rule: 'LoRA/QLoRA fine-tune: frozen bf16 base + adapters ~2.6 B/param' };
  if (wt == 'TRAINING' || wt == 'FINETUNE') return { gb: paramsB * 16 * 1.2, rule: 'full training, AdamW mixed precision: ~16 B/param + 20% activations' };
  if (wt == 'INFERENCE' || wt == 'INTERACTIVE') return { gb: paramsB * 2 * 1.2, rule: 'fp16/bf16 inference: 2 B/param + 20% KV cache' };
  return { gb: 0, rule: 'simulation / data processing: no model-size memory rule' };
}

function advise(workloadType, modelParamsB, datasetGb, requestedGpus, requestedGpuTypeId, description) {
  var wt = String(workloadType || 'TRAINING');
  var paramsB = num(modelParamsB, 0);
  var need = memoryNeed(wt, paramsB, description);
  var online = {};
  list(ComputeCluster.fetch({ include: 'id, status', limit: 200 }).objs).forEach(function (c) {
    online[c.id] = String(c.status) == 'ONLINE' || String(c.status) == 'DEGRADED';
  });
  // where each GPU type is available, and the largest job it can form
  var avail = {};
  list(Partition.fetch({ include: 'id, cluster, gpuType, gpusPerNode, maxNodesPerJob, maxGpusPerJob', limit: 500 }).objs).forEach(function (p) {
    if (p.gpuType == null || !online[p.cluster.id]) return;
    var gt = String(p.gpuType.id);
    var cap = Math.min(num(p.maxGpusPerJob, 64) || 64, num(p.gpusPerNode, 1) * (num(p.maxNodesPerJob, 1) || 1));
    var a = (avail[gt] = avail[gt] || { maxGpus: 0, clusters: {} });
    a.maxGpus = Math.max(a.maxGpus, cap);
    a.clusters[p.cluster.id] = true;
  });
  var shapes = list(GpuType.fetch({ limit: 100 }).objs)
    .filter(function (g) {
      return avail[g.id] != null;
    })
    .map(function (g) {
      var mem = num(g.memoryGb, 40);
      var rel = num(g.relativeThroughput, 1);
      var minGpus = need.gb > 0 ? Math.max(1, Math.ceil(need.gb / (mem * 0.9))) : 1;
      var cap = avail[g.id].maxGpus;
      var options = [];
      if (requestedGpus > 0) options.push(Number(requestedGpus));
      else
        [minGpus, minGpus * 2, minGpus * 4].forEach(function (n) {
          if (n <= cap && options.indexOf(n) < 0) options.push(n);
        });
      var fit;
      var reason;
      if (minGpus > cap) {
        fit = 'NO_FIT';
        reason = 'Needs ' + minGpus + ' x ' + g.id + ' for ~' + round(need.gb, 0) + ' GB but the largest job on it is ' + cap + ' GPUs.';
      } else if (need.gb > 0 && need.gb < mem * 0.3 && rel >= 2 && (wt == 'INFERENCE' || wt == 'INTERACTIVE' || wt == 'FINETUNE')) {
        fit = 'POOR';
        reason = g.id + ' is oversized: ~' + round(need.gb, 0) + ' GB uses under 30% of its ' + mem + ' GB; an A30/L40S/A100 slice costs less.';
      } else if ((wt == 'TRAINING' || wt == 'FINETUNE') && rel < 0.6 && minGpus > 2) {
        fit = 'POOR';
        reason = g.id + ' (' + rel + 'x A100) would need ' + minGpus + ' GPUs for this model; a larger GPU trains it with less communication overhead.';
      } else if (/MI210/.test(g.id) && (wt == 'TRAINING' || wt == 'FINETUNE' || wt == 'INFERENCE')) {
        fit = 'OK';
        reason = 'AMD MI210 (ROCm): fits in ' + minGpus + ' GPU(s); check that the framework build supports ROCm.';
      } else {
        var headroom = need.gb > 0 ? 1 - need.gb / (minGpus * mem) : null;
        fit = headroom == null || (headroom >= 0.1 && headroom <= 0.75) ? 'GOOD' : 'OK';
        reason = need.gb > 0
          ? 'Fits in ' + minGpus + ' x ' + g.id + ' (' + mem + ' GB each) with ' + Math.round(headroom * 100) + '% memory headroom; ' + rel + 'x A100 throughput.'
          : g.id + ' (' + mem + ' GB, ' + rel + 'x A100 throughput); no model-size memory floor.';
      }
      if (requestedGpuTypeId && requestedGpuTypeId != g.id) reason += ' (not the requested ' + requestedGpuTypeId + ')';
      return { gpuTypeId: g.id, name: g.name, memoryGb: mem, relativeThroughput: rel, minGpus: minGpus, maxGpus: cap, options: options.length ? options : [minGpus], fit: fit, reason: reason, clusters: Object.keys(avail[g.id].clusters) };
    });
  var order = { GOOD: 0, OK: 1, POOR: 2, NO_FIT: 3 };
  shapes.sort(function (a, b) {
    return order[a.fit] - order[b.fit] || b.relativeThroughput - a.relativeThroughput;
  });
  log.info('advise {} {}B: {} shapes', wt, paramsB, shapes.length);
  return {
    workloadType: wt,
    modelParamsB: paramsB,
    memoryNeedGb: round(need.gb, 1),
    memoryRule: need.rule,
    shapes: shapes,
    provenance: { component: 'GPUShapeAdvisor', version: CATALOGUE_VERSION, method: 'hardware catalogue (GpuType, Partition) + deterministic memory/throughput rules; no learned GPU model', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: null, historicalOnly: false, computedAt: new Date().toISOString() },
  };
}
