data = {
  name: 'CanonicalJobTelemetry-JobMetric',
  source: 'CanonicalJobTelemetry',
  target: 'JobMetric',
  condition: !exists(rejectReason),
  // Reference fields take the target id as a plain string so a null id leaves the reference null.
  projection: {
    id: metricKey,
    job: job,
    ts: ts,
    gpuUtilPct: gpuUtilPct,
    gpuMemPct: gpuMemPct,
    cpuUtilPct: cpuUtilPct,
    memPct: memPct,
    ioReadMBps: ioReadMBps,
    ioWriteMBps: ioWriteMBps,
    powerW: powerW,
    checkpointAgeMin: checkpointAgeMin,
    trainingLoss: trainingLoss,
  },
};
