CREATE TABLE purchase_guest (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  player_id TEXT NOT NULL UNIQUE REFERENCES player(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE purchase_grant (
  grant_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES player(id),
  purchase_key TEXT NOT NULL REFERENCES purchase_ledger(purchase_key),
  mode TEXT NOT NULL CHECK(mode IN ('purchase','restore')),
  operation_id TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  UNIQUE(purchase_key,mode),
  UNIQUE(player_id,operation_id,mode)
);
CREATE TABLE purchase_offer_claim (
  player_id TEXT NOT NULL REFERENCES player(id),
  offer_key TEXT NOT NULL,
  purchase_key TEXT NOT NULL UNIQUE REFERENCES purchase_ledger(purchase_key),
  PRIMARY KEY(player_id,offer_key)
);
