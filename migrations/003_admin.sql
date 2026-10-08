CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  player_id TEXT,
  detail_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit(created_at DESC);
CREATE TABLE IF NOT EXISTS admin_oauth_state (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS admin_session (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS admin_oauth_expiry ON admin_oauth_state(expires_at);
CREATE INDEX IF NOT EXISTS admin_session_expiry ON admin_session(expires_at);
