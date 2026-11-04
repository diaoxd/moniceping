function ratioMillionths(numerator, denominator) {
  return denominator === 0 ? null : Math.round(numerator / denominator * 1_000_000);
}

export function summarizeTrainingDashboard({ sessions = [], fills = [], snapshots = [] }) {
  const sessionsWithFills = new Set(fills.map((fill) => fill.sessionId));
  const validSessions = sessions.filter((session) => session.status === "finished" && (session.advancesCompleted > 0 || sessionsWithFills.has(session.id)));
  const validIds = new Set(validSessions.map((session) => session.id));
  const validFills = fills.filter((fill) => validIds.has(fill.sessionId));
  const sells = validFills.filter((fill) => fill.side === "sell");
  const wins = sells.filter((fill) => fill.realizedProfitCents > 0);
  const losses = sells.filter((fill) => fill.realizedProfitCents < 0);
  const totalProfitCents = validSessions.reduce((sum, session) => sum + session.equityCents - session.initialCapitalCents, 0);
  const totalBars = validSessions.reduce((sum, session) => sum + session.advancesCompleted, 0);
  const averageWin = wins.length ? wins.reduce((sum, fill) => sum + fill.realizedProfitCents, 0) / wins.length : 0;
  const averageLoss = losses.length ? losses.reduce((sum, fill) => sum + Math.abs(fill.realizedProfitCents), 0) / losses.length : 0;

  let maximumDrawdownMillionths = 0;
  let holdingBars = 0;
  for (const session of validSessions) {
    const sessionSnapshots = snapshots
      .filter((snapshot) => snapshot.sessionId === session.id)
      .sort((left, right) => left.sequence - right.sequence);
    let peak = session.initialCapitalCents;
    const heldSteps = new Set();
    for (const snapshot of sessionSnapshots) {
      peak = Math.max(peak, snapshot.equityCents);
      if (peak > 0) maximumDrawdownMillionths = Math.max(maximumDrawdownMillionths, Math.round((peak - snapshot.equityCents) / peak * 1_000_000));
      if (snapshot.positionQuantity > 0) heldSteps.add(snapshot.advancesCompleted);
    }
    holdingBars += heldSteps.size;
  }

  const chronological = validSessions.slice().sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
  const startingCapitalCents = chronological[0]?.initialCapitalCents ?? null;
  let cumulativeEquityCents = startingCapitalCents;
  const equityCurve = startingCapitalCents === null ? [] : [{ sequence: 0, label: "初始资金", equityCents: startingCapitalCents }];
  chronological.forEach((session, index) => {
    cumulativeEquityCents += session.equityCents - session.initialCapitalCents;
    equityCurve.push({ sequence: index + 1, sessionId: session.id, label: session.stockName || `第${index + 1}局`, equityCents: cumulativeEquityCents });
  });
  return Object.freeze({
    startingCapitalCents,
    currentEquityCents: cumulativeEquityCents,
    totalProfitCents,
    returnRateMillionths: ratioMillionths(totalProfitCents, startingCapitalCents),
    trainingCount: validSessions.length,
    holdingBars,
    totalBars,
    operationCount: sells.length,
    fillCount: validFills.length,
    winRateMillionths: ratioMillionths(wins.length, sells.length),
    profitLossRatioMillionths: losses.length && wins.length ? Math.round(averageWin / averageLoss * 1_000_000) : null,
    maximumProfitCents: sells.length ? Math.max(...sells.map((fill) => fill.realizedProfitCents)) : null,
    maximumLossCents: sells.length ? Math.min(...sells.map((fill) => fill.realizedProfitCents)) : null,
    expectancyCents: sells.length ? Math.round(sells.reduce((sum, fill) => sum + fill.realizedProfitCents, 0) / sells.length) : null,
    maximumDrawdownMillionths,
    tradesPerHundredBarsMillionths: ratioMillionths(validFills.length * 100, totalBars),
    equityCurve: Object.freeze(equityCurve.map((point) => Object.freeze(point))),
  });
}
