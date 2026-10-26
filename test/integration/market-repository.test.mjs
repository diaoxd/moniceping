import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadTrainingStocks } from "../../src/infrastructure/market-repository.mjs";
import { selectRandomTrainingCandidate } from "../../src/domain/session/random-candidate.mjs";

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE stocks (stock_code TEXT PRIMARY KEY, stock_name TEXT, market TEXT, board_type TEXT);
    CREATE TABLE daily_bars (
      stock_code TEXT, trade_date TEXT, open_cents INTEGER, high_cents INTEGER,
      low_cents INTEGER, close_cents INTEGER, volume INTEGER, amount_cents INTEGER,
      pct_chg TEXT, is_suspended INTEGER, limit_up_price_cents INTEGER, limit_down_price_cents INTEGER
    );
  `);
  const addStock = database.prepare("INSERT INTO stocks VALUES (?, ?, ?, ?)");
  const addBar = database.prepare("INSERT INTO daily_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  addStock.run("600000", "浦发银行", "SH", "MAIN");
  addStock.run("688001", "华兴源创", "SH", "STAR");
  for (const [code, offset] of [["600000", 0], ["688001", 100]]) {
    for (let index = 0; index < 600; index += 1) {
      const date = new Date(Date.UTC(2020, 0, 1 + index));
      const iso = date.toISOString().slice(0, 10);
      const close = 1000 + offset + index;
      addBar.run(code, iso, close, close + 10, close - 10, close, 100, 10000, null, 0, null, null);
    }
  }
  return database;
}

test("market repository loads real-shaped bars for random training", () => {
  const database = createDatabase();
  const stocks = loadTrainingStocks(database, { simulationBars: 150 });
  assert.equal(stocks.length, 2);
  assert.equal(stocks[0].bars.length, 600);
  const first = selectRandomTrainingCandidate({ stocks, simulationBars: 150, seed: "integration-seed" });
  const second = selectRandomTrainingCandidate({ stocks, simulationBars: 150, seed: "integration-seed" });
  assert.deepEqual(first, second);
  assert.ok(first.candidate.startTradeDate >= "2021-01-01");
  database.close();
});

test("market repository excludes stocks without enough context or future bars", () => {
  const database = createDatabase();
  database.prepare("INSERT INTO stocks VALUES (?, ?, ?, ?)").run("000001", "短历史", "SZ", "MAIN");
  const addBar = database.prepare("INSERT INTO daily_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  addBar.run("000001", "2021-01-01", 100, 110, 90, 100, 1, 1, null, 0, null, null);
  assert.equal(loadTrainingStocks(database, { simulationBars: 200 }).some((stock) => stock.stockCode === "000001"), false);
  database.close();
});
