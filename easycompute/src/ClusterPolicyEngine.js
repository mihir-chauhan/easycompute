/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('ClusterPolicyEngine');

/** Rule-set version: the latest RCAC policy change encoded (Gautschi-AI QOS change effective 2026-11-02). */
var POLICY_VERSION = 'rcac-2026-11-02';

function list(arr) {
  var out = [];
  if (arr == null) return out;
  for (var i = 0; i < arr.length; i++) out.push(arr[i]);
  return out;
}

function provenance(n) {
  return { component: 'ClusterPolicyEngine', version: POLICY_VERSION, method: 'versioned deterministic rules (' + n + ' active policies + built-in partition/account/memory checks); nothing waives them', status: 'DETERMINISTIC', trainingPeriod: null, sampleSupport: n, historicalOnly: false, computedAt: new Date().toISOString() };
}

/** Evaluates every active rule for a run request; the rule evaluation itself lives in RunRequest.checkRules. */
function check(runRequestId) {
  return RunRequest.make({ id: runRequestId }).checkRules();
}

function info() {
  var byScope = {};
  var bySeverity = {};
  var rules = list(Policy.fetch({ filter: Filter.eq('active', true), include: 'id, scope, severity, kind, title', limit: 1000 }).objs);
  rules.forEach(function (p) {
    byScope[p.scope] = (byScope[p.scope] || 0) + 1;
    bySeverity[p.severity] = (bySeverity[p.severity] || 0) + 1;
  });
  log.info('info: {} active rules', rules.length);
  return {
    policyVersion: POLICY_VERSION,
    rules: rules.length,
    byScope: byScope,
    bySeverity: bySeverity,
    builtins: ['CLUSTER_ONLINE', 'ACCOUNT_ACCESS', 'PARTITION_LIMITS', 'GPU_MEMORY_FIT'],
    provenance: provenance(rules.length),
  };
}
