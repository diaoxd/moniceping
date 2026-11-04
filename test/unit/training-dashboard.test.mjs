import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTrainingDashboard } from "../../src/application/training-dashboard.mjs";

test("training dashboard summarizes only meaningful finished sessions", () => {
  const sessions = [
    { id: "a", status: "finished", advancesCompleted: 10, initialCapitalCents: 100_000, equityCents: 110_000, updatedAt: "2026-01-01" },
    { id: "b", status: "finished", advancesCompleted: 5, initialCapitalCents: 110_000, equityCents: 105_000, updatedAt: "2026-01-02" },
    { id: "empty", status: "finished", advancesCompleted: 0, initialCapitalCents: 1, equityCents: 1, updatedAt: "2026-01-03" },
  ];
  const fills = [
    { sessionId: "a", side: "sell", realizedProfitCents: 8_000 },
    { sessionId: "b", side: "sell", realizedProfitCents: -4_000 },
  ];
  const snapshots = [
    { sessionId: "a", sequence: 0, advancesCompleted: 0, equityCents: 100_000, positionQuantity: 100 },
    { sessionId: "a", sequence: 1, advancesCompleted: 1, equityCents: 90_000, positionQuantity: 100 },
    { sessionId: "a", sequence: 2, advancesCompleted: 1, equityCents: 110_000, positionQuantity: 0 },
  ];
  const result = summarizeTrainingDashboard({ sessions, fills, snapshots });
  assert.equal(result.currentEquityCents, 105_000);
  assert.equal(result.startingCapitalCents, 100_000);
  assert.equal(result.totalProfitCents, 5_000);
  assert.equal(result.returnRateMillionths, 50_000);
  assert.equal(result.trainingCount, 2);
  assert.equal(result.operationCount, 2);
  assert.equal(result.winRateMillionths, 500_000);
  assert.equal(result.profitLossRatioMillionths, 2_000_000);
  assert.equal(result.expectancyCents, 2_000);
  assert.equal(result.maximumDrawdownMillionths, 100_000);
  assert.equal(result.holdingBars, 2);
  assert.deepEqual(result.equityCurve.map((point) => point.equityCents), [100_000, 110_000, 105_000]);
});

test("empty dashboard has stable null metrics", () => {
  const result = summarizeTrainingDashboard({});
  assert.equal(result.currentEquityCents, null);
  assert.equal(result.winRateMillionths, null);
  assert.equal(result.trainingCount, 0);
});
