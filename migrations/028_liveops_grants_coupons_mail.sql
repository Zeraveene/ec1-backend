-- Online delivery receipts are independent of manual gameplay backups.
CREATE TABLE liveops_grant (
 id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES player(id),
 source_type TEXT NOT NULL, source_id TEXT NOT NULL, rewards_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(player_id,source_type,source_id)
);
CREATE INDEX liveops_grant_owner ON liveops_grant(player_id,created_at DESC);
CREATE TRIGGER liveops_grant_immutable_update BEFORE UPDATE ON liveops_grant BEGIN SELECT RAISE(ABORT,'immutable_grant'); END;
CREATE TRIGGER liveops_grant_immutable_delete BEFORE DELETE ON liveops_grant BEGIN SELECT RAISE(ABORT,'immutable_grant'); END;
CREATE TABLE liveops_coupon (
 id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
 rewards_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 starts_at INTEGER, expires_at INTEGER, max_claims INTEGER CHECK(max_claims IS NULL OR max_claims>0),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE liveops_coupon_claim (
 coupon_id TEXT NOT NULL REFERENCES liveops_coupon(id), player_id TEXT NOT NULL REFERENCES player(id),
 claimed_at INTEGER NOT NULL, PRIMARY KEY(coupon_id,player_id)
);
CREATE TABLE liveops_mail (
 id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES player(id), title TEXT NOT NULL, body TEXT NOT NULL,
 rewards_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 expires_at INTEGER, read_at INTEGER, claimed_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX liveops_mail_owner ON liveops_mail(player_id,created_at DESC,id DESC);
ALTER TABLE liveops_coupon ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE liveops_coupon ADD COLUMN player_ids_json TEXT;
ALTER TABLE liveops_mail ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
CREATE TABLE liveops_admin_operation (
 id TEXT NOT NULL PRIMARY KEY, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
 operation_id TEXT NOT NULL, request_json TEXT NOT NULL,result_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(actor_id,operation,operation_id)
);
CREATE TABLE liveops_grant_ack (
 grant_id TEXT PRIMARY KEY REFERENCES liveops_grant(id), player_id TEXT NOT NULL REFERENCES player(id),
 acknowledged_at INTEGER NOT NULL
);
CREATE TABLE liveops_rate_limit (bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);

CREATE INDEX liveops_rate_limit_expiry ON liveops_rate_limit(expires_at);
