data = {
  name: 'SourceJobTelemetry-CanonicalJobTelemetry',
  source: 'SourceJobTelemetry',
  target: 'CanonicalJobTelemetry',
  transformer: function (srcObj) {
    return [EasyComputeIngest.telemetryToCanonical(srcObj)];
  },
};
