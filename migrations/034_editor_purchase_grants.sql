CREATE TABLE purchase_editor_grant (
  grant_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES player(id),
  operation_id TEXT NOT NULL,
  purchase_key TEXT NOT NULL UNIQUE REFERENCES purchase_ledger(purchase_key),
  product_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('google','apple')),
  grant_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  UNIQUE(player_id,operation_id)
);
