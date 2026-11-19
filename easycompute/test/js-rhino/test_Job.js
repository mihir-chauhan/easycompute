/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/**
 * Tests for live-run monitoring: Job.evaluateHealth (idle GPU, OOM risk, auto-resolve), Job.applyAction (checkpoint,
 * user vs admin walltime extension, cancel) on self-contained test jobs.
 * (RunMonitor.tick is not tested here: it advances every live job, including the demo seed; see
 * tools/backend-harness.)
 */
const filename = 'test_Job';

describe(filename, function () {
  var P = 'TEST-JOB-' + Date.now() + '-';

  function samples(jobId, n, f) {
    var out = [];
    var start = Date.now() - n * 5 * 60000;
    for (var i = 0; i < n; i++) {
      var m = f(i);
      m.id = jobId + '-m' + i;
      m.job = { id: jobId };
      m.ts = new Date(start + i * 5 * 60000).toISOString();
      out.push(JobMetric.make(m));
    }
    return out;
  }

  function withFields(base, extra) {
    var out = {};
    [base, extra].forEach(function (o) {
      Object.keys(o).forEach(function (k) {
        out[k] = o[k];
      });
    });
    return out;
  }

  beforeAll(function () {
    this.ctx = TestApi.createContext(filename);
    TestApi.createEntity(this.ctx, ComputeCluster, ComputeCluster.make({ id: P + 'cl', name: 'Test Cluster', operator: 'RCAC', billing: 'IN_HOUSE_NODE_SHARE', totalGpus: 16, unitName: 'GPU-hour', usdPerUnit: 1, status: 'ONLINE' }));
    TestApi.createEntity(this.ctx, Partition, Partition.make({ id: P + 'gpu', name: 'gpu', cluster: { id: P + 'cl' }, gpusPerNode: 4, coresPerNode: 64, memPerNodeGb: 512, maxWalltimeHours: 48, maxNodesPerJob: 2, maxGpusPerJob: 8, maxJobsPerUser: 10, preemptible: false, chargeFactor: 1, avgWaitHours: 0.1, utilizationPct: 50 }));
    TestApi.createEntity(this.ctx, Lab, Lab.make({ id: P + 'lab', name: 'Test Lab', piName: 'Dr. Test', piEmail: 'pi@example.edu' }));
    TestApi.createEntity(this.ctx, AutopilotPolicy, AutopilotPolicy.make({ id: P + 'lab', lab: { id: P + 'lab' }, enabled: true, cancelIdleAfterMin: 60, checkpointBeforeTimeoutMin: 15, autoExtendWalltime: false, requeueToStandbyOnLowPriority: false, notifyPiOnCritical: false, budgetAlertPct: 0.9 }));
    var base = { lab: { id: P + 'lab' }, cluster: { id: P + 'cl' }, partition: { id: P + 'gpu' }, user: 'user_test', workloadType: 'TRAINING', state: 'RUNNING', timelimitHours: 24, elapsedHours: 4, allocGpus: 4, allocNodes: 1, allocCpus: 64, isLive: true };
    var idle = withFields(base, { id: P + 'cl-idle', slurmJobId: '1', jobName: 'idle' });
    var oom = withFields(base, { id: P + 'cl-oom', slurmJobId: '2', jobName: 'oom' });
    TestApi.createBatchEntity(this.ctx, Job, [Job.make(idle), Job.make(oom)]);
    TestApi.createBatchEntity(
      this.ctx,
      JobMetric,
      samples(P + 'cl-idle', 18, function (i) {
        return { gpuUtilPct: 0.5, gpuMemPct: 20, cpuUtilPct: 40, memPct: 30, ioReadMBps: 50, ioWriteMBps: 1, powerW: 240, checkpointAgeMin: 10 + i * 5 };
      }).concat(
        samples(P + 'cl-oom', 6, function (i) {
          return { gpuUtilPct: 85, gpuMemPct: 88 + i * 2, cpuUtilPct: 60, memPct: 50, ioReadMBps: 300, ioWriteMBps: 2, powerW: 1500, checkpointAgeMin: 5 + i * 5 };
        })
      )
    );
    TestApi.waitForSetup(this.ctx);
    TestApi.addExternalTeardownFilter(this.ctx, Filter.eq('lab.id', P + 'lab').toString(), JobAlert);
    TestApi.addExternalTeardownFilter(this.ctx, Filter.eq('lab.id', P + 'lab').toString(), ActionLogEntry);
    TestApi.addExternalTeardownFilter(this.ctx, Filter.startsWith('job.id', P).toString(), JobMetric);
  });

  afterAll(function () {
    TestApi.teardown(this.ctx);
  });

  describe('#evaluateHealth', function () {
    it('raises a CRITICAL IDLE_GPU alert after 90 idle minutes (limit 60)', function () {
      var alerts = Job.make({ id: P + 'cl-idle' }).evaluateHealth();
      var idle = alerts.filter(function (a) {
        return a.alertType == 'IDLE_GPU';
      });
      expect(idle.length).toBe(1);
      expect(idle[0].severity).toBe('CRITICAL');
      expect(idle[0].recommendedAction).toBe('CANCEL');
    });

    it('raises a CRITICAL OOM_RISK alert when GPU memory reaches 98% and rising', function () {
      var alerts = Job.make({ id: P + 'cl-oom' }).evaluateHealth();
      var oom = alerts.filter(function (a) {
        return a.alertType == 'OOM_RISK';
      });
      expect(oom.length).toBe(1);
      expect(oom[0].severity).toBe('CRITICAL');
    });

    it('keeps one active alert per type when evaluated again', function () {
      Job.make({ id: P + 'cl-oom' }).evaluateHealth();
      expect(JobAlert.fetchCount({ filter: Filter.eq('job.id', P + 'cl-oom').and().eq('alertType', 'OOM_RISK').and().intersects('status', ['OPEN', 'ACKED']) })).toBe(1);
    });
  });

  describe('#applyAction', function () {
    it('CHECKPOINT_NOW resets the checkpoint age and resolves OOM_RISK', function () {
      var entry = Job.make({ id: P + 'cl-oom' }).applyAction('CHECKPOINT_NOW', 'USER');
      expect(entry.outcome).toBe('DONE');
      var last = JobMetric.fetch({ filter: Filter.eq('job.id', P + 'cl-oom'), order: 'descending(ts)', limit: 1 }).objs[0];
      expect(last.checkpointAgeMin).toBe(0);
      expect(JobAlert.fetchCount({ filter: Filter.eq('job.id', P + 'cl-oom').and().eq('alertType', 'OOM_RISK').and().eq('status', 'OPEN') })).toBe(0);
    });

    it('records a user walltime extension as PENDING_APPROVAL and applies an admin one', function () {
      expect(Job.make({ id: P + 'cl-oom' }).applyAction('EXTEND_WALLTIME', 'USER').outcome).toBe('PENDING_APPROVAL');
      expect(Job.make({ id: P + 'cl-oom' }).applyAction('EXTEND_WALLTIME', 'ADMIN').outcome).toBe('DONE');
      expect(Job.make({ id: P + 'cl-oom' }).get('timelimitHours').timelimitHours).toBe(30);
    });

    it('rejects an unknown action', function () {
      expect(function () {
        Job.make({ id: P + 'cl-oom' }).applyAction('REBOOT', 'USER');
      }).toThrow();
    });
  });
});
