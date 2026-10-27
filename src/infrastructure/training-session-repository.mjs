function freezeCopies(items) {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

export function createTrainingSessionRepository(database) {
  const upsert = database.prepare(`
    INSERT INTO training_sessions (
      id, stock_code, stock_name, random_seed, simulation_bars, start_index, end_index,
      visible_index, advances_completed, version, status, initial_capital_cents,
      cash_cents, equity_cents, last_price_cents, position_quantity,
      available_quantity, total_cost_cents
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      visible_index=excluded.visible_index, advances_completed=excluded.advances_completed,
      version=excluded.version, status=excluded.status, cash_cents=excluded.cash_cents,
      equity_cents=excluded.equity_cents, last_price_cents=excluded.last_price_cents,
      position_quantity=excluded.position_quantity, available_quantity=excluded.available_quantity,
      total_cost_cents=excluded.total_cost_cents, updated_at=CURRENT_TIMESTAMP
  `);
  const insertSnapshot = database.prepare(`
    INSERT INTO session_snapshots (
      session_id, sequence, visible_index, advances_completed, status, cash_cents,
      equity_cents, last_price_cents, position_quantity, available_quantity, total_cost_cents,
      order_count, fill_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getSession = database.prepare("SELECT * FROM training_sessions WHERE id = ?");
  const getSnapshots = database.prepare("SELECT * FROM session_snapshots WHERE session_id = ? ORDER BY sequence");

  return {
    save(session, expectedVersion = null) {
      if (expectedVersion !== null) {
        const current = getSession.get(session.id);
        if (!current || current.version !== expectedVersion) {
          throw Object.assign(new Error("训练状态版本不一致，请刷新后重试"), { code: "VERSION_CONFLICT" });
        }
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        upsert.run(session.id, session.stockCode, session.stockName, session.randomSeed,
          session.simulationBars, session.startIndex, session.endIndex, session.visibleIndex,
          session.advancesCompleted, session.version, session.status, session.initialCapitalCents,
          session.account.cashCents, session.account.equityCents, session.account.lastPriceCents,
          session.position.quantity, session.position.availableQuantity, session.position.totalCostCents);
        database.prepare("DELETE FROM session_snapshots WHERE session_id = ?").run(session.id);
        database.prepare("DELETE FROM fills WHERE session_id = ?").run(session.id);
        database.prepare("DELETE FROM orders WHERE session_id = ?").run(session.id);
        session.orders.forEach((order, index) => database.prepare(`
          INSERT INTO orders(id, session_id, sequence, side, order_type, quantity, step, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(order.id, session.id, index + 1, order.side, order.orderType, order.quantity, order.step, order.status));
        session.fills.forEach((fill) => database.prepare(`
          INSERT INTO fills(id, order_id, session_id, side, quantity, fill_price_cents,
            gross_amount_cents, total_fees_cents, realized_profit_cents, step)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(fill.id, fill.orderId, session.id, fill.side, fill.quantity, fill.fillPriceCents,
          fill.grossAmountCents, fill.totalFeesCents, fill.realizedProfitCents, fill.step));
        session.snapshots.forEach((snapshot, sequence) => insertSnapshot.run(
          session.id, sequence, snapshot.visibleIndex, snapshot.advancesCompleted, snapshot.status,
          snapshot.account.cashCents, snapshot.account.equityCents, snapshot.account.lastPriceCents,
          snapshot.position.quantity, snapshot.position.availableQuantity, snapshot.position.totalCostCents,
          snapshot.orders.length, snapshot.fills.length,
        ));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return session;
    },
    load(id, bars) {
      const row = getSession.get(id);
      if (!row) return null;
      const orders = database.prepare(`SELECT id, side, order_type AS orderType, quantity, step, status
        FROM orders WHERE session_id = ? ORDER BY sequence`).all(id);
      const fills = database.prepare(`SELECT id, order_id AS orderId, side, quantity,
        fill_price_cents AS fillPriceCents, gross_amount_cents AS grossAmountCents,
        total_fees_cents AS totalFeesCents, realized_profit_cents AS realizedProfitCents, step
        FROM fills WHERE session_id = ? ORDER BY step, id`).all(id);
      const snapshots = getSnapshots.all(id).map((item) => Object.freeze({
        visibleIndex: item.visible_index,
        advancesCompleted: item.advances_completed,
        status: item.status,
        account: Object.freeze({ cashCents: item.cash_cents, equityCents: item.equity_cents, lastPriceCents: item.last_price_cents }),
        position: Object.freeze({ quantity: item.position_quantity, availableQuantity: item.available_quantity, totalCostCents: item.total_cost_cents }),
        orders: freezeCopies(orders.slice(0, item.order_count)), fills: freezeCopies(fills.slice(0, item.fill_count)),
      }));
      return Object.freeze({
        id: row.id, stockCode: row.stock_code, stockName: row.stock_name, randomSeed: row.random_seed,
        simulationBars: row.simulation_bars, startIndex: row.start_index, endIndex: row.end_index,
        visibleIndex: row.visible_index, advancesCompleted: row.advances_completed, version: row.version,
        status: row.status, initialCapitalCents: row.initial_capital_cents,
        account: Object.freeze({ cashCents: row.cash_cents, equityCents: row.equity_cents, lastPriceCents: row.last_price_cents }),
        position: Object.freeze({ quantity: row.position_quantity, availableQuantity: row.available_quantity, totalCostCents: row.total_cost_cents }),
        orders: freezeCopies(orders), fills: freezeCopies(fills), bars: freezeCopies(bars), snapshots: Object.freeze(snapshots),
      });
    },
  };
}
