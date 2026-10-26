PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stocks (
  stock_code TEXT PRIMARY KEY CHECK(length(stock_code) = 6),
  stock_name TEXT NOT NULL,
  market TEXT NOT NULL CHECK(market IN ('SH', 'SZ', 'BJ')),
  board_type TEXT NOT NULL CHECK(board_type IN ('MAIN', 'CHINEXT', 'STAR', 'BSE')),
  is_st INTEGER NOT NULL CHECK(is_st IN (0, 1)),
  adjust_type TEXT NOT NULL CHECK(adjust_type = 'hfq'),
  first_trade_date TEXT NOT NULL,
  last_trade_date TEXT NOT NULL,
  bar_count INTEGER NOT NULL CHECK(bar_count > 0),
  source_file TEXT NOT NULL,
  source_mtime_ns INTEGER NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(first_trade_date <= last_trade_date)
);

CREATE TABLE IF NOT EXISTS daily_bars (
  stock_code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  open_cents INTEGER NOT NULL CHECK(open_cents >= 0),
  high_cents INTEGER NOT NULL CHECK(high_cents >= open_cents AND high_cents >= close_cents),
  low_cents INTEGER NOT NULL CHECK(low_cents <= open_cents AND low_cents <= close_cents),
  close_cents INTEGER NOT NULL CHECK(close_cents >= 0),
  volume INTEGER NOT NULL CHECK(volume >= 0),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  pct_chg TEXT,
  is_suspended INTEGER NOT NULL CHECK(is_suspended IN (0, 1)),
  limit_up_price_cents INTEGER,
  limit_down_price_cents INTEGER,
  PRIMARY KEY (stock_code, trade_date),
  FOREIGN KEY (stock_code) REFERENCES stocks(stock_code) ON DELETE CASCADE,
  CHECK(high_cents >= low_cents)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_stocks_training_eligibility
  ON stocks(market, first_trade_date, last_trade_date, bar_count);

CREATE INDEX IF NOT EXISTS idx_daily_bars_trade_date
  ON daily_bars(trade_date, stock_code);
