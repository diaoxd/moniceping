import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTrainingSession,
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
  assert.equal(JSON.stringify(state).includes("tradeDate"), false);
  assert.equal(JSON.stringify(state).includes("2020-"), false);
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
  assert.throws(() => rollbackTrainingSession(bought, 1), (error) => error.code === "ROLLBACK_BLOCKED_BY_POSITION");
});

test("the configured final advance finishes the session and prevents further advance", () => {
  let session = create();
  for (let step = 0; step < 150; step += 1) session = advanceTrainingSession(session, session.version);
  assert.equal(session.status, "finished");
  assert.equal(session.advancesCompleted, 150);
  assert.equal(getPublicTrainingState(session).bars.daily.length, 350);
  assert.throws(() => advanceTrainingSession(session, session.version), (error) => error.code === "SESSION_NOT_RUNNING");
});

test("invalid or duplicate daily data is rejected before a session is created", () => {
  const bars = makeBars();
  bars[2] = { ...bars[2], tradeDate: bars[1].tradeDate };
  assert.throws(() => create({ bars }), (error) => error.code === "INVALID_MARKET_BAR");
  const invalidOhlc = makeBars();
  invalidOhlc[5] = { ...invalidOhlc[5], highCents: invalidOhlc[5].lowCents - 1 };
  assert.throws(() => create({ bars: invalidOhlc }), (error) => error.code === "INVALID_MARKET_BAR");
});
