import { HISTORY_CONTEXT_BARS } from "../domain/session/training-session.mjs";

export function loadTrainingStocks(database, { simulationBars, minimumStartDate = "2021-01-01" } = {}) {
  if (![150, 200].includes(simulationBars)) {
    throw Object.assign(new Error("模拟区间只能是150或200根"), { code: "INVALID_SIMULATION_BARS" });
  }
  const stocks = database.prepare(`
    SELECT stock_code AS stockCode, stock_name AS stockName, market, board_type AS boardType
    FROM stocks
    WHERE market IN ('SH', 'SZ', 'BJ')
    ORDER BY stock_code
  `).all();
  const barsStatement = database.prepare(`
    SELECT
      trade_date AS tradeDate,
      open_cents AS openCents,
      high_cents AS highCents,
      low_cents AS lowCents,
      close_cents AS closeCents,
      volume,
      amount_cents AS amountCents,
      pct_chg AS pctChg,
      is_suspended AS isSuspended,
      limit_up_price_cents AS limitUpPriceCents,
      limit_down_price_cents AS limitDownPriceCents
    FROM daily_bars
    WHERE stock_code = ?
    ORDER BY trade_date
  `);
  return stocks.map((stock) => ({
    ...stock,
    bars: barsStatement.all(stock.stockCode).map((bar) => ({
      ...bar,
      isSuspended: Boolean(bar.isSuspended),
    })),
  })).filter((stock) => stock.bars.length >= HISTORY_CONTEXT_BARS + simulationBars
    && stock.bars.some((bar, index) => index >= HISTORY_CONTEXT_BARS
      && index + simulationBars <= stock.bars.length
      && bar.tradeDate >= minimumStartDate));
}

export function loadTrainingStock(database, stockCode) {
  const stock = database.prepare(`
    SELECT stock_code AS stockCode, stock_name AS stockName, market, board_type AS boardType
    FROM stocks WHERE stock_code = ? AND market IN ('SH', 'SZ', 'BJ')
  `).get(stockCode);
  if (!stock) return null;
  const bars = database.prepare(`
    SELECT trade_date AS tradeDate, open_cents AS openCents, high_cents AS highCents,
      low_cents AS lowCents, close_cents AS closeCents, volume, amount_cents AS amountCents,
      pct_chg AS pctChg, is_suspended AS isSuspended,
      limit_up_price_cents AS limitUpPriceCents, limit_down_price_cents AS limitDownPriceCents
    FROM daily_bars WHERE stock_code = ? ORDER BY trade_date
  `).all(stockCode).map((bar) => ({ ...bar, isSuspended: Boolean(bar.isSuspended) }));
  return { ...stock, bars };
}
