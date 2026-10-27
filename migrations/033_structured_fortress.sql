-- Rank structured records directly. Existing accepted packed values were bounded
-- to floor <=2147 and time <100000, so their receipt records decode exactly.
CREATE TABLE classic_leaderboard_entry_structured (
 board_id TEXT NOT NULL REFERENCES classic_leaderboard_board(id), season INTEGER NOT NULL,
 player_id TEXT NOT NULL REFERENCES player(id),
 character INTEGER NOT NULL CHECK(character BETWEEN 0 AND 3),
 floor INTEGER NOT NULL CHECK(floor BETWEEN 1 AND 2147483647),
 cleartime INTEGER NOT NULL CHECK(cleartime BETWEEN 0 AND 2147483647), updated_at INTEGER NOT NULL,
 PRIMARY KEY(board_id,season,player_id)
);
INSERT INTO classic_leaderboard_entry_structured SELECT board_id,season,player_id,character,floor,cleartime,updated_at FROM classic_leaderboard_entry;
DROP TABLE classic_leaderboard_entry;
ALTER TABLE classic_leaderboard_entry_structured RENAME TO classic_leaderboard_entry;
CREATE INDEX classic_leaderboard_rank ON classic_leaderboard_entry(board_id,season,floor DESC,cleartime ASC,character DESC,player_id ASC);

CREATE TABLE classic_leaderboard_submission_structured (
 board_id TEXT NOT NULL, season INTEGER NOT NULL, player_id TEXT NOT NULL REFERENCES player(id),
 operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 character INTEGER NOT NULL CHECK(character BETWEEN 0 AND 3),
 floor INTEGER NOT NULL CHECK(floor BETWEEN 1 AND 2147483647),
 cleartime INTEGER NOT NULL CHECK(cleartime BETWEEN 0 AND 2147483647), created_at INTEGER NOT NULL,
 PRIMARY KEY(board_id,season,player_id,operation_id)
);
INSERT INTO classic_leaderboard_submission_structured
 SELECT board_id,season,player_id,operation_id,payload_hash,score%10,
 (score-score%10+999999)/1000000,
 (((score-score%10+999999)/1000000)*1000000-score+score%10)/10,created_at
 FROM classic_leaderboard_submission;
DROP TABLE classic_leaderboard_submission;
ALTER TABLE classic_leaderboard_submission_structured RENAME TO classic_leaderboard_submission;

-- Retain the old save-linked API's rows without retaining packed ranking logic.
CREATE TABLE player_leaderboard_structured (
 player_id TEXT PRIMARY KEY REFERENCES player(id),
 character INTEGER NOT NULL CHECK(character BETWEEN 0 AND 3),
 floor INTEGER NOT NULL CHECK(floor BETWEEN 0 AND 2147483647),
 cleartime INTEGER NOT NULL CHECK(cleartime BETWEEN 0 AND 2147483647),
 save_version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 FOREIGN KEY(player_id,save_version) REFERENCES save_revision(player_id,version)
);
INSERT INTO player_leaderboard_structured
 SELECT player_id,CASE WHEN score>0 THEN score%10 ELSE 0 END,
 CASE WHEN score>0 THEN (score-score%10+999999)/1000000 ELSE 0 END,
 CASE WHEN score>0 THEN (((score-score%10+999999)/1000000)*1000000-score+score%10)/10 ELSE 0 END,
 save_version,updated_at FROM player_leaderboard;
DROP TABLE player_leaderboard;
ALTER TABLE player_leaderboard_structured RENAME TO player_leaderboard;
CREATE INDEX fortress_ranking ON player_leaderboard(floor DESC,cleartime ASC,character DESC,player_id ASC);
