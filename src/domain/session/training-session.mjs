import { aggregateMonthlyBars, aggregateWeeklyBars } from "./bar-aggregation.mjs";
import { settleNextTradingDay } from "../trading/trade-engine.mjs";
import { calculateMaximumBuyQuantity, executeMarketOrder } from "../trading/trade-engine.mjs";
import { calculateTechnicalIndicators } from "../indicators/technical-indicators.mjs";

export const HISTORY_CONTEXT_BARS = 200;
export const ALLOWED_SIMULATION_BARS = Object.freeze([150, 200]);
export const MIN_INITIAL_CAPITAL_CENTS = 1_000_000;
export const MAX_INITIAL_CAPITAL_CENTS = 1_000_000_000;

function sessionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateBar(bar, previousDate) {
  const priceFields = ["openCents", "highCents", "lowCents", "closeCents"];
  if (!bar || typeof bar.tradeDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(bar.tradeDate)) {
    throw sessionError("INVALID_MARKET_BAR", "日线交易日期无效");
  }
  if (previousDate && bar.tradeDate <= previousDate) {
    throw sessionError("INVALID_MARKET_BAR", "日线日期必须严格递增且不能重复");
  }
  if (!priceFields.every((field) => Number.isSafeInteger(bar[field]) && bar[field] >= 0)) {
    throw sessionError("INVALID_MARKET_BAR", "日线价格必须是非负整数分");
  }
  if (bar.highCents < Math.max(bar.openCents, bar.closeCents)
    || bar.lowCents > Math.min(bar.openCents, bar.closeCents)
    || bar.highCents < bar.lowCents) {
    throw sessionError("INVALID_MARKET_BAR", "日线OHLC关系无效");
  }
  if (!Number.isSafeInteger(bar.volume) || bar.volume < 0
    || !Number.isSafeInteger(bar.amountCents) || bar.amountCents < 0) {
    throw sessionError("INVALID_MARKET_BAR", "成交量或成交额无效");
  }
}

function snapshot(session) {
  return Object.freeze({
    visibleIndex: session.visibleIndex,
    advancesCompleted: session.advancesCompleted,
    status: session.status,
    account: Object.freeze({ ...session.account }),
    position: Object.freeze({ ...session.position }),
    orders: Object.freeze(session.orders.map((order) => Object.freeze({ ...order }))),
    fills: Object.freeze(session.fills.map((fill) => Object.freeze({ ...fill }))),
  });
}

function assertVersion(session, expectedVersion) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== session.version) {
    throw sessionError("VERSION_CONFLICT", "训练状态版本不一致，请刷新后重试");
  }
}

function publicBar(bar, relativeIndex, revealDates) {
  return Object.freeze({
    index: relativeIndex,
    isTrainingStart: relativeIndex === 0,
    ...(revealDates ? { tradeDate: bar.tradeDate } : {}),
    openCents: bar.openCents,
    highCents: bar.highCents,
    lowCents: bar.lowCents,
    closeCents: bar.closeCents,
    volume: bar.volume,
    amountCents: bar.amountCents,
  });
}

function publicAggregates(groups, revealDates) {
  let sourceOffset = 0;
  return Object.freeze(groups.map(({ key, ...bar }, index) => {
    const sourceStart = sourceOffset;
    sourceOffset += bar.sourceCount;
    return Object.freeze({
      index,
      isTrainingStart: sourceStart <= HISTORY_CONTEXT_BARS - 1 && sourceOffset > HISTORY_CONTEXT_BARS - 1,
      ...(revealDates ? { periodStart: key } : {}),
      ...bar,
    });
  }));
}

function calculatePerformance(session, currentBar) {
  const sellFills = session.fills.filter((fill) => fill.side === "sell");
  const profitableFills = sellFills.filter((fill) => fill.realizedProfitCents > 0);
  const losingFills = sellFills.filter((fill) => fill.realizedProfitCents < 0);
  const realizedProfitCents = sellFills.reduce((sum, fill) => sum + fill.realizedProfitCents, 0);
  const totalProfitCents = session.account.equityCents - session.initialCapitalCents;
  const averageProfitCents = profitableFills.length === 0 ? null
    : Math.round(profitableFills.reduce((sum, fill) => sum + fill.realizedProfitCents, 0) / profitableFills.length);
  const averageLossCents = losingFills.length === 0 ? null
    : Math.round(losingFills.reduce((sum, fill) => sum + Math.abs(fill.realizedProfitCents), 0) / losingFills.length);
  let peakEquityCents = session.initialCapitalCents;
  let maximumDrawdownCents = 0;
  let maximumDrawdownMillionths = 0;
  session.snapshots.forEach(({ account }) => {
    peakEquityCents = Math.max(peakEquityCents, account.equityCents);
    const drawdownCents = peakEquityCents - account.equityCents;
    const drawdownMillionths = Math.round(drawdownCents / peakEquityCents * 1_000_000);
    if (drawdownMillionths > maximumDrawdownMillionths) {
      maximumDrawdownCents = drawdownCents;
      maximumDrawdownMillionths = drawdownMillionths;
    }
  });
  return Object.freeze({
    totalProfitCents,
    realizedProfitCents,
    unrealizedProfitCents: session.position.quantity * currentBar.closeCents - session.position.totalCostCents,
    totalFeesCents: session.fills.reduce((sum, fill) => sum + fill.totalFeesCents, 0),
    returnRateMillionths: Math.round(totalProfitCents / session.initialCapitalCents * 1_000_000),
    completedTradeCount: sellFills.length,
    profitableTradeCount: profitableFills.length,
    winRateMillionths: sellFills.length === 0 ? null : Math.round(profitableFills.length / sellFills.length * 1_000_000),
    averageProfitCents,
    averageLossCents,
    profitLossRatioMillionths: averageProfitCents === null || averageLossCents === null
      ? null : Math.round(averageProfitCents / averageLossCents * 1_000_000),
    maximumDrawdownCents,
    maximumDrawdownMillionths,
  });
}

export function createTrainingSession({
  id,
  stockCode,
  stockName,
  bars,
  startIndex,
  simulationBars,
  initialCapitalCents = 10_000_000,
  randomSeed = null,
}) {
  if (!id || !stockCode || !stockName) throw sessionError("INVALID_SESSION_CONFIG", "训练标识和股票信息不能为空");
  if (!ALLOWED_SIMULATION_BARS.includes(simulationBars)) {
    throw sessionError("INVALID_SIMULATION_BARS", "模拟区间只能是150或200根日线");
  }
  if (!Number.isSafeInteger(initialCapitalCents)
    || initialCapitalCents < MIN_INITIAL_CAPITAL_CENTS
    || initialCapitalCents > MAX_INITIAL_CAPITAL_CENTS) {
    throw sessionError("INVALID_INITIAL_CAPITAL", "初始资金必须在10,000.00至10,000,000.00元之间");
  }
  if (!Array.isArray(bars)) throw sessionError("INVALID_MARKET_DATA", "日线数据不存在");
  let previousDate = null;
  bars.forEach((bar) => {
    validateBar(bar, previousDate);
    previousDate = bar.tradeDate;
  });
  if (!Number.isSafeInteger(startIndex) || startIndex < HISTORY_CONTEXT_BARS) {
    throw sessionError("INSUFFICIENT_HISTORY", "训练起点前必须有200根日线");
  }
  const endIndex = startIndex + simulationBars - 1;
  if (endIndex >= bars.length) throw sessionError("INSUFFICIENT_FUTURE_BARS", "训练起点后没有足够的模拟日线");

  const internalBars = Object.freeze(bars.map((bar) => Object.freeze({ ...bar })));
  const initialVisibleIndex = startIndex - 1;
  const initialClose = internalBars[initialVisibleIndex].closeCents;
  const session = {
    id,
    stockCode,
    stockName,
    randomSeed,
    simulationBars,
    startIndex,
    endIndex,
    visibleIndex: initialVisibleIndex,
    advancesCompleted: 0,
    version: 0,
    status: "running",
    initialCapitalCents,
    account: Object.freeze({ cashCents: initialCapitalCents, equityCents: initialCapitalCents }),
    position: Object.freeze({ quantity: 0, availableQuantity: 0, totalCostCents: 0 }),
    orders: Object.freeze([]),
    fills: Object.freeze([]),
    bars: internalBars,
    snapshots: Object.freeze([]),
  };
  session.account = Object.freeze({ ...session.account, lastPriceCents: initialClose });
  session.snapshots = Object.freeze([snapshot(session)]);
  return Object.freeze(session);
}

export function getPublicTrainingState(session) {
  const firstVisibleIndex = session.startIndex - HISTORY_CONTEXT_BARS;
  const visibleBars = session.bars.slice(firstVisibleIndex, session.visibleIndex + 1);
  const revealDates = session.status === "finished";
  const daily = Object.freeze(visibleBars.map((bar, index) => publicBar(bar, index - (HISTORY_CONTEXT_BARS - 1), revealDates)));
  const currentBar = session.bars[session.visibleIndex];
  const maximumBuyQuantity = calculateMaximumBuyQuantity({
    market: {
      closePriceCents: currentBar.closeCents,
      isSuspended: Boolean(currentBar.isSuspended),
      limitUpPriceCents: currentBar.limitUpPriceCents,
      limitDownPriceCents: currentBar.limitDownPriceCents,
    },
    account: session.account,
    position: session.position,
  });
  const performance = calculatePerformance(session, currentBar);
  const weeklyBars = aggregateWeeklyBars(visibleBars);
  const monthlyBars = aggregateMonthlyBars(visibleBars);
  return Object.freeze({
    id: session.id,
    stockCode: session.stockCode,
    stockName: session.stockName,
    status: session.status,
    datesRevealed: revealDates,
    version: session.version,
    simulationBars: session.simulationBars,
    trainingStartBarIndex: 0,
    advancesCompleted: session.advancesCompleted,
    advancesRemaining: session.simulationBars - session.advancesCompleted,
    account: Object.freeze({ ...session.account }),
    position: Object.freeze({ ...session.position }),
    maximumBuyQuantity,
    orders: Object.freeze(session.orders.map((order) => Object.freeze({ ...order }))),
    fills: Object.freeze(session.fills.map((fill) => Object.freeze({ ...fill }))),
    performance,
    indicators: Object.freeze({
      daily: calculateTechnicalIndicators(visibleBars),
      weekly: calculateTechnicalIndicators(weeklyBars),
      monthly: calculateTechnicalIndicators(monthlyBars),
    }),
    bars: Object.freeze({
      daily,
      weekly: publicAggregates(weeklyBars, revealDates),
      monthly: publicAggregates(monthlyBars, revealDates),
    }),
  });
}

export function advanceTrainingSession(session, expectedVersion) {
  assertVersion(session, expectedVersion);
  if (session.status !== "running") throw sessionError("SESSION_NOT_RUNNING", "训练已结束，不能继续推进");
  if (session.advancesCompleted >= session.simulationBars) throw sessionError("SIMULATION_COMPLETE", "模拟区间已经走完");

  const visibleIndex = session.visibleIndex + 1;
  const advancesCompleted = session.advancesCompleted + 1;
  const latestPrice = session.bars[visibleIndex].closeCents;
  const position = settleNextTradingDay(session.position);
  const account = Object.freeze({
    ...session.account,
    lastPriceCents: latestPrice,
    equityCents: session.account.cashCents + position.quantity * latestPrice,
  });
  const next = {
    ...session,
    visibleIndex,
    advancesCompleted,
    version: session.version + 1,
    status: advancesCompleted === session.simulationBars ? "finished" : "running",
    account,
    position,
  };
  next.snapshots = Object.freeze([...session.snapshots, snapshot(next)]);
  return Object.freeze(next);
}

export function rollbackTrainingSession(session, expectedVersion) {
  assertVersion(session, expectedVersion);
  if (session.status !== "running") throw sessionError("SESSION_NOT_RUNNING", "训练已结束，不能回退");
  if (session.position.quantity > 0) throw sessionError("ROLLBACK_BLOCKED_BY_POSITION", "有持仓时不能回退");
  if (session.advancesCompleted === 0) throw sessionError("ROLLBACK_AT_START", "不能回退到模拟起点之前");

  const previous = session.snapshots.at(-2);
  return Object.freeze({
    ...session,
    visibleIndex: previous.visibleIndex,
    advancesCompleted: previous.advancesCompleted,
    status: previous.status,
    account: Object.freeze({ ...previous.account }),
    position: Object.freeze({ ...previous.position }),
    orders: Object.freeze(previous.orders.map((order) => Object.freeze({ ...order }))),
    fills: Object.freeze(previous.fills.map((fill) => Object.freeze({ ...fill }))),
    version: session.version + 1,
    snapshots: Object.freeze(session.snapshots.slice(0, -1)),
  });
}

export function executeTrainingMarketOrder(session, expectedVersion, { id, fillId, side, quantity }) {
  assertVersion(session, expectedVersion);
  if (session.status !== "running") throw sessionError("SESSION_NOT_RUNNING", "训练已结束，不能交易");
  const bar = session.bars[session.visibleIndex];
  const result = executeMarketOrder({
    order: { side, orderType: "MARKET", quantity },
    market: {
      closePriceCents: bar.closeCents,
      isSuspended: Boolean(bar.isSuspended),
      limitUpPriceCents: bar.limitUpPriceCents,
      limitDownPriceCents: bar.limitDownPriceCents,
    },
    account: session.account,
    position: session.position,
  });
  if (!result.accepted) throw sessionError(result.error.code, result.error.message);
  const order = Object.freeze({ id, side, orderType: "MARKET", quantity, step: session.advancesCompleted, status: "filled" });
  const fill = Object.freeze({
    id: fillId, orderId: id, side, quantity, step: session.advancesCompleted,
    fillPriceCents: result.fill.fillPriceCents,
    grossAmountCents: result.fill.grossAmountCents,
    totalFeesCents: result.fill.totalFeesCents,
    realizedProfitCents: result.fill.realizedProfitCents,
  });
  const orders = Object.freeze([...session.orders, order]);
  const fills = Object.freeze([...session.fills, fill]);
  const account = Object.freeze({
    ...result.account,
    lastPriceCents: bar.closeCents,
    equityCents: result.account.cashCents + result.position.quantity * bar.closeCents,
  });
  const next = { ...session, version: session.version + 1, account, position: result.position, orders, fills };
  next.snapshots = Object.freeze([
    ...session.snapshots.slice(0, -1),
    snapshot(next),
  ]);
  return Object.freeze(next);
}
