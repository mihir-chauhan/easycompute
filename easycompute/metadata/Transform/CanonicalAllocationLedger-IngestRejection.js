data = {
  name: 'CanonicalAllocationLedger-IngestRejection',
  source: 'CanonicalAllocationLedger',
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
