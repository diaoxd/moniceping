import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { advanceTrainingSession, createTrainingSession, executeTrainingMarketOrder, rollbackTrainingSession } from "../../src/domain/session/training-session.mjs";
import { openAppDatabase } from "../../src/infrastructure/app-database.mjs";
import { createTrainingSessionRepository } from "../../src/infrastructure/training-session-repository.mjs";

function bars(count = 400) {
  return Array.from({ length: count }, (_, index) => {
    const price = 1000 + index;
    return {
      tradeDate: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
      openCents: price, highCents: price + 10, lowCents: price - 10, closeCents: price,
      volume: 1000 + index, amountCents: 1_000_000 + index,
    };
  });
}

function session(marketBars) {
  return createTrainingSession({
    id: "persisted-session", stockCode: "600000", stockName: "浦发银行",
    bars: marketBars, startIndex: 200, simulationBars: 150,
    initialCapitalCents: 10_000_000, randomSeed: "persist-seed",
  });
}

test("app migration and repository persist a resumable training session", () => {
  const directory = mkdtempSync(join(tmpdir(), "trainer-app-db-"));
  const filename = join(directory, "app.db");
  const marketBars = bars();
  let database = openAppDatabase(filename);
  let repository = createTrainingSessionRepository(database);
  repository.save(session(marketBars));
  database.close();

  database = openAppDatabase(filename);
  repository = createTrainingSessionRepository(database);
  const restored = repository.load("persisted-session", marketBars);
  assert.equal(restored.stockCode, "600000");
  assert.equal(restored.bars.length, 400);
  assert.equal(restored.snapshots.length, 1);
  assert.equal(restored.account.cashCents, 10_000_000);
  database.close();
  rmSync(directory, { recursive: true });
});

test("advance and rollback snapshots survive repository round trips", () => {
  const database = openAppDatabase(":memory:");
  const repository = createTrainingSessionRepository(database);
  const marketBars = bars();
  const original = session(marketBars);
  repository.save(original);
  const advanced = advanceTrainingSession(original, 0);
  repository.save(advanced, 0);
  const restored = repository.load(original.id, marketBars);
  assert.equal(restored.version, 1);
  assert.equal(restored.snapshots.length, 2);
  const rolledBack = rollbackTrainingSession(restored, 1);
  repository.save(rolledBack, 1);
  assert.equal(repository.load(original.id, marketBars).advancesCompleted, 0);
  assert.throws(() => repository.save(advanced, 0), (error) => error.code === "VERSION_CONFLICT");
  database.close();
});

test("orders and fills survive repository round trips", () => {
  const database = openAppDatabase(":memory:");
  const repository = createTrainingSessionRepository(database);
  const marketBars = bars();
  const original = session(marketBars);
  repository.save(original);
  const bought = executeTrainingMarketOrder(original, 0, {
    id: "persisted-order", fillId: "persisted-fill", side: "buy", quantity: 100,
  });
  repository.save(bought, 0);
  const restored = repository.load(original.id, marketBars);
  assert.equal(restored.orders[0].id, "persisted-order");
  assert.equal(restored.fills[0].id, "persisted-fill");
  assert.equal(restored.position.quantity, 100);
  assert.equal(restored.snapshots.at(-1).orders.length, 1);
  database.close();
});
