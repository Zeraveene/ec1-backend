CREATE TABLE liveops_news (
 id TEXT PRIMARY KEY,
 titles_json TEXT NOT NULL,
 bodies_json TEXT NOT NULL,
 publish_at INTEGER,
 expire_at INTEGER,
 pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
 draft INTEGER NOT NULL DEFAULT 1 CHECK(draft IN (0,1)),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 sort_order INTEGER NOT NULL DEFAULT 0,
 rewards_json TEXT NOT NULL DEFAULT '[]',
 revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX liveops_news_listing ON liveops_news(archived,draft,pinned DESC,sort_order,id);
CREATE TABLE liveops_news_read (
 player_id TEXT NOT NULL REFERENCES player(id),
 news_id TEXT NOT NULL REFERENCES liveops_news(id),
 read_at INTEGER NOT NULL,
 PRIMARY KEY(player_id,news_id)
);
CREATE TABLE liveops_news_operation (
 actor_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 nonce TEXT NOT NULL,
 response_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(actor_id,operation_id)
);
