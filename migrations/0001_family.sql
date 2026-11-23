CREATE TABLE families (
  id TEXT PRIMARY KEY,
  pass_hash TEXT UNIQUE NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  shelf_key TEXT,
  content_bytes INTEGER NOT NULL DEFAULT 0 CHECK(content_bytes >= 0),
  media_bytes INTEGER NOT NULL DEFAULT 0 CHECK(media_bytes >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  CHECK(content_bytes + media_bytes + reserved <= 100000000)
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  family TEXT NOT NULL REFERENCES families(id),
  kid TEXT,
  expires INTEGER NOT NULL
);
CREATE INDEX session_expiry ON sessions(expires);
CREATE TABLE credentials (
  family TEXT NOT NULL REFERENCES families(id),
  provider TEXT NOT NULL,
  encrypted TEXT NOT NULL,
  PRIMARY KEY(family, provider)
);
CREATE TABLE chores (
  object_key TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  after INTEGER NOT NULL
);
CREATE INDEX chores_due ON chores(after);
