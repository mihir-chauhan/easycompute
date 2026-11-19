/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/**
 * Tests for Insights: predictDuration scaling, and labSummary / universityOverview counting records created here.
 */
const filename = 'test_Insights';

describe(filename, function () {
  var P = 'TEST-INS-' + Date.now() + '-';

  beforeAll(function () {
    this.ctx = TestApi.createContext(filename);
    TestApi.createEntity(this.ctx, Lab, Lab.make({ id: P + 'lab', name: 'Test Lab', fairShareTarget: 0.05 }));
    TestApi.createEntity(this.ctx, ComputeCluster, ComputeCluster.make({ id: P + 'cl', name: 'Test Cluster', billing: 'THIRD_PARTY_HOURLY', unitName: 'USD', usdPerUnit: 1, status: 'ONLINE', totalGpus: 8 }));
    this.before = Insights.universityOverview();
    var job = function (i, util) {
      return Job.make({ id: P + 'cl-' + i, slurmJobId: String(i), lab: { id: P + 'lab' }, cluster: { id: P + 'cl' }, user: 'user_t', workloadType: 'TRAINING', state: 'COMPLETED', submitTime: new Date(Date.now() - 2 * 86400000).toISOString(), elapsedHours: 2, timelimitHours: 4, allocGpus: 2, gpuUtilAvg: util, costUnits: 10, costUsd: 10, isLive: false });
    };
    TestApi.createBatchEntity(this.ctx, Job, [job(1, 50), job(2, 100), job(3, null)]);
    TestApi.waitForSetup(this.ctx);
    this.after = Insights.universityOverview();
    this.lab = Insights.labSummary(P + 'lab');
  });

  afterAll(function () {
    TestApi.teardown(this.ctx);
  });

  describe('#predictDuration', function () {
    it('is faster on H100 than on A100 for the same work, and sublinear in GPUs', function () {
      var a = Insights.predictDuration('TRAINING', 'A100-40GB', 1, 1);
      var h = Insights.predictDuration('TRAINING', 'H100-80GB', 1, 1);
      var h8 = Insights.predictDuration('TRAINING', 'H100-80GB', 8, 1);
      expect(h.estDurationHours).toBeLessThan(a.estDurationHours);
      expect(h8.estDurationHours).toBeLessThan(h.estDurationHours);
      expect(h8.estDurationHours).toBeGreaterThan(h.estDurationHours / 8);
    });

    it('needs more than one 40 GB GPU for full training of a 7B model', function () {
      expect(Insights.predictDuration('TRAINING', 'A100-40GB', 1, 7).fits).toBe(false);
    });
  });

  describe('#labSummary', function () {
    it('counts GPU-hours and idle GPU-hours of the lab jobs', function () {
      expect(this.lab.kpis.jobs).toBe(3);
      expect(this.lab.kpis.gpuHours).toBeCloseTo(12, 3);
      expect(this.lab.kpis.wastedGpuHours).toBeCloseTo(2, 3); // 4 GPU-h x 50% idle; no util -> 0
    });
  });

  describe('#universityOverview', function () {
    it('adds the new jobs to third-party cost and total GPU-hours', function () {
      var cost = function (o) {
        return o.costByBilling.filter(function (b) {
          return b.billing == 'THIRD_PARTY_HOURLY';
        })[0].costUsd;
      };
      expect(cost(this.after) - cost(this.before)).toBeCloseTo(30, 2);
      expect(this.after.kpis.totalGpuHours - this.before.kpis.totalGpuHours).toBeCloseTo(12, 1);
    });
  });
});
