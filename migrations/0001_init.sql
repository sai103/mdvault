-- 接続を許可したデバイス（承認待ちも含む）
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,   -- Cookie に入れたトークンの SHA-256
  name         TEXT NOT NULL,
  user_agent   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  pair_code    TEXT,                   -- 承認時に照合する 6 桁コード
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- ブートストラップシークレットの失敗記録（総当たり対策）
CREATE TABLE auth_failures (
  ts INTEGER NOT NULL
);

CREATE TABLE notes (
  path       TEXT PRIMARY KEY,         -- 例: "folder/Note.md"
  content    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- [[wikilink]] の参照関係（バックリンク用）。dst は正規化済みのリンク先名
CREATE TABLE links (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  PRIMARY KEY (src, dst)
);
CREATE INDEX links_dst ON links (dst);
