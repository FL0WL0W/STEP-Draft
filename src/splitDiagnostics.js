export function createSplitDiagnostics() {
  return {
    apexConeFaceDivide: [],
    coneBoundaryChecks: [],
    failedCandidates: [],
    generatedSurfaces: [],
    successfulCandidates: [],
    torusSplits: [],
    totals: {},
    totalSplitAttempts: 0,
    successfulSplits: 0
  };
}

export function surfaceStatsForDiagnostics(diagnostics, surfaceType) {
  if (!diagnostics.totals[surfaceType]) {
    diagnostics.totals[surfaceType] = {
      faces: 0,
      splitSurfaces: 0,
      sectionEdges: 0,
      toolFaces: 0,
      successfulSplits: 0,
      failedCandidates: 0
    };
  }

  return diagnostics.totals[surfaceType];
}

export function mergeSplitDiagnostics(target, source) {
  for (const key of [
    'apexConeFaceDivide',
    'coneBoundaryChecks',
    'failedCandidates',
    'generatedSurfaces',
    'successfulCandidates',
    'torusSplits'
  ]) {
    target[key].push(...(source[key] || []));
  }

  target.totalSplitAttempts += source.totalSplitAttempts || 0;
  target.successfulSplits += source.successfulSplits || 0;

  for (const [surfaceType, sourceStats] of Object.entries(source.totals || {})) {
    const stats = surfaceStatsForDiagnostics(target, surfaceType);

    for (const key of Object.keys(stats)) {
      stats[key] += sourceStats[key] || 0;
    }
  }
}
