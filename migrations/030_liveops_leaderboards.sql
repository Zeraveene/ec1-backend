-- Explicit online Classic scores, independent from gameplay backup revisions.
CREATE TABLE classic_leaderboard_board (
 id TEXT PRIMARY KEY, season INTEGER NOT NULL CHECK(season>0), version INTEGER NOT NULL CHECK(version>0),
 paused INTEGER NOT NULL CHECK(paused IN (0,1)), updated_at INTEGER NOT NULL, last_operation TEXT
);
INSERT INTO classic_leaderboard_board VALUES ('infinity_fortress',1,1,1,0,NULL);
CREATE TABLE classic_leaderboard_entry (
 board_id TEXT NOT NULL REFERENCES classic_leaderboard_board(id), season INTEGER NOT NULL,
 player_id TEXT NOT NULL REFERENCES player(id), score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 2147483647),
 character INTEGER NOT NULL CHECK(character BETWEEN 0 AND 3), floor INTEGER NOT NULL CHECK(floor BETWEEN 1 AND 2147),
 cleartime INTEGER NOT NULL CHECK(cleartime BETWEEN 0 AND 99999), updated_at INTEGER NOT NULL,
 PRIMARY KEY(board_id,season,player_id)
);
CREATE INDEX classic_leaderboard_rank ON classic_leaderboard_entry(board_id,season,score DESC,player_id ASC);
CREATE TABLE classic_leaderboard_submission (
 board_id TEXT NOT NULL, season INTEGER NOT NULL, player_id TEXT NOT NULL REFERENCES player(id),
 operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(board_id,season,player_id,operation_id)
);
CREATE TABLE classic_leaderboard_history (
 id TEXT PRIMARY KEY, board_id TEXT NOT NULL, operation TEXT NOT NULL, payload_hash TEXT NOT NULL, season INTEGER NOT NULL, version INTEGER NOT NULL,
 paused INTEGER NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX classic_leaderboard_history_order ON classic_leaderboard_history(created_at DESC,id DESC);
