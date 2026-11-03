import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadTrainingRanges, loadTrainingStocks, validateMarketDatabaseSchema } from "../../src/infrastructure/market-repository.mjs";
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

test("market repository returns compact weighted ranges without loading bars", () => {
  const database = createDatabase();
  const ranges = loadTrainingRanges(database, { simulationBars: 150 });
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].firstStartIndex, 366);
  assert.equal(ranges[0].eligibleCount, 85);
  assert.equal("bars" in ranges[0], false);
  database.close();
});

test("market schema validation rejects empty or incomplete databases", () => {
  const empty = new DatabaseSync(":memory:");
  assert.throws(() => validateMarketDatabaseSchema(empty), (error) =>
    error.code === "MARKET_SCHEMA_INVALID" && /stocks/.test(error.message));
  empty.close();

  const incomplete = new DatabaseSync(":memory:");
  incomplete.exec("CREATE TABLE stocks (stock_code TEXT); CREATE TABLE daily_bars (stock_code TEXT)");
  assert.throws(() => validateMarketDatabaseSchema(incomplete), (error) =>
    error.code === "MARKET_SCHEMA_INVALID" && /stock_name/.test(error.message));
  incomplete.close();
  const complete = createDatabase();
  assert.equal(validateMarketDatabaseSchema(complete), true);
  complete.close();
});
