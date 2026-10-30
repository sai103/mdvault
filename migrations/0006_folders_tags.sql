-- 明示的に作ったフォルダ（中身が空でも残る）。ノートのパスから分かるフォルダはここに無くても表示される
CREATE TABLE folders (
  path       TEXT PRIMARY KEY,   -- 例: "Projects/2026"（末尾の / なし）
  created_at INTEGER NOT NULL
);

-- #タグ（小文字に正規化）。保存のたびに本文から作り直す
CREATE TABLE tags (
  src TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (src, tag)
);
CREATE INDEX tags_tag ON tags (tag);

-- 履歴の理由に rename（リンクの書き換え前）と import（取り込みで上書きする前）を追加する。
-- SQLite は CHECK 制約を変更できないので、作り直してコピーする
CREATE TABLE note_revisions_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL,
  content    TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('edit', 'overwrite', 'delete', 'restore', 'rename', 'import')),
  saved_at   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO note_revisions_new (id, path, content, reason, saved_at, created_at)
  SELECT id, path, content, reason, saved_at, created_at FROM note_revisions;
DROP TABLE note_revisions;
ALTER TABLE note_revisions_new RENAME TO note_revisions;
CREATE INDEX note_revisions_path ON note_revisions (path, id);
