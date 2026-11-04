CREATE TABLE IF NOT EXISTS conditional_orders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy','sell')),
  trigger_direction TEXT NOT NULL CHECK(trigger_direction IN ('cross_up','cross_down')),
  trigger_price_cents INTEGER NOT NULL CHECK(trigger_price_cents > 0),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  created_step INTEGER NOT NULL CHECK(created_step >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending','filled','cancelled','rejected')),
  triggered_step INTEGER,
  rejection_code TEXT,
  fill_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES training_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(fill_id) REFERENCES fills(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_conditional_orders_session_status ON conditional_orders(session_id,status,created_step);

CREATE TABLE IF NOT EXISTS session_risk_settings (
  session_id TEXT PRIMARY KEY,
  require_stop_loss INTEGER NOT NULL DEFAULT 1 CHECK(require_stop_loss IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES training_sessions(id) ON DELETE CASCADE
);
