/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('EasyComputeSchema');

/** Every EasyCompute entity type (tables the package owns). */
var ENTITIES = [
  'GpuType', 'ComputeCluster', 'Partition', 'Lab', 'LabMember', 'Allocation', 'Project', 'Policy', 'AutopilotPolicy',
  'RunRequest', 'RuleCheck', 'RunPlan', 'Job', 'JobMetric', 'JobAlert', 'ActionLogEntry', 'AppUser', 'DemoIdentity',
  'QuantileModel', 'RunSimulatorSettings',
  // other workstreams' entities in the same package (advisor, native-ai)
  'Advisor.ConstraintSet', 'Advisor.ToolCall', 'GuardrailTriage', 'JobDurationModel.Run', 'JobPrediction',
];

/** Fields (stored columns) added after the first live push, 2026-11-19 18:36 UTC. */
var ADDED = {
  Job: ['simScenario', 'etaStartAt', 'queuePosition', 'latestSample', 'lastSimAt'],
  RunRequest: ['approvalStatus', 'approvalReason', 'approvedBy', 'approvedAt'],
  RuleCheck: ['provenance'],
  RunPlan: ['estDurationP90Hours', 'estWaitP90Hours', 'memRequestGb', 'cpuEvidence', 'shapeReason', 'provenance'],
  JobAlert: ['firedRule', 'evidence', 'provenance'],
  Partition: ['baseUtilizationPct', 'baseQueueDepth', 'baseAvgWaitHours'],
  ComputeCluster: ['healthPct', 'liveUtilizationPct'],
  AppUser: ['email', 'username', 'lab', 'labMember', 'role', 'status', 'lastActive', 'invitedBy', 'invitedAt'],
  DemoIdentity: ['appUser'],
  QuantileModel: ['status', 'modelVersion', 'family', 'historicalOnly', 'confidence', 'targetName', 'targetUnit', 'trainingPeriod', 'sampleSupport', 'trainCount', 'testCount', 'splitLabel', 'metrics', 'payload'],
  RunSimulatorSettings: ['enabled', 'demoTimeScale', 'queueWaitCompression', 'sampleIntervalSec', 'maxCatchUpMin', 'maxSamplesPerJob', 'respawnScriptedJobs', 'lastTickAt', 'lastTickSummary'],
  // advisor
  'Advisor.ConstraintSet': ['confirmedHash', 'confirmedResult', 'confirmedAt'],
  'Advisor.ToolCall': ['evidence'],
  // native-ai
  GuardrailTriage: ['alert', 'job', 'severity', 'rootCause', 'recommendedAction', 'rationale', 'actionLogEntry', 'workflowExecutionId', 'triagedAt'],
  'JobDurationModel.Run': ['modelId', 'projectId', 'routeId', 'routeStatus', 'retiredRoutes', 'status', 'message', 'trainedAt', 'eligibleCount', 'trainCount', 'testCount', 'maeHours', 'r2', 'baselineMaeHours', 'baselineR2', 'metrics', 'lastScoredAt', 'lastScoredCount'],
  JobPrediction: ['job', 'predictedHours', 'timelimitHours', 'walltimeRisk', 'modelId', 'scoredAt'],
};

function typeOf(name) {
  var t = eval(name);
  if (t == null || typeof t.fetch !== 'function') throw new Error('Type ' + name + ' is not deployed');
  return t;
}

function addedFields() {
  return { since: '2026-11-19T18:36:00Z', types: ADDED };
}

function verify() {
  var missing = [];
  var checked = 0;
  Object.keys(ADDED).forEach(function (name) {
    var T;
    try {
      T = typeOf(name);
    } catch (e) {
      missing.push({ type: name, field: '*', error: String(e.message || e) });
      return;
    }
    ADDED[name].forEach(function (f) {
      checked++;
      try {
        T.fetch({ include: 'id, ' + f, limit: 1 });
      } catch (e) {
        missing.push({ type: name, field: f, error: String(e.message || e).substring(0, 300) });
      }
    });
  });
  log.info('verify: {} fields checked, {} missing', checked, missing.length);
  return { ok: missing.length === 0, checked: checked, missing: missing };
}

function ensure() {
  var results = ENTITIES.map(function (name) {
    try {
      var T = typeOf(name);
      var existed = T.collectionExists();
      var changed = T.upsertCollection(false);
      return { type: name, existed: existed, ddlApplied: !!changed };
    } catch (e) {
      return { type: name, error: String(e.message || e).substring(0, 300) };
    }
  });
  var v = verify();
  log.info('ensure: {} types, verify ok={}', results.length, v.ok);
  return { collections: results, verify: v };
}
