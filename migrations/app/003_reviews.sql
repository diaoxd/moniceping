CREATE TABLE IF NOT EXISTS training_reviews (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  selected_fill_id TEXT,
  start_step INTEGER NOT NULL CHECK(start_step >= 0),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 5000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (selected_fill_id) REFERENCES fills(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS review_step_notes (
  review_id TEXT NOT NULL,
  step INTEGER NOT NULL CHECK(step >= 0),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (review_id, step),
  FOREIGN KEY (review_id) REFERENCES training_reviews(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_training_reviews_session ON training_reviews(session_id, created_at DESC);
