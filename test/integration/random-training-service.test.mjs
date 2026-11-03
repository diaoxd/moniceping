import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createRandomTrainingService } from "../../src/application/random-training-service.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE stocks (stock_code TEXT PRIMARY KEY, stock_name TEXT, market TEXT, board_type TEXT);
    CREATE TABLE daily_bars (stock_code TEXT, trade_date TEXT, open_cents INTEGER, high_cents INTEGER,
    low_cents INTEGER, close_cents INTEGER, volume INTEGER, amount_cents INTEGER, pct_chg TEXT,
    is_suspended INTEGER, limit_up_price_cents INTEGER, limit_down_price_cents INTEGER);`);
  db.prepare("INSERT INTO stocks VALUES ('600000', '浦发银行', 'SH', 'MAIN')").run();
  const insert = db.prepare("INSERT INTO daily_bars VALUES (?, ?, ?, ?, ?, ?, 100, 10000, NULL, 0, NULL, NULL)");
  for (let index = 0; index < 600; index += 1) {
    const date = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
    const price = 1000 + index;
    insert.run("600000", date, price, price + 10, price - 10, price);
  }
  return db;
}

test("random training service creates a date-hidden session from SQLite", () => {
  const db = database();
  const service = createRandomTrainingService({ marketDatabase: db, idFactory: () => "session-fixed" });
  const result = service.create({ simulationBars: 150, seed: "service-seed", initialCapitalCents: 2_000_000 });
  assert.equal(result.session.id, "session-fixed");
  assert.equal(result.state.stockCode, "600000");
  assert.equal(result.state.account.cashCents, 2_000_000);
  assert.equal(result.state.bars.daily.length, 200);
  assert.equal(JSON.stringify(result.state).includes("tradeDate"), false);
  assert.ok(result.candidateCount > 0);
  db.close();
});

test("random training service preserves domain validation", () => {
  const db = database();
  const service = createRandomTrainingService({ marketDatabase: db, idFactory: () => "session-fixed" });
  assert.throws(() => service.create({ simulationBars: 100 }), (error) => error.code === "INVALID_SIMULATION_BARS");
  assert.throws(() => service.create({ initialCapitalCents: 999_999 }), (error) => error.code === "INVALID_INITIAL_CAPITAL");
  assert.throws(() => service.create({ excludeStockCode: "600000" }), (error) => error.code === "NO_TRAINING_CANDIDATE");
  db.close();
});

test("random training service reuses candidate ranges across sessions", () => {
  const db = database();
  const service = createRandomTrainingService({ marketDatabase: db, idFactory: () => "session-fixed" });
  const first = service.create({ simulationBars: 150, seed: "before-change" });
  db.prepare("INSERT INTO stocks VALUES ('000001', '新增股票', 'SZ', 'MAIN')").run();
  const insert = db.prepare("INSERT INTO daily_bars VALUES (?, ?, ?, ?, ?, ?, 100, 10000, NULL, 0, NULL, NULL)");
  for (let index = 0; index < 600; index += 1) {
    const date = new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10);
    insert.run("000001", date, 1000, 1010, 990, 1000);
  }
  const second = service.create({ simulationBars: 150, seed: "after-change" });
  const uncached = service.create({ simulationBars: 200, seed: "uncached" });
  assert.equal(second.candidateCount, first.candidateCount);
  assert.ok(uncached.candidateCount > 0);
  db.close();
});
