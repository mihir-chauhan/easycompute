data = {
  name: 'CanonicalAllocationLedger-Allocation',
  source: 'CanonicalAllocationLedger',
  target: 'Allocation',
  condition: !exists(rejectReason),
  // Reference fields take the target id as a plain string so a null id leaves the reference null.
  projection: {
    id: allocationKey,
    lab: lab,
    cluster: cluster,
    source: fundingSource,
    grantName: grantName,
    totalUnits: totalUnits,
    usedUnits: usedUnits,
    unitName: unitName,
    startDate: startDate,
    endDate: endDate,
  },
};
