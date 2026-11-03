import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTrainingSession,
  finishTrainingSession,
  createTrainingSession,
  getPublicTrainingState,
  executeTrainingMarketOrder,
  rollbackTrainingSession,
} from "../../../src/domain/session/training-session.mjs";

function makeBars(count = 450) {
  const bars = [];
  const date = new Date("2020-01-01T00:00:00Z");
  while (bars.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) {
      const index = bars.length;
      const openCents = 1_000 + index;
      bars.push({
        tradeDate: date.toISOString().slice(0, 10),
        openCents,
        highCents: openCents + 20,
        lowCents: openCents - 10,
        closeCents: openCents + 5,
        volume: 10_000 + index,
        amountCents: 1_000_000 + index,
      });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return bars;
}

function create(overrides = {}) {
  return createTrainingSession({
    id: "session-1",
    stockCode: "000001",
    stockName: "测试股份",
    bars: makeBars(),
    startIndex: 200,
    simulationBars: 150,
    initialCapitalCents: 10_000_000,
    randomSeed: "seed-1",
    ...overrides,
  });
}

test("creation exposes exactly 200 historical bars and hides every real date", () => {
  const state = getPublicTrainingState(create());
  assert.equal(state.bars.daily.length, 200);
  assert.equal(state.bars.daily[0].index, -199);
  assert.equal(state.bars.daily.at(-1).index, 0);
  assert.equal(state.trainingStartBarIndex, 0);
  assert.equal(state.initialCapitalCents, 10_000_000);
  assert.equal(state.bars.daily.filter((bar) => bar.isTrainingStart).length, 1);
  assert.equal(state.bars.weekly.filter((bar) => bar.isTrainingStart).length, 1);
  assert.equal(state.bars.monthly.filter((bar) => bar.isTrainingStart).length, 1);
  assert.equal(JSON.stringify(state).includes("tradeDate"), false);
  assert.equal(JSON.stringify(state).includes("2020-"), false);
  assert.equal(state.datesRevealed, false);
});

test("only 150 or 200 simulation bars are accepted", () => {
  assert.throws(() => create({ simulationBars: 149 }), (error) => error.code === "INVALID_SIMULATION_BARS");
  assert.equal(create({ simulationBars: 200, bars: makeBars(500) }).simulationBars, 200);
});

test("initial capital uses the confirmed range and cent precision", () => {
  assert.throws(() => create({ initialCapitalCents: 999_999 }), (error) => error.code === "INVALID_INITIAL_CAPITAL");
  assert.throws(() => create({ initialCapitalCents: 1_000_000_001 }), (error) => error.code === "INVALID_INITIAL_CAPITAL");
  assert.equal(create({ initialCapitalCents: 1_000_000 }).account.cashCents, 1_000_000);
});

test("insufficient history and future bars are rejected", () => {
  assert.throws(() => create({ startIndex: 199 }), (error) => error.code === "INSUFFICIENT_HISTORY");
  assert.throws(() => create({ bars: makeBars(349) }), (error) => error.code === "INSUFFICIENT_FUTURE_BARS");
  assert.equal(create({ bars: makeBars(350) }).endIndex, 349);
});

test("advance reveals one daily bar and recomputes weekly and monthly bars from visible data only", () => {
  const session = create();
  const before = getPublicTrainingState(session);
  const advanced = advanceTrainingSession(session, 0);
  const after = getPublicTrainingState(advanced);
  assert.equal(after.bars.daily.length, 201);
  assert.equal(after.bars.daily.at(-1).index, 1);
  assert.equal(after.advancesCompleted, 1);
  assert.equal(after.advancesRemaining, 149);
  assert.ok(after.bars.weekly.length >= before.bars.weekly.length);
  assert.ok(after.bars.monthly.length >= before.bars.monthly.length);
  assert.equal(after.bars.weekly.reduce((sum, bar) => sum + bar.sourceCount, 0), 201);
  assert.equal(after.bars.monthly.reduce((sum, bar) => sum + bar.sourceCount, 0), 201);
});

test("advance rejects stale versions and never changes the original session", () => {
  const session = create();
  const advanced = advanceTrainingSession(session, 0);
  assert.equal(session.version, 0);
  assert.equal(session.advancesCompleted, 0);
  assert.equal(advanced.version, 1);
  assert.throws(() => advanceTrainingSession(advanced, 0), (error) => error.code === "VERSION_CONFLICT");
});

test("empty-position rollback restores the prior step and increments the version", () => {
  const session = advanceTrainingSession(advanceTrainingSession(create(), 0), 1);
  const rolledBack = rollbackTrainingSession(session, 2);
  assert.equal(rolledBack.advancesCompleted, 1);
  assert.equal(rolledBack.visibleIndex, session.visibleIndex - 1);
  assert.equal(rolledBack.version, 3);
  assert.equal(getPublicTrainingState(rolledBack).bars.daily.length, 201);
});

test("rollback cannot cross the simulation start", () => {
  assert.throws(() => rollbackTrainingSession(create(), 0), (error) => error.code === "ROLLBACK_AT_START");
});

test("a position blocks rollback without changing session state", () => {
  const advanced = advanceTrainingSession(create(), 0);
  const held = Object.freeze({ ...advanced, position: Object.freeze({ quantity: 100, availableQuantity: 100, totalCostCents: 100_000 }) });
  assert.throws(() => rollbackTrainingSession(held, 1), (error) => error.code === "ROLLBACK_BLOCKED_BY_POSITION");
  assert.equal(held.advancesCompleted, 1);
});

test("market trades update session account, position and public audit records", () => {
  const bought = executeTrainingMarketOrder(create(), 0, {
    id: "order-1", fillId: "fill-1", side: "buy", quantity: 100,
  });
  const state = getPublicTrainingState(bought);
  assert.equal(bought.version, 1);
  assert.equal(state.position.quantity, 100);
  assert.equal(state.position.availableQuantity, 0);
  assert.equal(state.orders.length, 1);
  assert.equal(state.fills[0].fillPriceCents, bought.bars[bought.visibleIndex].closeCents);
  assert.equal(state.performance.totalFeesCents, state.fills[0].totalFeesCents);
  assert.equal(state.performance.winRateMillionths, null);
  assert.equal(state.performance.totalProfitCents, state.account.equityCents - bought.initialCapitalCents);
  assert.throws(() => rollbackTrainingSession(bought, 1), (error) => error.code === "ROLLBACK_BLOCKED_BY_POSITION");
});

test("performance summarizes realized profit, return and sell win rate", () => {
  let session = executeTrainingMarketOrder(create(), 0, {
    id: "buy-order", fillId: "buy-fill", side: "buy", quantity: 100,
  });
  session = advanceTrainingSession(session, 1);
  session = executeTrainingMarketOrder(session, 2, {
    id: "sell-order", fillId: "sell-fill", side: "sell", quantity: 100,
  });
  const state = getPublicTrainingState(session);
  assert.equal(state.performance.completedTradeCount, 1);
  assert.equal(state.performance.profitableTradeCount, state.fills[1].realizedProfitCents > 0 ? 1 : 0);
  assert.equal(state.performance.realizedProfitCents, state.fills[1].realizedProfitCents);
  assert.equal(state.performance.unrealizedProfitCents, 0);
  assert.equal(state.performance.totalProfitCents, state.account.equityCents - session.initialCapitalCents);
  assert.equal(state.performance.profitLossRatioMillionths, null);
});

test("performance calculates profit-loss ratio and maximum peak-to-trough drawdown", () => {
  const original = create();
  const session = Object.freeze({
    ...original,
    account: Object.freeze({ ...original.account, equityCents: 9_200_000 }),
    fills: Object.freeze([
      Object.freeze({ side: "sell", realizedProfitCents: 120_000, totalFeesCents: 500 }),
      Object.freeze({ side: "sell", realizedProfitCents: 80_000, totalFeesCents: 500 }),
      Object.freeze({ side: "sell", realizedProfitCents: -50_000, totalFeesCents: 500 }),
    ]),
    snapshots: Object.freeze([
      Object.freeze({ account: Object.freeze({ equityCents: 10_000_000 }) }),
      Object.freeze({ account: Object.freeze({ equityCents: 11_000_000 }) }),
      Object.freeze({ account: Object.freeze({ equityCents: 9_900_000 }) }),
      Object.freeze({ account: Object.freeze({ equityCents: 9_200_000 }) }),
    ]),
  });
  const performance = getPublicTrainingState(session).performance;
  assert.equal(performance.averageProfitCents, 100_000);
  assert.equal(performance.averageLossCents, 50_000);
  assert.equal(performance.profitLossRatioMillionths, 2_000_000);
  assert.equal(performance.maximumDrawdownCents, 1_800_000);
  assert.equal(performance.maximumDrawdownMillionths, 163_636);
});

test("the configured final advance finishes the session and prevents further advance", () => {
  let session = create();
  for (let step = 0; step < 150; step += 1) session = advanceTrainingSession(session, session.version);
  assert.equal(session.status, "finished");
  assert.equal(session.advancesCompleted, 150);
  const state = getPublicTrainingState(session);
  assert.equal(state.bars.daily.length, 350);
  assert.equal(state.datesRevealed, true);
  assert.match(state.bars.daily.at(-1).tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(state.bars.weekly.at(-1).periodStart, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(state.bars.monthly.at(-1).periodStart, /^\d{4}-\d{2}$/);
  assert.throws(() => advanceTrainingSession(session, session.version), (error) => error.code === "SESSION_NOT_RUNNING");
});

test("manual finish persists the current mark-to-market state and reveals dates", () => {
  const session = create();
  const finished = finishTrainingSession(session, session.version);
  assert.equal(finished.status, "finished");
  assert.equal(finished.advancesCompleted, 0);
  assert.equal(finished.version, session.version + 1);
  assert.equal(finished.snapshots.length, session.snapshots.length + 1);
  const state = getPublicTrainingState(finished);
  assert.equal(state.datesRevealed, true);
  assert.match(state.bars.daily.at(-1).tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.throws(() => finishTrainingSession(finished, finished.version), (error) => error.code === "SESSION_NOT_RUNNING");
  assert.throws(() => finishTrainingSession(session, session.version + 1), (error) => error.code === "VERSION_CONFLICT");
});

test("invalid or duplicate daily data is rejected before a session is created", () => {
  const bars = makeBars();
  bars[2] = { ...bars[2], tradeDate: bars[1].tradeDate };
  assert.throws(() => create({ bars }), (error) => error.code === "INVALID_MARKET_BAR");
  const invalidOhlc = makeBars();
  invalidOhlc[5] = { ...invalidOhlc[5], highCents: invalidOhlc[5].lowCents - 1 };
  assert.throws(() => create({ bars: invalidOhlc }), (error) => error.code === "INVALID_MARKET_BAR");
});
