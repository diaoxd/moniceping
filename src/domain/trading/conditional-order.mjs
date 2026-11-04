function conditionalError(code, message) { return Object.assign(new Error(message), { code }); }

export function createConditionalOrder({ id, sessionId, side, triggerDirection, triggerPriceCents, quantity, createdStep }) {
  if (!id || !sessionId) throw conditionalError("INVALID_CONDITIONAL_ORDER", "条件单标识不能为空");
  if (!["buy", "sell"].includes(side)) throw conditionalError("INVALID_SIDE", "条件单方向无效");
  if (!["cross_up", "cross_down"].includes(triggerDirection)) throw conditionalError("INVALID_TRIGGER_DIRECTION", "触发方式必须是上穿或下穿");
  if (!Number.isSafeInteger(triggerPriceCents) || triggerPriceCents <= 0) throw conditionalError("INVALID_TRIGGER_PRICE", "监控价格必须大于0");
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw conditionalError("INVALID_QUANTITY", "委托数量必须是正整数");
  if (side === "buy" && quantity % 100 !== 0) throw conditionalError("INVALID_BUY_QUANTITY", "买入数量必须是100股整数倍");
  if (side === "sell" && quantity % 100 !== 0) throw conditionalError("INVALID_SELL_QUANTITY", "条件卖出数量必须是100股整数倍");
  if (!Number.isSafeInteger(createdStep) || createdStep < 0) throw conditionalError("INVALID_CREATED_STEP", "创建步骤无效");
  return Object.freeze({ id, sessionId, side, triggerDirection, triggerPriceCents, quantity, createdStep, status: "pending" });
}

export function isConditionalOrderTriggered(order, previousBar, currentBar, currentStep) {
  if (order.status !== "pending" || currentStep <= order.createdStep) return false;
  if (order.triggerDirection === "cross_up") return previousBar.closeCents < order.triggerPriceCents && currentBar.highCents >= order.triggerPriceCents;
  return previousBar.closeCents > order.triggerPriceCents && currentBar.lowCents <= order.triggerPriceCents;
}

export function requiredStopLossCoverage(positionQuantity, pendingOrders) {
  const covered = pendingOrders.filter((order) => order.status === "pending" && order.side === "sell" && order.triggerDirection === "cross_down")
    .reduce((sum, order) => sum + order.quantity, 0);
  return { required: positionQuantity, covered, missing: Math.max(0, positionQuantity - covered) };
}
