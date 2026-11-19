data = {
  name: 'CanonicalPartitionStatus-IngestRejection',
  source: 'CanonicalPartitionStatus',
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
