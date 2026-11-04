import assert from "node:assert/strict";
import test from "node:test";
import { openAppDatabase } from "../../src/infrastructure/app-database.mjs";
import { createConditionalOrderRepository } from "../../src/infrastructure/conditional-order-repository.mjs";
import { createTrainingSessionRepository } from "../../src/infrastructure/training-session-repository.mjs";
import { createTrainingSession } from "../../src/domain/session/training-session.mjs";

function session() {
  const bars = Array.from({ length: 360 }, (_, index) => ({
    tradeDate: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    openCents: 1000, highCents: 1010, lowCents: 990, closeCents: 1000, volume: 1000, amountCents: 1_000_000,
  }));
  return createTrainingSession({ id: "conditional-session", stockCode: "600000", stockName: "测试股", bars,
    startIndex: 200, simulationBars: 150, initialCapitalCents: 10_000_000, randomSeed: "conditional" });
}

test("conditional orders and risk setting persist and can be cancelled", () => {
  const database = openAppDatabase(":memory:");
  createTrainingSessionRepository(database).save(session());
  const repository = createConditionalOrderRepository(database);
  repository.create({ id: "stop-1", sessionId: "conditional-session", side: "sell", triggerDirection: "cross_down",
    triggerPriceCents: 950, quantity: 100, createdStep: 0 });
  assert.equal(repository.listPending("conditional-session").length, 1);
  assert.deepEqual(repository.getRiskSettings("conditional-session"), { requireStopLoss: true });
  assert.deepEqual(repository.setRiskSettings("conditional-session", false), { requireStopLoss: false });
  assert.equal(repository.getRiskSettings("conditional-session").requireStopLoss, false);
  assert.equal(repository.cancel("conditional-session", "stop-1"), true);
  assert.equal(repository.list("conditional-session")[0].status, "cancelled");
  database.close();
});
