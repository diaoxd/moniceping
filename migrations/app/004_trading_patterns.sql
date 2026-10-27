CREATE TABLE IF NOT EXISTS trading_patterns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  category TEXT NOT NULL CHECK(category IN ('open_position','add_position','reduce_position','close_position')),
  display_period TEXT NOT NULL CHECK(display_period IN ('daily','weekly','monthly')),
  trigger_conditions TEXT NOT NULL CHECK(length(trigger_conditions) BETWEEN 1 AND 2000),
  kline_features TEXT NOT NULL DEFAULT '' CHECK(length(kline_features) <= 2000),
  indicator_features TEXT NOT NULL DEFAULT '' CHECK(length(indicator_features) <= 2000),
  volume_features TEXT NOT NULL DEFAULT '' CHECK(length(volume_features) <= 2000),
  market_context TEXT NOT NULL DEFAULT '' CHECK(length(market_context) <= 2000),
  invalidation_conditions TEXT NOT NULL CHECK(length(invalidation_conditions) BETWEEN 1 AND 2000),
  risk_notes TEXT NOT NULL DEFAULT '' CHECK(length(risk_notes) <= 2000),
  confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 5),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pattern_evidence (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  fill_id TEXT,
  start_step INTEGER NOT NULL CHECK(start_step >= 0),
  end_step INTEGER NOT NULL CHECK(end_step >= start_step),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 2000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pattern_id) REFERENCES trading_patterns(id) ON DELETE CASCADE,
  FOREIGN KEY (review_id) REFERENCES training_reviews(id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (fill_id) REFERENCES fills(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_patterns_category ON trading_patterns(category, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pattern_evidence_pattern ON pattern_evidence(pattern_id, created_at);
