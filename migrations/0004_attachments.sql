-- 添付ファイル（画像）。本体は R2、ここにはメタデータだけを置く
CREATE TABLE attachments (
  path         TEXT PRIMARY KEY,       -- 例: "attachments/Pasted image 20261025093000.png"（R2 のキーと同じ）
  content_type TEXT NOT NULL,          -- ファイル先頭のバイト列から判定した MIME タイプ
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
