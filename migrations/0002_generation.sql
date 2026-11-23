CREATE TABLE generation (
  family TEXT NOT NULL REFERENCES families(id), id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL,
  model TEXT NOT NULL, style TEXT NOT NULL, input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', result TEXT NOT NULL DEFAULT '',
  reserve INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
  touched INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(family,id)
);
CREATE INDEX generation_pending ON generation(status,touched);
CREATE TRIGGER generation_insert AFTER INSERT ON generation BEGIN
  UPDATE families SET reserved=reserved+NEW.reserve WHERE id=NEW.family;
END;
CREATE TRIGGER generation_updated AFTER UPDATE OF reserve,bytes ON generation BEGIN
  UPDATE families SET reserved=reserved+NEW.reserve-OLD.reserve,media_bytes=media_bytes+NEW.bytes-OLD.bytes WHERE id=NEW.family;
END;
CREATE TRIGGER generation_deleted AFTER DELETE ON generation BEGIN
  UPDATE families SET reserved=reserved-OLD.reserve,media_bytes=media_bytes-OLD.bytes WHERE id=OLD.family;
END;
