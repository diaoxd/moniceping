import assert from "node:assert/strict";
import test from "node:test";
import { createInsightRepository, createMatchingRepository, createTradeConfigRepository, DEMO_SESSION_ID, matchOrder, openDatabase } from "./database.mjs";

test("daily insights are created, updated, listed and deleted", () => {
  const database = openDatabase(":memory:");
  const repository = createInsightRepository(database);

  const created = repository.save(DEMO_SESSION_ID, "159806", "1d", "2024-07-02", "等待趋势确认");
  assert.equal(created.content, "等待趋势确认");
  assert.equal(repository.list(DEMO_SESSION_ID, "159806", "1d").length, 1);

  const updated = repository.save(DEMO_SESSION_ID, "159806", "1d", "2024-07-02", "缩小仓位，等待趋势确认");
  assert.equal(updated.content, "缩小仓位，等待趋势确认");
  assert.equal(repository.list(DEMO_SESSION_ID, "159806", "1d").length, 1);

  assert.equal(repository.delete(DEMO_SESSION_ID, "159806", "1d", "2024-07-02"), true);
  assert.equal(repository.get(DEMO_SESSION_ID, "159806", "1d", "2024-07-02"), null);
  database.close();
});

test("insights cannot be written to a mismatched session", () => {
  const database = openDatabase(":memory:");
  const repository = createInsightRepository(database);
  assert.throws(
    () => repository.save(DEMO_SESSION_ID, "000001", "1d", "2024-07-02", "测试"),
    (error) => error.code === "SESSION_NOT_FOUND",
  );
  database.close();
});

test("matching settings persist for a training session", () => {
  const database = openDatabase(":memory:");
  const repository = createMatchingRepository(database);
  const updated = repository.update(DEMO_SESSION_ID, {
    blockBuyAtLimitUp: false,
    blockSellAtLimitDown: true,
  });
  assert.equal(updated.blockBuyAtLimitUp, false);
  assert.equal(updated.blockSellAtLimitDown, true);
  database.close();
});

test("matching rejects buys at limit-up and sells at limit-down when enabled", () => {
  const settings = { blockBuyAtLimitUp: true, blockSellAtLimitDown: true, limitRate: 0.1 };
  assert.equal(matchOrder({ side: "buy", price: 11, previousClose: 10, quantity: 100 }, settings).code, "BUY_BLOCKED_AT_LIMIT_UP");
  assert.equal(matchOrder({ side: "sell", price: 9, previousClose: 10, quantity: 100 }, settings).code, "SELL_BLOCKED_AT_LIMIT_DOWN");
  assert.equal(matchOrder({ side: "buy", price: 10.99, previousClose: 10, quantity: 100 }, settings).accepted, true);
});

test("matching allows limit-price trades when restrictions are disabled", () => {
  const settings = { blockBuyAtLimitUp: false, blockSellAtLimitDown: false, limitRate: 0.1 };
  assert.equal(matchOrder({ side: "buy", price: 11, previousClose: 10, quantity: 100 }, settings).accepted, true);
  assert.equal(matchOrder({ side: "sell", price: 9, previousClose: 10, quantity: 100 }, settings).accepted, true);
});

test("trade configuration uses pre-adjusted data and 0.2 percent commission", () => {
  const database = openDatabase(":memory:");
  const config = createTradeConfigRepository(database).get(DEMO_SESSION_ID);
  assert.equal(config.adjustType, "pre");
  assert.equal(config.commissionRate, 0.002);

  const matched = matchOrder(
    { side: "buy", price: 10, previousClose: 10, quantity: 1000 },
    { blockBuyAtLimitUp: true, blockSellAtLimitDown: true, limitRate: 0.1 },
    config,
  );
  assert.equal(matched.grossAmount, 10000);
  assert.equal(matched.commission, 20);
  assert.equal(matched.cashChange, -10020);
  database.close();
});
