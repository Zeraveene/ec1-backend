CREATE TABLE save_revision (
 player_id TEXT NOT NULL REFERENCES player(id), version INTEGER NOT NULL, r2_key TEXT NOT NULL,
 sha256 TEXT NOT NULL, playtime REAL NOT NULL, operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(player_id,version)
);
CREATE TABLE save_operation (
 player_id TEXT NOT NULL REFERENCES player(id), operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 version INTEGER NOT NULL, PRIMARY KEY(player_id,operation_id),
 FOREIGN KEY(player_id,version) REFERENCES save_revision(player_id,version)
);
CREATE TABLE mail (
 id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES player(id), title TEXT NOT NULL, body TEXT NOT NULL,
 rewards_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
 read_at INTEGER, claimed_at INTEGER, grant_id TEXT
);
CREATE INDEX mail_player ON mail(player_id,created_at);
CREATE TABLE grant_receipt (
 player_id TEXT NOT NULL REFERENCES player(id), source_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 save_version INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(player_id,source_id),
 FOREIGN KEY(player_id,save_version) REFERENCES save_revision(player_id,version)
);
CREATE TABLE game_config (key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE coupon (code TEXT PRIMARY KEY,rewards_json TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,expires_at INTEGER);
CREATE TABLE migration_record (
 player_id TEXT PRIMARY KEY REFERENCES player(id), status TEXT NOT NULL, cloud_archive TEXT, local_archive TEXT,
 winner TEXT, save_version INTEGER, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE migration_identity_proof (
 player_id TEXT PRIMARY KEY REFERENCES player(id), google_subject TEXT, email TEXT, custom_id_hash TEXT,
 created_at INTEGER NOT NULL
);
CREATE TABLE player_leaderboard (
 player_id TEXT PRIMARY KEY REFERENCES player(id),score INTEGER NOT NULL,save_version INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,FOREIGN KEY(player_id,save_version) REFERENCES save_revision(player_id,version)
);
CREATE INDEX fortress_ranking ON player_leaderboard(score DESC,player_id);
