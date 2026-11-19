data = {
  name: 'SourcePartitionStatus-CanonicalPartitionStatus',
  source: 'SourcePartitionStatus',
  target: 'CanonicalPartitionStatus',
  transformer: function (srcObj) {
    return [EasyComputeIngest.partitionStatusToCanonical(srcObj)];
  },
};
