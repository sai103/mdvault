-- ノートの過去の版（編集前の内容・他デバイスでの上書き・削除）
CREATE TABLE note_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL,
  content    TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('edit', 'overwrite', 'delete', 'restore')),
  saved_at   INTEGER NOT NULL,   -- その内容が保存された時刻
  created_at INTEGER NOT NULL    -- 版として記録した時刻
);
CREATE INDEX note_revisions_path ON note_revisions (path, id);
