data = {
  name: 'CanonicalPartitionStatus-ComputeCluster',
  source: 'CanonicalPartitionStatus',
  target: 'ComputeCluster',
  condition: !exists(rejectReason),
  // Status only; DbTargetCollection.Config/ComputeCluster merges, so every other ComputeCluster field is untouched.
  projection: {
    id: cluster,
    status: clusterStatus,
  },
};
