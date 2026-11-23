ALTER TABLE generation ADD COLUMN retry_token TEXT NOT NULL DEFAULT '';
ALTER TABLE generation ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation ADD COLUMN remaining_chars INTEGER NOT NULL DEFAULT 0;
CREATE TABLE covers (
 family TEXT NOT NULL REFERENCES families(id), id TEXT NOT NULL, bytes INTEGER NOT NULL, touched INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(family,id)
);
CREATE TRIGGER cover_insert AFTER INSERT ON covers BEGIN
 UPDATE families SET media_bytes=media_bytes+NEW.bytes WHERE id=NEW.family;
END;
CREATE TRIGGER cover_delete AFTER DELETE ON covers BEGIN
 UPDATE families SET media_bytes=media_bytes-OLD.bytes WHERE id=OLD.family;
END;
CREATE TABLE erased_families (family TEXT PRIMARY KEY, sweep INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TRIGGER retry_budget BEFORE UPDATE OF status ON generation WHEN OLD.status='failed' AND NEW.status='queued' AND NEW.config<>'' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM service_configs c WHERE c.family=NEW.family AND c.id=NEW.config AND (c.owner=NEW.actor OR c.shared=1)
 AND (c.daily=0 OR c.daily>(SELECT count(*) FROM service_usage u WHERE u.family=c.family AND u.config=c.id AND u.created>=unixepoch('now','start of day')))
 AND (c.monthly=0 OR c.monthly>=NEW.remaining_chars+(SELECT coalesce(sum(units),0) FROM service_usage u WHERE u.family=c.family AND u.config=c.id AND u.created>=unixepoch('now','start of month'))))
 THEN RAISE(ABORT,'service_budget') END;
 INSERT INTO service_usage VALUES(NEW.family,NEW.config,NEW.remaining_chars,unixepoch());
END;
