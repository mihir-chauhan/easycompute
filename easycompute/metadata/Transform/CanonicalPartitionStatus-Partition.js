data = {
  name: 'CanonicalPartitionStatus-Partition',
  source: 'CanonicalPartitionStatus',
  target: 'Partition',
  condition: !exists(rejectReason),
  // Live-state fields only; DbTargetCollection.Config/Partition merges, so every other Partition field is untouched.
  projection: {
    id: partition,
    currentQueueDepth: currentQueueDepth,
    avgWaitHours: avgWaitHours,
    utilizationPct: utilizationPct,
  },
};
