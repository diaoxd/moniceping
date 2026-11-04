export function createConditionalOrderRepository(database) {
  const insert = database.prepare(`INSERT INTO conditional_orders(id,session_id,side,trigger_direction,trigger_price_cents,quantity,created_step,status)
    VALUES (?,?,?,?,?,?,?,'pending')`);
  const list = database.prepare(`SELECT id,session_id AS sessionId,side,trigger_direction AS triggerDirection,trigger_price_cents AS triggerPriceCents,
    quantity,created_step AS createdStep,status,triggered_step AS triggeredStep,rejection_code AS rejectionCode,fill_id AS fillId
    FROM conditional_orders WHERE session_id=? ORDER BY created_at,id`);
  const pending = database.prepare(`SELECT id,session_id AS sessionId,side,trigger_direction AS triggerDirection,trigger_price_cents AS triggerPriceCents,
    quantity,created_step AS createdStep,status,triggered_step AS triggeredStep,rejection_code AS rejectionCode,fill_id AS fillId
    FROM conditional_orders WHERE session_id=? AND status='pending' ORDER BY created_at,id`);
  const cancel = database.prepare("UPDATE conditional_orders SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND session_id=? AND status='pending'");
  const cancelAll = database.prepare("UPDATE conditional_orders SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE session_id=? AND status='pending'");
  const complete = database.prepare("UPDATE conditional_orders SET status=?,triggered_step=?,rejection_code=?,fill_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'");
  const getSetting = database.prepare("SELECT require_stop_loss AS requireStopLoss FROM session_risk_settings WHERE session_id=?");
  const setSetting = database.prepare(`INSERT INTO session_risk_settings(session_id,require_stop_loss) VALUES (?,?)
    ON CONFLICT(session_id) DO UPDATE SET require_stop_loss=excluded.require_stop_loss,updated_at=CURRENT_TIMESTAMP`);
  return {
    create(order) { insert.run(order.id,order.sessionId,order.side,order.triggerDirection,order.triggerPriceCents,order.quantity,order.createdStep); return order; },
    list(sessionId) { return list.all(sessionId); },
    listPending(sessionId) { return pending.all(sessionId); },
    cancel(sessionId,id) { return cancel.run(id,sessionId).changes === 1; },
    cancelAll(sessionId) { return cancelAll.run(sessionId).changes; },
    complete(id,{status,triggeredStep,rejectionCode=null,fillId=null}) { return complete.run(status,triggeredStep,rejectionCode,fillId,id).changes === 1; },
    getRiskSettings(sessionId) { return { requireStopLoss: Boolean(getSetting.get(sessionId)?.requireStopLoss ?? 1) }; },
    setRiskSettings(sessionId,requireStopLoss) { setSetting.run(sessionId,requireStopLoss?1:0); return { requireStopLoss }; },
  };
}
