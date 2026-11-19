data = {
  name: 'SourceAllocationLedger-CanonicalAllocationLedger',
  source: 'SourceAllocationLedger',
  target: 'CanonicalAllocationLedger',
  transformer: function (srcObj) {
    return [EasyComputeIngest.allocationToCanonical(srcObj)];
  },
};
