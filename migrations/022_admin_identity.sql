CREATE TABLE admin_identity_operation (
 operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 response_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE admin_identity_guard (
 operation_id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid = 1)
);
