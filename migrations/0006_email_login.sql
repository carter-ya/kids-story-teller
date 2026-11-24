CREATE TABLE email_accounts (
  email TEXT PRIMARY KEY NOT NULL,
  family TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  adult TEXT NOT NULL,
  UNIQUE(family,adult)
);
CREATE TRIGGER forget_adult_email AFTER DELETE ON adult_accounts BEGIN
  DELETE FROM email_accounts WHERE family=OLD.family AND adult=OLD.id;
END;
CREATE TABLE email_challenges (
  email TEXT PRIMARY KEY NOT NULL,
  id TEXT UNIQUE NOT NULL,
  digest TEXT NOT NULL,
  sent INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX email_challenge_age ON email_challenges(sent);
CREATE TABLE email_send_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL
);
CREATE INDEX email_limit_age ON email_send_limits(expires);
