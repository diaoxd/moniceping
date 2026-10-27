PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS training_sessions (
  id TEXT PRIMARY KEY,
  stock_code TEXT NOT NULL CHECK(length(stock_code) = 6),
  stock_name TEXT NOT NULL,
  random_seed TEXT,
  simulation_bars INTEGER NOT NULL CHECK(simulation_bars IN (150, 200)),
  start_index INTEGER NOT NULL CHECK(start_index >= 200),
  end_index INTEGER NOT NULL,
  visible_index INTEGER NOT NULL,
  advances_completed INTEGER NOT NULL CHECK(advances_completed >= 0),
  version INTEGER NOT NULL CHECK(version >= 0),
  status TEXT NOT NULL CHECK(status IN ('running', 'finished')),
  initial_capital_cents INTEGER NOT NULL CHECK(initial_capital_cents > 0),
  cash_cents INTEGER NOT NULL CHECK(cash_cents >= 0),
  equity_cents INTEGER NOT NULL CHECK(equity_cents >= 0),
  last_price_cents INTEGER NOT NULL CHECK(last_price_cents > 0),
  position_quantity INTEGER NOT NULL CHECK(position_quantity >= 0),
  available_quantity INTEGER NOT NULL CHECK(available_quantity >= 0 AND available_quantity <= position_quantity),
  total_cost_cents INTEGER NOT NULL CHECK(total_cost_cents >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(end_index = start_index + simulation_bars - 1),
  CHECK(advances_completed <= simulation_bars)
);

CREATE TABLE IF NOT EXISTS session_snapshots (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  visible_index INTEGER NOT NULL,
  advances_completed INTEGER NOT NULL CHECK(advances_completed >= 0),
  status TEXT NOT NULL CHECK(status IN ('running', 'finished')),
  cash_cents INTEGER NOT NULL CHECK(cash_cents >= 0),
  equity_cents INTEGER NOT NULL CHECK(equity_cents >= 0),
  last_price_cents INTEGER NOT NULL CHECK(last_price_cents > 0),
  position_quantity INTEGER NOT NULL CHECK(position_quantity >= 0),
  available_quantity INTEGER NOT NULL CHECK(available_quantity >= 0 AND available_quantity <= position_quantity),
  total_cost_cents INTEGER NOT NULL CHECK(total_cost_cents >= 0),
  PRIMARY KEY (session_id, sequence),
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  order_type TEXT NOT NULL CHECK(order_type = 'MARKET'),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  step INTEGER NOT NULL CHECK(step >= 0),
  status TEXT NOT NULL CHECK(status IN ('filled', 'rejected')),
  rejection_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE,
  UNIQUE (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  fill_price_cents INTEGER NOT NULL CHECK(fill_price_cents > 0),
  gross_amount_cents INTEGER NOT NULL CHECK(gross_amount_cents > 0),
  total_fees_cents INTEGER NOT NULL CHECK(total_fees_cents >= 0),
  realized_profit_cents INTEGER NOT NULL,
  step INTEGER NOT NULL CHECK(step >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_sessions_updated ON training_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_session_sequence ON orders(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_fills_session_step ON fills(session_id, step);
