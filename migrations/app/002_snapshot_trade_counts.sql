ALTER TABLE session_snapshots ADD COLUMN order_count INTEGER NOT NULL DEFAULT 0 CHECK(order_count >= 0);
ALTER TABLE session_snapshots ADD COLUMN fill_count INTEGER NOT NULL DEFAULT 0 CHECK(fill_count >= 0);
