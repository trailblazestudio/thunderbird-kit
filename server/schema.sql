CREATE TABLE IF NOT EXISTS pixels (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS pixels_created ON pixels (created_at);
CREATE TABLE IF NOT EXISTS opens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  ts INTEGER NOT NULL,
  country TEXT,
  city TEXT,
  client TEXT,
  auto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS opens_token ON opens (token);
