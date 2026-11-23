ALTER TABLE sessions ADD COLUMN adult TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE families ADD COLUMN profile_count INTEGER NOT NULL DEFAULT 20;
ALTER TABLE families ADD COLUMN personal_login INTEGER NOT NULL DEFAULT 0;
CREATE TABLE adult_accounts (
 family TEXT NOT NULL REFERENCES families(id), id TEXT NOT NULL, name TEXT NOT NULL,
 pass_hash TEXT UNIQUE NOT NULL, pending INTEGER NOT NULL, expires INTEGER NOT NULL,
 PRIMARY KEY(family,id)
);
CREATE TABLE service_configs (
 family TEXT NOT NULL REFERENCES families(id), id TEXT NOT NULL, owner TEXT NOT NULL,
 provider TEXT NOT NULL, type TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL,
 shared INTEGER NOT NULL, daily INTEGER NOT NULL, monthly INTEGER NOT NULL, per_story INTEGER NOT NULL,
 encrypted TEXT NOT NULL, PRIMARY KEY(family,id)
);
ALTER TABLE generation ADD COLUMN actor TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE generation ADD COLUMN config TEXT NOT NULL DEFAULT '';
ALTER TABLE generation ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
CREATE TABLE service_usage (
 family TEXT NOT NULL, config TEXT NOT NULL, units INTEGER NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX service_usage_date ON service_usage(family,config,created);
CREATE TRIGGER service_budget BEFORE INSERT ON generation WHEN NEW.config <> '' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM service_configs c WHERE c.family=NEW.family AND c.id=NEW.config
 AND (c.owner=NEW.actor OR c.shared=1)
 AND (c.per_story=0 OR length(NEW.input)<=c.per_story)
 AND (c.daily=0 OR c.daily>(SELECT count(*) FROM service_usage u WHERE u.family=c.family AND u.config=c.id AND u.created>=unixepoch('now','start of day')))
 AND (c.monthly=0 OR c.monthly>=length(NEW.input)+(SELECT coalesce(sum(units),0) FROM service_usage u WHERE u.family=c.family AND u.config=c.id AND u.created>=unixepoch('now','start of month'))))
 THEN RAISE(ABORT,'service_budget') END;
END;
CREATE TRIGGER service_charge AFTER INSERT ON generation WHEN NEW.config <> '' BEGIN
 INSERT INTO service_usage VALUES(NEW.family,NEW.config,length(NEW.input),unixepoch());
END;
