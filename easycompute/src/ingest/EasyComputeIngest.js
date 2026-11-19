/*
 * Parsing and validation for the EasyCompute file feeds (see EasyComputeIngest.c3typ).
 * Bad data never throws: every problem is appended to `rejectReason`.
 */

var SLURM_FEED = 'SlurmSacctFeed';
var TELEMETRY_FEED = 'JobTelemetryFeed';
var ALLOCATION_FEED = 'AllocationLedgerFeed';
var CLUSTER_STATUS_FEED = 'ClusterStatusFeed';
var REF_TTL_MS = 60 * 1000;

var SLURM_COLUMNS = [
  ['JobID', 'jobIdRaw'],
  ['Cluster', 'clusterRaw'],
  ['Partition', 'partitionRaw'],
  ['QOS', 'qosRaw'],
  ['Account', 'accountRaw'],
  ['User', 'userRaw'],
  ['JobName', 'jobNameRaw'],
  ['State', 'stateRaw'],
  ['ExitCode', 'exitCodeRaw'],
  ['Submit', 'submitRaw'],
  ['Start', 'startRaw'],
  ['End', 'endRaw'],
  ['TimelimitHours', 'timelimitHoursRaw'],
  ['ElapsedHours', 'elapsedHoursRaw'],
  ['AllocCPUS', 'allocCpusRaw'],
  ['NNodes', 'nNodesRaw'],
  ['AllocTRES', 'allocTresRaw'],
  ['ReqMemGB', 'reqMemGbRaw'],
  ['MaxRSSGB', 'maxRssGbRaw'],
  ['NodeList', 'nodeListRaw'],
  ['WCKey', 'wcKeyRaw'],
  ['AdminComment', 'adminCommentRaw'],
];

var TELEMETRY_COLUMNS = [
  ['timestamp', 'sampleTimestampRaw'],
  ['cluster', 'clusterRaw'],
  ['jobid', 'jobIdRaw'],
  ['seq', 'seqRaw'],
  ['hostname', 'hostnameRaw'],
  ['DCGM_FI_DEV_GPU_UTIL', 'gpuUtilRaw'],
  ['DCGM_FI_DEV_FB_USED_PCT', 'fbUsedPctRaw'],
  ['DCGM_FI_DEV_POWER_USAGE', 'powerUsageRaw'],
  ['node_cpu_util_pct', 'cpuUtilPctRaw'],
  ['node_mem_used_pct', 'memUsedPctRaw'],
  ['node_disk_read_mbps', 'diskReadMbpsRaw'],
  ['node_disk_write_mbps', 'diskWriteMbpsRaw'],
  ['ckpt_age_min', 'ckptAgeMinRaw'],
  ['train_loss', 'trainLossRaw'],
];

var ALLOCATION_COLUMNS = [
  ['allocation_id', 'allocationIdRaw'],
  ['lab_id', 'labIdRaw'],
  ['resource', 'resourceRaw'],
  ['funding_source', 'fundingSourceRaw'],
  ['grant_name', 'grantNameRaw'],
  ['award_units', 'awardUnitsRaw'],
  ['used_units', 'usedUnitsRaw'],
  ['unit', 'unitRaw'],
  ['start_date', 'startDateRaw'],
  ['end_date', 'endDateRaw'],
];

var PARTITION_STATUS_COLUMNS = [
  ['snapshot_time', 'snapshotTimeRaw'],
  ['cluster', 'clusterRaw'],
  ['cluster_state', 'clusterStateRaw'],
  ['partition', 'partitionRaw'],
  ['qos', 'qosRaw'],
  ['pending_jobs', 'pendingJobsRaw'],
  ['avg_wait_hours', 'avgWaitHoursRaw'],
  ['util_pct', 'utilPctRaw'],
];

var NUMBER_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
var SLURM_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
var ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

var refCache = null;

/** Reference lookups (clusters, partitions, labs by account, GPU types, enum values), memoized for REF_TTL_MS. */
function refs() {
  var now = new Date().getTime();
  if (refCache && now - refCache.loadedAt < REF_TTL_MS) {
    return refCache;
  }
  var r = {
    loadedAt: now,
    clusters: {},
    partitions: {},
    labByAccount: {},
    labs: {},
    fundings: {},
    clusterStates: {},
    gpuTypes: {},
    states: {},
    workloads: {},
    jobs: {},
  };
  ComputeCluster.fetchObjStream({ include: 'id' }).each(function (c) {
    r.clusters[c.id] = true;
  });
  Partition.fetchObjStream({ include: 'id, cluster, slurmPartition, qos' }).each(function (p) {
    r.partitions[(p.cluster && p.cluster.id) + '|' + p.slurmPartition + '|' + p.qos] = p.id;
  });
  Lab.fetchObjStream({ include: 'id, slurmAccounts' }).each(function (l) {
    r.labs[l.id] = true;
    String(l.slurmAccounts || '')
      .split(',')
      .forEach(function (a) {
        a = a.trim();
        if (a && !r.labByAccount[a]) {
          r.labByAccount[a] = l.id;
        }
      });
  });
  GpuType.fetchObjStream({ include: 'id' }).each(function (g) {
    r.gpuTypes[g.id] = true;
  });
  Job.State.values().forEach(function (v) {
    r.states[String(v)] = true;
  });
  WorkloadType.values().forEach(function (v) {
    r.workloads[String(v)] = true;
  });
  Allocation.Funding.values().forEach(function (v) {
    r.fundings[String(v)] = true;
  });
  ComputeCluster.Status.values().forEach(function (v) {
    r.clusterStates[String(v)] = true;
  });
  refCache = r;
  return r;
}

/** True when a Job with this id exists (memoized hits; misses re-checked against the database). */
function jobExists(r, jobId) {
  if (r.jobs[jobId]) {
    return true;
  }
  var found = Job.fetchCount({ filter: Filter.eq('id', jobId) }) > 0;
  if (found) {
    r.jobs[jobId] = true;
  }
  return found;
}

function text(v) {
  if (v == null) {
    return null;
  }
  var s = String(v).trim();
  return s === '' ? null : s;
}

/** Deterministic 53-bit string hash (cyrb53) rendered base 36. */
function hash(str) {
  var h1 = 0xdeadbeef;
  var h2 = 0x41c6ce57;
  for (var i = 0; i < str.length; i++) {
    var ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function fileName(src) {
  var url = text(src.sourceFileUrl) || text(src.sourceFileEncodedPath) || text(src.sourcesId);
  if (!url) {
    return null;
  }
  var parts = url.split('/');
  return decodeURIComponent(parts[parts.length - 1]);
}

function rawJson(src, columns) {
  var o = {};
  columns.forEach(function (c) {
    var v = src[c[1]];
    o[c[0]] = v == null ? '' : String(v);
  });
  return JSON.stringify(o);
}

/** Collects validation errors and parses values. */
function Checker() {
  this.errors = [];
}

Checker.prototype.fail = function (msg) {
  if (this.errors.indexOf(msg) < 0) {
    this.errors.push(msg);
  }
};

/** Parses an optional number; records an error and returns null when unparseable. */
Checker.prototype.num = function (label, raw) {
  var s = text(raw);
  if (s == null) {
    return null;
  }
  if (!NUMBER_RE.test(s)) {
    this.fail('unparseable number ' + label + "='" + s + "'");
    return null;
  }
  return parseFloat(s);
};

Checker.prototype.int = function (label, raw) {
  var n = this.num(label, raw);
  if (n != null && Math.floor(n) !== n) {
    this.fail('unparseable integer ' + label + "='" + String(raw).trim() + "'");
    return null;
  }
  return n;
};

Checker.prototype.nonNegative = function (label, n) {
  if (n != null && n < 0) {
    this.fail('negative ' + label + '=' + n);
  }
};

Checker.prototype.range = function (label, n, lo, hi) {
  if (n != null && (n < lo || n > hi)) {
    this.fail(label + '=' + n + ' outside ' + lo + '-' + hi);
  }
};

function validCalendar(y, mo, d, h, mi, s) {
  var t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === s
  );
}

/** Slurm timestamp, UTC without zone; "Unknown"/empty = null. Returns { iso, ms } or null. */
Checker.prototype.slurmDate = function (label, raw) {
  var s = text(raw);
  if (s == null || s === 'Unknown' || s === 'None') {
    return null;
  }
  var m = SLURM_DATE_RE.exec(s);
  if (!m || !validCalendar(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6])) {
    this.fail('unparseable date ' + label + "='" + s + "'");
    return null;
  }
  return { iso: s + 'Z', ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) };
};

/** ISO-8601 timestamp with zone. Returns { iso, ms } or null. */
Checker.prototype.isoDate = function (label, raw) {
  var s = text(raw);
  if (s == null) {
    return null;
  }
  var m = ISO_UTC_RE.exec(s);
  if (!m || !validCalendar(+m[1], +m[2], +m[3], +m[4], +m[5], m[7] ? +m[7] : 0) || isNaN(Date.parse(s))) {
    this.fail('unparseable date ' + label + "='" + s + "'");
    return null;
  }
  return { iso: s, ms: Date.parse(s) };
};

Checker.prototype.reason = function () {
  return this.errors.length ? this.errors.join('; ') : null;
};

function parseKeyValues(s) {
  var out = {};
  String(s || '')
    .split(';')
    .forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) {
        out[kv.substring(0, i).trim()] = kv.substring(i + 1).trim();
      }
    });
  return out;
}

function slurmToCanonical(src) {
  var r = refs();
  var c = new Checker();
  var feed = SLURM_FEED;
  var file = fileName(src);
  var rawRow = rawJson(src, SLURM_COLUMNS);

  var jobId = text(src.jobIdRaw);
  var cluster = text(src.clusterRaw);
  if (jobId == null) {
    c.fail('missing key JobID');
  }
  if (cluster == null) {
    c.fail('missing key Cluster');
  } else if (!r.clusters[cluster]) {
    c.fail("unknown cluster '" + cluster + "'");
  }
  var jobKey = jobId != null && cluster != null ? cluster + '-' + jobId : null;
  var rowKey = jobKey || (cluster || '?') + '-' + (jobId || '?') + ' (' + (text(src.jobNameRaw) || 'no JobName') + ')';

  // Partition: exact partition + QOS, else the partition's QOS 'normal' row.
  var slurmPartition = text(src.partitionRaw);
  var qos = text(src.qosRaw);
  var partition = null;
  if (cluster != null && r.clusters[cluster]) {
    if (slurmPartition == null) {
      c.fail('missing Partition');
    } else {
      partition =
        r.partitions[cluster + '|' + slurmPartition + '|' + qos] ||
        r.partitions[cluster + '|' + slurmPartition + '|normal'] ||
        null;
      if (partition == null) {
        c.fail("unknown partition '" + slurmPartition + "' (QOS '" + qos + "') on cluster '" + cluster + "'");
      }
    }
  }

  // Lab from the account with a trailing -gpu / -aws stripped.
  var account = text(src.accountRaw);
  var lab = null;
  if (account == null) {
    c.fail('missing Account');
  } else {
    var base = account.replace(/-(gpu|aws)$/, '');
    lab = r.labByAccount[base] || null;
    if (lab == null) {
      c.fail("unknown lab for account '" + account + "'");
    }
  }

  // State: first word ("CANCELLED by 0" -> CANCELLED).
  var stateText = text(src.stateRaw);
  var state = stateText == null ? null : stateText.split(/\s+/)[0].toUpperCase();
  if (state == null) {
    c.fail('missing State');
  } else if (!r.states[state]) {
    c.fail("state '" + stateText + "' not in Job.State");
  }

  // Times.
  if (text(src.submitRaw) == null) {
    c.fail('missing timestamp Submit');
  }
  var submit = c.slurmDate('Submit', src.submitRaw);
  var start = c.slurmDate('Start', src.startRaw);
  var end = c.slurmDate('End', src.endRaw);
  if (start && end && end.ms < start.ms) {
    c.fail('End ' + end.iso + ' before Start ' + start.iso);
  }

  // Numbers.
  var timelimitHours = c.num('TimelimitHours', src.timelimitHoursRaw);
  var elapsedHours = c.num('ElapsedHours', src.elapsedHoursRaw);
  c.nonNegative('TimelimitHours', timelimitHours);
  c.nonNegative('ElapsedHours', elapsedHours);
  var allocCpus = c.int('AllocCPUS', src.allocCpusRaw);
  var allocNodes = c.int('NNodes', src.nNodesRaw);
  var reqMemGb = c.num('ReqMemGB', src.reqMemGbRaw);
  var maxRssGb = c.num('MaxRSSGB', src.maxRssGbRaw);

  // AllocTRES: gres/gpu=N and gres/gpu:<type>=N.
  var allocGpus = 0;
  var gpuType = null;
  String(src.allocTresRaw || '')
    .split(',')
    .forEach(function (part) {
      var i = part.indexOf('=');
      var k = (i > 0 ? part.substring(0, i) : part).trim();
      var v = i > 0 ? part.substring(i + 1).trim() : '';
      if (k === 'gres/gpu') {
        var n = c.int('AllocTRES gres/gpu', v);
        allocGpus = n == null ? 0 : n;
      } else if (k.indexOf('gres/gpu:') === 0) {
        gpuType = k.substring('gres/gpu:'.length).toUpperCase();
      }
    });
  if (gpuType != null && !r.gpuTypes[gpuType]) {
    c.fail("unknown GPU type '" + gpuType + "'");
    gpuType = null;
  }

  // AdminComment key=value;...
  var ac = parseKeyValues(src.adminCommentRaw);
  var workloadType = text(ac.workload);
  if (workloadType != null && !r.workloads[workloadType]) {
    c.fail("workload '" + workloadType + "' not in WorkloadType");
  }
  var gpuUtilAvg = c.num('gpu_util', ac.gpu_util);
  c.range('gpu_util', gpuUtilAvg, 0, 100);
  var cpuEfficiency = c.num('cpu_eff', ac.cpu_eff);
  c.range('cpu_eff', cpuEfficiency, 0, 1);
  var memEfficiency = c.num('mem_eff', ac.mem_eff);
  c.range('mem_eff', memEfficiency, 0, 1);
  var costUnits = c.num('cost_units', ac.cost_units);
  var costUsd = c.num('cost_usd', ac.cost_usd);

  var reason = c.reason();
  return CanonicalSlurmJob.make({
    jobKey: jobKey,
    slurmJobId: jobId,
    cluster: cluster,
    partition: partition,
    lab: lab,
    account: account,
    qos: qos,
    user: text(src.userRaw),
    jobName: text(src.jobNameRaw),
    state: state,
    submitTime: submit && submit.iso,
    startTime: start && start.iso,
    endTime: end && end.iso,
    timelimitHours: timelimitHours,
    elapsedHours: elapsedHours,
    allocCpus: allocCpus,
    allocNodes: allocNodes,
    allocGpus: allocGpus,
    gpuType: gpuType,
    reqMemGb: reqMemGb,
    maxRssGb: maxRssGb,
    project: text(src.wcKeyRaw),
    workloadType: workloadType,
    gpuUtilAvg: gpuUtilAvg,
    cpuEfficiency: cpuEfficiency,
    memEfficiency: memEfficiency,
    costUnits: costUnits,
    costUsd: costUsd,
    runRequest: text(ac.run_request),
    exitCode: text(src.exitCodeRaw),
    nodeList: text(src.nodeListRaw),
    isLive: state === 'RUNNING' || state === 'PENDING',
    feed: feed,
    sourceFile: file,
    rowKey: rowKey,
    rejectionId: reason ? 'rej-' + feed + '-' + hash((file || '') + '|' + rawRow) : null,
    rejectReason: reason,
    rawRow: rawRow,
  });
}

function telemetryToCanonical(src) {
  var r = refs();
  var c = new Checker();
  var feed = TELEMETRY_FEED;
  var file = fileName(src);
  var rawRow = rawJson(src, TELEMETRY_COLUMNS);

  var cluster = text(src.clusterRaw);
  var jobId = text(src.jobIdRaw);
  if (cluster == null) {
    c.fail('missing key cluster');
  }
  if (jobId == null) {
    c.fail('missing key jobid');
  }
  var seq = null;
  if (text(src.seqRaw) == null) {
    c.fail('missing key seq');
  } else {
    seq = c.int('seq', src.seqRaw);
    c.nonNegative('seq', seq);
  }
  var job = cluster != null && jobId != null ? cluster + '-' + jobId : null;
  var seqText = seq == null ? null : (seq < 10 ? '0' : '') + seq;
  var metricKey = job != null && seqText != null ? 'jm-' + job + '-' + seqText : null;
  var rowKey = metricKey || 'jm-' + (cluster || '?') + '-' + (jobId || '?') + '-' + (text(src.seqRaw) || '?');

  if (cluster != null && !r.clusters[cluster]) {
    c.fail("unknown cluster '" + cluster + "'");
  } else if (job != null && !jobExists(r, job)) {
    c.fail("unknown job '" + job + "'");
  }

  if (text(src.sampleTimestampRaw) == null) {
    c.fail('missing timestamp');
  }
  var ts = c.isoDate('timestamp', src.sampleTimestampRaw);

  var gpuUtilPct = c.num('DCGM_FI_DEV_GPU_UTIL', src.gpuUtilRaw);
  var gpuMemPct = c.num('DCGM_FI_DEV_FB_USED_PCT', src.fbUsedPctRaw);
  var cpuUtilPct = c.num('node_cpu_util_pct', src.cpuUtilPctRaw);
  var memPct = c.num('node_mem_used_pct', src.memUsedPctRaw);
  c.range('DCGM_FI_DEV_GPU_UTIL', gpuUtilPct, 0, 100);
  c.range('DCGM_FI_DEV_FB_USED_PCT', gpuMemPct, 0, 100);
  c.range('node_cpu_util_pct', cpuUtilPct, 0, 100);
  c.range('node_mem_used_pct', memPct, 0, 100);
  var powerW = c.num('DCGM_FI_DEV_POWER_USAGE', src.powerUsageRaw);
  c.nonNegative('DCGM_FI_DEV_POWER_USAGE', powerW);
  var ioReadMBps = c.num('node_disk_read_mbps', src.diskReadMbpsRaw);
  var ioWriteMBps = c.num('node_disk_write_mbps', src.diskWriteMbpsRaw);
  var checkpointAgeMin = c.num('ckpt_age_min', src.ckptAgeMinRaw);
  var trainingLoss = c.num('train_loss', src.trainLossRaw);

  var reason = c.reason();
  return CanonicalJobTelemetry.make({
    metricKey: metricKey,
    job: job,
    ts: ts && ts.iso,
    gpuUtilPct: gpuUtilPct,
    gpuMemPct: gpuMemPct,
    cpuUtilPct: cpuUtilPct,
    memPct: memPct,
    ioReadMBps: ioReadMBps,
    ioWriteMBps: ioWriteMBps,
    powerW: powerW,
    checkpointAgeMin: checkpointAgeMin,
    trainingLoss: trainingLoss,
    feed: feed,
    sourceFile: file,
    rowKey: rowKey,
    rejectionId: reason ? 'rej-' + feed + '-' + hash((file || '') + '|' + rawRow) : null,
    rejectReason: reason,
    rawRow: rawRow,
  });
}

function allocationToCanonical(src) {
  var r = refs();
  var c = new Checker();
  var feed = ALLOCATION_FEED;
  var file = fileName(src);
  var rawRow = rawJson(src, ALLOCATION_COLUMNS);

  var id = text(src.allocationIdRaw);
  if (id == null) {
    c.fail('missing key allocation_id');
  }
  var rowKey = id || '? (' + (text(src.labIdRaw) || '?') + '/' + (text(src.resourceRaw) || '?') + ')';

  var lab = text(src.labIdRaw);
  if (lab == null) {
    c.fail('missing lab_id');
  } else if (!r.labs[lab]) {
    c.fail("unknown lab '" + lab + "'");
  }
  var cluster = text(src.resourceRaw);
  if (cluster == null) {
    c.fail('missing resource');
  } else if (!r.clusters[cluster]) {
    c.fail("unknown cluster '" + cluster + "'");
  }
  var funding = text(src.fundingSourceRaw);
  if (funding != null && !r.fundings[funding]) {
    c.fail("funding_source '" + funding + "' not in Allocation.Funding");
  }

  var totalUnits = c.num('award_units', src.awardUnitsRaw);
  c.nonNegative('award_units', totalUnits);
  var usedUnits = c.num('used_units', src.usedUnitsRaw);
  c.nonNegative('used_units', usedUnits);

  var start = c.isoDate('start_date', src.startDateRaw);
  var end = c.isoDate('end_date', src.endDateRaw);
  if (start && end && end.ms < start.ms) {
    c.fail('end_date ' + end.iso + ' before start_date ' + start.iso);
  }

  var reason = c.reason();
  return CanonicalAllocationLedger.make({
    allocationKey: id,
    lab: lab,
    cluster: cluster,
    fundingSource: funding,
    grantName: text(src.grantNameRaw),
    totalUnits: totalUnits,
    usedUnits: usedUnits,
    unitName: text(src.unitRaw),
    startDate: start && start.iso,
    endDate: end && end.iso,
    feed: feed,
    sourceFile: file,
    rowKey: rowKey,
    rejectionId: reason ? 'rej-' + feed + '-' + hash((file || '') + '|' + rawRow) : null,
    rejectReason: reason,
    rawRow: rawRow,
  });
}

function partitionStatusToCanonical(src) {
  var r = refs();
  var c = new Checker();
  var feed = CLUSTER_STATUS_FEED;
  var file = fileName(src);
  var rawRow = rawJson(src, PARTITION_STATUS_COLUMNS);

  var cluster = text(src.clusterRaw);
  var slurmPartition = text(src.partitionRaw);
  var qos = text(src.qosRaw);
  var rowKey = (cluster || '?') + '/' + (slurmPartition || '?') + '/' + (qos || '?');

  if (cluster == null) {
    c.fail('missing key cluster');
  } else if (!r.clusters[cluster]) {
    c.fail("unknown cluster '" + cluster + "'");
  }
  var partition = null;
  if (slurmPartition == null) {
    c.fail('missing key partition');
  } else if (cluster != null && r.clusters[cluster]) {
    partition =
      r.partitions[cluster + '|' + slurmPartition + '|' + qos] ||
      r.partitions[cluster + '|' + slurmPartition + '|normal'] ||
      null;
    if (partition == null) {
      c.fail("unknown partition '" + slurmPartition + "' (QOS '" + qos + "') on cluster '" + cluster + "'");
    }
  }

  var stateText = text(src.clusterStateRaw);
  var clusterStatus = stateText == null ? null : stateText.toUpperCase();
  if (clusterStatus == null) {
    c.fail('missing cluster_state');
  } else if (!r.clusterStates[clusterStatus]) {
    c.fail("cluster_state '" + stateText + "' not in ComputeCluster.Status");
  }

  if (text(src.snapshotTimeRaw) == null) {
    c.fail('missing timestamp snapshot_time');
  }
  var snapshot = c.isoDate('snapshot_time', src.snapshotTimeRaw);

  var pending = c.int('pending_jobs', src.pendingJobsRaw);
  c.nonNegative('pending_jobs', pending);
  var avgWait = c.num('avg_wait_hours', src.avgWaitHoursRaw);
  c.nonNegative('avg_wait_hours', avgWait);
  var util = c.num('util_pct', src.utilPctRaw);
  c.range('util_pct', util, 0, 100);

  var reason = c.reason();
  return CanonicalPartitionStatus.make({
    snapshotTime: snapshot && snapshot.iso,
    cluster: cluster,
    clusterStatus: clusterStatus,
    partition: partition,
    currentQueueDepth: pending,
    avgWaitHours: avgWait,
    utilizationPct: util,
    feed: feed,
    sourceFile: file,
    rowKey: rowKey,
    rejectionId: reason ? 'rej-' + feed + '-' + hash((file || '') + '|' + rawRow) : null,
    rejectReason: reason,
    rawRow: rawRow,
  });
}
