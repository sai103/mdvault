-- 最後にパスキーで本人確認した時刻。デバイスの承認・削除やパスキーの追加・削除の前に、最近の本人確認を求める
ALTER TABLE sessions ADD COLUMN verified_at INTEGER NOT NULL DEFAULT 0;
