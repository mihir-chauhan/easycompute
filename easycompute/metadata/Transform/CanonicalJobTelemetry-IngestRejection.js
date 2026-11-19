data = {
  name: 'CanonicalJobTelemetry-IngestRejection',
  source: 'CanonicalJobTelemetry',
  target: 'IngestRejection',
  condition: exists(rejectReason),
  projection: {
    id: rejectionId,
    feed: feed,
    sourceFile: sourceFile,
    rowKey: rowKey,
    reason: rejectReason,
    rawRow: rawRow,
  },
};
