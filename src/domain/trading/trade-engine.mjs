import { calculateTradeFees, DEFAULT_FEE_RULES } from "./fees.mjs";

const RATE_DENOMINATOR = 1_000_000n;

function rejection(code, message) {
  return Object.freeze({ accepted: false, error: Object.freeze({ code, message }) });
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function roundRatio(value, numerator, denominator) {
  const result = (BigInt(value) * BigInt(numerator) + BigInt(denominator) / 2n) / BigInt(denominator);
  const number = Number(result);
  if (!Number.isSafeInteger(number)) throw Object.assign(new Error("金额超出安全范围"), { code: "MONEY_OVERFLOW" });
  return number;
}

export function calculateMarketFillPrice(closePriceCents, side, slippageRateMillionths = 0) {
  if (!Number.isSafeInteger(closePriceCents) || closePriceCents <= 0) {
    throw Object.assign(new Error("收盘价必须是正整数分"), { code: "INVALID_MARKET_PRICE" });
  }
  if (side !== "buy" && side !== "sell") {
    throw Object.assign(new Error("交易方向必须是buy或sell"), { code: "INVALID_SIDE" });
  }
  if (!Number.isSafeInteger(slippageRateMillionths) || slippageRateMillionths < 0 || slippageRateMillionths >= 1_000_000) {
    throw Object.assign(new Error("滑点必须是[0, 100%)范围内的百万分比整数"), { code: "INVALID_SLIPPAGE" });
  }

  const multiplier = side === "buy"
    ? RATE_DENOMINATOR + BigInt(slippageRateMillionths)
    : RATE_DENOMINATOR - BigInt(slippageRateMillionths);
  return Number((BigInt(closePriceCents) * multiplier + RATE_DENOMINATOR / 2n) / RATE_DENOMINATOR);
}

function validateState(account, position) {
  if (!account || !isNonNegativeSafeInteger(account.cashCents)) {
    return rejection("INVALID_ACCOUNT", "账户可用资金无效");
  }
  if (
    !position
    || !isNonNegativeSafeInteger(position.quantity)
    || !isNonNegativeSafeInteger(position.availableQuantity)
    || position.availableQuantity > position.quantity
    || !isNonNegativeSafeInteger(position.totalCostCents)
  ) {
    return rejection("INVALID_POSITION", "持仓状态无效");
  }
  return null;
}

function validateOrder(order, position) {
  if (!order || (order.side !== "buy" && order.side !== "sell")) {
    return rejection("INVALID_SIDE", "交易方向无效");
  }
  if (order.orderType !== "MARKET") {
    return rejection("UNSUPPORTED_ORDER_TYPE", "一期仅支持市价单");
  }
  if (!Number.isSafeInteger(order.quantity) || order.quantity <= 0) {
    return rejection("INVALID_QUANTITY", "交易数量必须是正整数");
  }
  if (order.side === "buy" && order.quantity % 100 !== 0) {
    return rejection("INVALID_BUY_QUANTITY", "买入数量必须是100股的整数倍");
  }
  if (order.side === "sell") {
    const sellsAllOddLot = order.quantity === position.quantity && position.quantity % 100 !== 0;
    if (order.quantity % 100 !== 0 && !sellsAllOddLot) {
      return rejection("INVALID_SELL_QUANTITY", "普通卖出须为100股整数倍，零股只能一次性全部卖出");
    }
  }
  return null;
}

function validateMarket(order, market) {
  if (!market || !Number.isSafeInteger(market.closePriceCents) || market.closePriceCents <= 0) {
    return rejection("INVALID_MARKET_PRICE", "当前收盘价无效");
  }
  if (market.isSuspended) return rejection("TRADING_SUSPENDED", "当前交易日停牌，不能交易");
  if (
    order.side === "buy"
    && Number.isSafeInteger(market.limitUpPriceCents)
    && market.closePriceCents >= market.limitUpPriceCents
  ) {
    return rejection("BUY_BLOCKED_AT_LIMIT_UP", "当前已涨停，不能买入");
  }
  if (
    order.side === "sell"
    && Number.isSafeInteger(market.limitDownPriceCents)
    && market.closePriceCents <= market.limitDownPriceCents
  ) {
    return rejection("SELL_BLOCKED_AT_LIMIT_DOWN", "当前已跌停，不能卖出");
  }
  return null;
}

export function executeMarketOrder({
  order,
  market,
  account,
  position,
  slippageRateMillionths = 0,
  feeRules = DEFAULT_FEE_RULES,
}) {
  const invalidState = validateState(account, position);
  if (invalidState) return invalidState;
  const invalidOrder = validateOrder(order, position);
  if (invalidOrder) return invalidOrder;
  const invalidMarket = validateMarket(order, market);
  if (invalidMarket) return invalidMarket;

  if (order.side === "sell") {
    if (order.quantity > position.quantity) return rejection("INSUFFICIENT_POSITION", "卖出数量超过持仓数量");
    if (order.quantity > position.availableQuantity) return rejection("T1_QUANTITY_UNAVAILABLE", "卖出数量超过当前可卖数量");
  }

  let fillPriceCents;
  try {
    fillPriceCents = calculateMarketFillPrice(market.closePriceCents, order.side, slippageRateMillionths);
  } catch (error) {
    return rejection(error.code || "INVALID_ORDER", error.message);
  }
  const grossAmountCents = fillPriceCents * order.quantity;
  if (!Number.isSafeInteger(grossAmountCents)) return rejection("MONEY_OVERFLOW", "成交金额超出安全范围");
  const fees = calculateTradeFees({ side: order.side, grossAmountCents }, feeRules);

  if (order.side === "buy") {
    const requiredCashCents = grossAmountCents + fees.totalFeesCents;
    if (requiredCashCents > account.cashCents) return rejection("INSUFFICIENT_CASH", "可用资金不足");
    const nextQuantity = position.quantity + order.quantity;
    const nextTotalCost = position.totalCostCents + requiredCashCents;
    if (![nextQuantity, nextTotalCost].every(Number.isSafeInteger)) return rejection("MONEY_OVERFLOW", "持仓金额超出安全范围");
    return Object.freeze({
      accepted: true,
      fill: Object.freeze({ side: "buy", quantity: order.quantity, fillPriceCents, ...fees, realizedProfitCents: 0 }),
      account: Object.freeze({ ...account, cashCents: account.cashCents - requiredCashCents }),
      position: Object.freeze({
        quantity: nextQuantity,
        availableQuantity: position.availableQuantity,
        totalCostCents: nextTotalCost,
      }),
    });
  }

  const allocatedCostCents = order.quantity === position.quantity
    ? position.totalCostCents
    : roundRatio(position.totalCostCents, order.quantity, position.quantity);
  const netProceedsCents = grossAmountCents - fees.totalFeesCents;
  const nextQuantity = position.quantity - order.quantity;
  return Object.freeze({
    accepted: true,
    fill: Object.freeze({
      side: "sell",
      quantity: order.quantity,
      fillPriceCents,
      ...fees,
      allocatedCostCents,
      realizedProfitCents: netProceedsCents - allocatedCostCents,
    }),
    account: Object.freeze({ ...account, cashCents: account.cashCents + netProceedsCents }),
    position: Object.freeze({
      quantity: nextQuantity,
      availableQuantity: position.availableQuantity - order.quantity,
      totalCostCents: position.totalCostCents - allocatedCostCents,
    }),
  });
}

export function calculateMaximumBuyQuantity({ market, account, position, slippageRateMillionths = 0, feeRules = DEFAULT_FEE_RULES }) {
  if (!account || !Number.isSafeInteger(account.cashCents) || account.cashCents < 0) return 0;
  let low = 0;
  let high = Math.floor(account.cashCents / market.closePriceCents / 100);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const result = executeMarketOrder({
      order: { side: "buy", orderType: "MARKET", quantity: middle * 100 },
      market, account, position, slippageRateMillionths, feeRules,
    });
    if (result.accepted) low = middle;
    else high = middle - 1;
  }
  return low * 100;
}

export function settleNextTradingDay(position) {
  if (
    !position
    || !isNonNegativeSafeInteger(position.quantity)
    || !isNonNegativeSafeInteger(position.availableQuantity)
    || position.availableQuantity > position.quantity
    || !isNonNegativeSafeInteger(position.totalCostCents)
  ) {
    throw Object.assign(new Error("持仓状态无效"), { code: "INVALID_POSITION" });
  }
  return Object.freeze({ ...position, availableQuantity: position.quantity });
}
