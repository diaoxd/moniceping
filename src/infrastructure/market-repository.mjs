import { HISTORY_CONTEXT_BARS } from "../domain/session/training-session.mjs";

const REQUIRED_MARKET_COLUMNS = Object.freeze({
  stocks: ["stock_code", "stock_name", "market", "board_type"],
  daily_bars: ["stock_code", "trade_date", "open_cents", "high_cents", "low_cents", "close_cents", "volume", "amount_cents"],
});

export function validateMarketDatabaseSchema(database) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const [table, requiredColumns] of Object.entries(REQUIRED_MARKET_COLUMNS)) {
    if (!tables.has(table)) {
      throw Object.assign(new Error(`行情数据库缺少${table}表，请先执行行情导入`), { code: "MARKET_SCHEMA_INVALID" });
    }
    const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    const missingColumns = requiredColumns.filter((column) => !columns.has(column));
    if (missingColumns.length > 0) {
      throw Object.assign(new Error(`行情数据库${table}表缺少字段：${missingColumns.join(", ")}`), { code: "MARKET_SCHEMA_INVALID" });
    }
  }
  return true;
}

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

export function loadTrainingRanges(database, { simulationBars, minimumStartDate = "2021-01-01" } = {}) {
  if (![150, 200].includes(simulationBars)) {
    throw Object.assign(new Error("模拟区间只能是150或200根"), { code: "INVALID_SIMULATION_BARS" });
  }
  return database.prepare(`
    WITH bar_stats AS (
      SELECT stock_code, COUNT(*) AS total_bars,
        SUM(CASE WHEN trade_date < ? THEN 1 ELSE 0 END) AS bars_before_start_date
      FROM daily_bars
      GROUP BY stock_code
    ), candidate_ranges AS (
      SELECT stock_code, total_bars,
        MAX(?, bars_before_start_date) AS first_start_index
      FROM bar_stats
    )
    SELECT s.stock_code AS stockCode, s.stock_name AS stockName,
      s.market, s.board_type AS boardType,
      r.first_start_index AS firstStartIndex,
      r.total_bars - ? - r.first_start_index + 1 AS eligibleCount
    FROM candidate_ranges r
    JOIN stocks s ON s.stock_code = r.stock_code
    WHERE s.market IN ('SH', 'SZ', 'BJ')
      AND r.total_bars - ? - r.first_start_index + 1 > 0
    ORDER BY s.stock_code
  `).all(minimumStartDate, HISTORY_CONTEXT_BARS, simulationBars, simulationBars);
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
