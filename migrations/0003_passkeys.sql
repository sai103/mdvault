-- ログインに使うパスキー（WebAuthn の公開鍵）
CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,      -- クレデンシャル ID（base64url）
  public_key   TEXT NOT NULL,         -- COSE 形式の公開鍵（base64url）
  counter      INTEGER NOT NULL,      -- 署名カウンタ（クローン検出用）
  transports   TEXT,                  -- JSON 配列（usb / internal / hybrid など）
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

-- パスキーでログインした後のセッション。デバイスとパスキーの両方に紐づく
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,      -- Cookie に入れたトークンの SHA-256
  device_id    TEXT NOT NULL,
  passkey_id   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL       -- 使うたびに延長される
);
CREATE INDEX sessions_device ON sessions (device_id);

-- 発行中のチャレンジ（デバイス・用途ごとに 1 つ、使い捨て）
CREATE TABLE webauthn_challenges (
  device_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  challenge  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, kind)
);
