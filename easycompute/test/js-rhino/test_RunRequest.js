/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/**
 * Tests for the run planner: RunRequest.checkRules, recommendPlans and submit on a self-contained test lab whose only
 * allocation is on a test cluster with a normal and a preemptible H100 partition.
 */
const filename = 'test_RunRequest';

describe(filename, function () {
  var P = 'TEST-RR-' + Date.now() + '-';

  beforeAll(function () {
    this.ctx = TestApi.createContext(filename);
    var future = new Date(Date.now() + 30 * 86400000).toISOString();
    var end = new Date(Date.now() + 200 * 86400000).toISOString();
    TestApi.createEntity(this.ctx, GpuType, GpuType.make({ id: P + 'H100', name: 'Test H100', vendor: 'NVIDIA', memoryGb: 80, fp16Tflops: 989, relativeThroughput: 2.5, costPerGpuHourUsd: 6.88 }));
    TestApi.createEntity(this.ctx, ComputeCluster, ComputeCluster.make({ id: P + 'cl', name: 'Test Cluster', operator: 'RCAC', billing: 'IN_HOUSE_NODE_SHARE', totalNodes: 4, totalGpus: 32, totalCores: 448, storageTb: 10, unitName: 'GPU-hour', usdPerUnit: 2, status: 'ONLINE' }));
    TestApi.createBatchEntity(this.ctx, Partition, [
      Partition.make({ id: P + 'ai', name: 'ai', cluster: { id: P + 'cl' }, gpuType: { id: P + 'H100' }, gpusPerNode: 8, coresPerNode: 112, memPerNodeGb: 1024, maxWalltimeHours: 96, maxNodesPerJob: 2, maxGpusPerJob: 16, maxJobsPerUser: 10, preemptible: false, chargeFactor: 1, currentQueueDepth: 5, avgWaitHours: 2, utilizationPct: 90, nodeCount: 4, qos: 'normal', slurmPartition: 'ai' }),
      Partition.make({ id: P + 'ai-pre', name: 'ai (preemptible)', cluster: { id: P + 'cl' }, gpuType: { id: P + 'H100' }, gpusPerNode: 8, coresPerNode: 112, memPerNodeGb: 1024, maxWalltimeHours: 720, maxNodesPerJob: 2, maxGpusPerJob: 16, maxJobsPerUser: 10, preemptible: true, chargeFactor: 0.25, currentQueueDepth: 2, avgWaitHours: 0.5, utilizationPct: 90, nodeCount: 4, qos: 'preemptible', slurmPartition: 'ai' }),
    ]);
    TestApi.createEntity(this.ctx, Lab, Lab.make({ id: P + 'lab', name: 'Test Lab', piName: 'Dr. Test', piEmail: 'pi@example.edu', department: 'CS', slurmAccounts: 'testlab', fairShareTarget: 0.1, contextDump: 'Test lab.' }));
    TestApi.createEntity(this.ctx, Allocation, Allocation.make({ id: P + 'alloc', name: 'Test bank', lab: { id: P + 'lab' }, cluster: { id: P + 'cl' }, source: 'GRANT', grantName: 'Test grant', totalUnits: 10000, usedUnits: 1000, unitName: 'GPU-hour', startDate: new Date().toISOString(), endDate: end }));
    TestApi.createEntity(this.ctx, Policy, Policy.make({ id: P + 'pol-wall', scope: 'PARTITION', kind: 'MAX_WALLTIME', severity: 'BLOCK', title: 'ai normal 96 h', partition: { id: P + 'ai' }, cluster: { id: P + 'cl' }, limitValue: 96, active: true }));
    TestApi.createBatchEntity(this.ctx, RunRequest, [
      RunRequest.make({ id: P + 'ok', name: 'Fine-tune 8B', description: 'LoRA fine-tune', lab: { id: P + 'lab' }, workloadType: 'FINETUNE', modelParamsB: 8, datasetGb: 20, deadline: future, status: 'DRAFT', createdAt: new Date().toISOString() }),
      RunRequest.make({ id: P + 'long', name: '6-day MD', description: 'GROMACS', lab: { id: P + 'lab' }, workloadType: 'SIMULATION', requestedGpus: 2, requestedWalltimeHours: 144, requestedPartition: { id: P + 'ai' }, status: 'DRAFT', createdAt: new Date().toISOString() }),
    ]);
    TestApi.waitForSetup(this.ctx);
    // rows written by the code under test
    TestApi.addExternalTeardownFilter(this.ctx, Filter.startsWith('id', P).toString(), RuleCheck);
    TestApi.addExternalTeardownFilter(this.ctx, Filter.startsWith('id', P).toString(), RunPlan);
    TestApi.addExternalTeardownFilter(this.ctx, Filter.eq('lab.id', P + 'lab').toString(), Job);
    TestApi.addExternalTeardownFilter(this.ctx, Filter.eq('lab.id', P + 'lab').toString(), ActionLogEntry);
    TestApi.addExternalTeardownFilter(this.ctx, Filter.startsWith('job.id', P + 'cl-').toString(), JobMetric);

    this.checks = RunRequest.make({ id: P + 'ok' }).checkRules();
    this.statusAfterCheck = RunRequest.make({ id: P + 'ok' }).get('status').status;
    this.plans = RunRequest.make({ id: P + 'ok' }).recommendPlans();
    this.longChecks = RunRequest.make({ id: P + 'long' }).checkRules();
  });

  afterAll(function () {
    TestApi.teardown(this.ctx);
  });

  describe('#checkRules', function () {
    it('writes one check per rule and marks the request CHECKED', function () {
      expect(this.checks.length).toBeGreaterThan(0);
      expect(this.statusAfterCheck).toBe('CHECKED');
    });

    it('passes the account/allocation check for the test cluster', function () {
      var account = this.checks.filter(function (c) {
        return c.ruleKind == 'ACCOUNT_ACCESS';
      });
      expect(account.length).toBe(1);
      expect(account[0].outcome).not.toBe('FAIL');
    });

    it('fails MAX_WALLTIME when 144 h is requested on a 96 h partition', function () {
      var wall = this.longChecks.filter(function (c) {
        return c.policy != null && c.policy.id == P + 'pol-wall';
      });
      expect(wall.length).toBe(1);
      expect(wall[0].outcome).toBe('FAIL');
    });
  });

  describe('#recommendPlans', function () {
    it('returns up to three ranked plans only on clusters the lab has an allocation on', function () {
      expect(this.plans.length).toBeGreaterThan(0);
      expect(this.plans.length).toBeLessThan(4);
      this.plans.forEach(function (p, i) {
        expect(p.rank).toBe(i + 1);
        expect(p.cluster.id).toBe(P + 'cl');
      });
      expect(RunRequest.make({ id: P + 'ok' }).get('status').status).toBe('PLANNED');
    });

    it('prices the preemptible option at a quarter of the normal charge per GPU-hour', function () {
      var pre = this.plans.filter(function (p) {
        return p.partition.id == P + 'ai-pre';
      })[0];
      if (pre) expect(pre.costPerGpuHourUsd).toBeCloseTo(0.5, 3);
    });

    it('generates an sbatch script with account, partition, QOS and time', function () {
      var s = this.plans[0].sbatchScript;
      expect(s).toContain('#SBATCH --account=testlab');
      expect(s).toContain('#SBATCH --partition=ai');
      expect(s).toContain('#SBATCH --qos=');
      expect(s).toContain('#SBATCH --time=');
    });
  });

  describe('#submit', function () {
    beforeAll(function () {
      this.job = RunRequest.make({ id: P + 'ok' }).submit(this.plans[0].id);
    });

    it('creates a live job on the chosen partition and marks the request SUBMITTED', function () {
      expect(this.job.isLive).toBe(true);
      expect(this.job.partition.id).toBe(this.plans[0].partition.id);
      var req = RunRequest.make({ id: P + 'ok' }).get('status, chosenPlan');
      expect(req.status).toBe('SUBMITTED');
      expect(req.chosenPlan.id).toBe(this.plans[0].id);
    });

    it('logs a SUBMIT action', function () {
      expect(ActionLogEntry.fetchCount({ filter: Filter.eq('job.id', this.job.id).and().eq('actionType', 'SUBMIT') })).toBe(1);
    });

    it('rejects a second submission', function () {
      var self = this;
      expect(function () {
        RunRequest.make({ id: P + 'ok' }).submit(self.plans[0].id);
      }).toThrow();
    });
  });
});
