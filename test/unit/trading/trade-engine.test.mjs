import assert from "node:assert/strict";
import test from "node:test";
import { calculateMarketFillPrice, executeMarketOrder, settleNextTradingDay } from "../../../src/domain/trading/trade-engine.mjs";

const emptyPosition = Object.freeze({ quantity: 0, availableQuantity: 0, totalCostCents: 0 });
const normalMarket = Object.freeze({
  closePriceCents: 1_000,
  limitUpPriceCents: 1_100,
  limitDownPriceCents: 900,
  isSuspended: false,
});

function execute(overrides = {}) {
  return executeMarketOrder({
    order: { side: "buy", orderType: "MARKET", quantity: 1_000 },
    market: normalMarket,
    account: { cashCents: 2_000_000 },
    position: emptyPosition,
    ...overrides,
  });
}

test("market fills use the current close with configurable directional slippage", () => {
  assert.equal(calculateMarketFillPrice(1_000, "buy", 0), 1_000);
  assert.equal(calculateMarketFillPrice(1_000, "buy", 1_000), 1_001);
  assert.equal(calculateMarketFillPrice(1_000, "sell", 1_000), 999);
});

test("buy updates cash and cost while T+1 keeps new shares unavailable", () => {
  const result = execute();
  assert.equal(result.accepted, true);
  assert.equal(result.account.cashCents, 999_490);
  assert.deepEqual(result.position, { quantity: 1_000, availableQuantity: 0, totalCostCents: 1_000_510 });
  assert.equal(result.fill.fillPriceCents, 1_000);
  assert.equal(result.fill.totalFeesCents, 510);
});

test("advancing to the next trading day releases the full position for sale", () => {
  assert.deepEqual(
    settleNextTradingDay({ quantity: 1_000, availableQuantity: 0, totalCostCents: 1_000_510 }),
    { quantity: 1_000, availableQuantity: 1_000, totalCostCents: 1_000_510 },
  );
});

test("T+1 rejects same-day sales without mutating the supplied state", () => {
  const position = { quantity: 1_000, availableQuantity: 0, totalCostCents: 1_000_510 };
  const account = { cashCents: 999_490 };
  const result = execute({ order: { side: "sell", orderType: "MARKET", quantity: 100 }, position, account });
  assert.equal(result.error.code, "T1_QUANTITY_UNAVAILABLE");
  assert.deepEqual(position, { quantity: 1_000, availableQuantity: 0, totalCostCents: 1_000_510 });
  assert.deepEqual(account, { cashCents: 999_490 });
});

test("partial sale allocates cost and returns realized profit", () => {
  const result = execute({
    order: { side: "sell", orderType: "MARKET", quantity: 500 },
    position: { quantity: 1_000, availableQuantity: 1_000, totalCostCents: 900_000 },
    account: { cashCents: 100_000 },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.fill.allocatedCostCents, 450_000);
  assert.equal(result.fill.realizedProfitCents, 49_245);
  assert.deepEqual(result.position, { quantity: 500, availableQuantity: 500, totalCostCents: 450_000 });
  assert.equal(result.account.cashCents, 599_245);
});

test("remaining odd lots can only be sold in one complete order", () => {
  const position = { quantity: 50, availableQuantity: 50, totalCostCents: 40_000 };
  assert.equal(execute({ order: { side: "sell", orderType: "MARKET", quantity: 25 }, position }).error.code, "INVALID_SELL_QUANTITY");
  assert.equal(execute({ order: { side: "sell", orderType: "MARKET", quantity: 50 }, position }).accepted, true);
});

test("buy and ordinary sell quantities must use board lots", () => {
  assert.equal(execute({ order: { side: "buy", orderType: "MARKET", quantity: 150 } }).error.code, "INVALID_BUY_QUANTITY");
  assert.equal(execute({
    order: { side: "sell", orderType: "MARKET", quantity: 150 },
    position: { quantity: 250, availableQuantity: 250, totalCostCents: 200_000 },
  }).error.code, "INVALID_SELL_QUANTITY");
});

test("cash, position and short-sale limits reject invalid orders", () => {
  assert.equal(execute({ account: { cashCents: 1_000 } }).error.code, "INSUFFICIENT_CASH");
  assert.equal(execute({
    order: { side: "sell", orderType: "MARKET", quantity: 200 },
    position: { quantity: 100, availableQuantity: 100, totalCostCents: 80_000 },
  }).error.code, "INSUFFICIENT_POSITION");
});

test("suspension and price limits apply asymmetrically by side", () => {
  assert.equal(execute({ market: { ...normalMarket, isSuspended: true } }).error.code, "TRADING_SUSPENDED");
  assert.equal(execute({ market: { ...normalMarket, closePriceCents: 1_100 } }).error.code, "BUY_BLOCKED_AT_LIMIT_UP");
  const position = { quantity: 100, availableQuantity: 100, totalCostCents: 90_000 };
  assert.equal(execute({
    order: { side: "sell", orderType: "MARKET", quantity: 100 },
    market: { ...normalMarket, closePriceCents: 900 },
    position,
  }).error.code, "SELL_BLOCKED_AT_LIMIT_DOWN");
  assert.equal(execute({
    order: { side: "sell", orderType: "MARKET", quantity: 100 },
    market: { ...normalMarket, closePriceCents: 1_100 },
    position,
  }).accepted, true);
});

test("limit and breakout orders return the agreed unsupported error", () => {
  assert.equal(execute({ order: { side: "buy", orderType: "LIMIT", quantity: 100 } }).error.code, "UNSUPPORTED_ORDER_TYPE");
  assert.equal(execute({ order: { side: "buy", orderType: "BREAKOUT", quantity: 100 } }).error.code, "UNSUPPORTED_ORDER_TYPE");
});
