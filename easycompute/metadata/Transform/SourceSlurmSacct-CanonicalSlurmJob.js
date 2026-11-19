data = {
  name: 'SourceSlurmSacct-CanonicalSlurmJob',
  source: 'SourceSlurmSacct',
  target: 'CanonicalSlurmJob',
  transformer: function (srcObj) {
    return [EasyComputeIngest.slurmToCanonical(srcObj)];
  },
};
