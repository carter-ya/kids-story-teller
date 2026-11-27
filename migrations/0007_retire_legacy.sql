-- Retire only households with no verified mailbox. Keep a tombstone so the
-- existing R2 sweeper also removes objects from interrupted writes.
CREATE TABLE retiring_households (id TEXT PRIMARY KEY);
INSERT INTO retiring_households SELECT id FROM families f
WHERE NOT EXISTS (SELECT 1 FROM email_accounts e WHERE e.family=f.id);
INSERT OR IGNORE INTO erased_families SELECT id,unixepoch(),unixepoch()+86400 FROM retiring_households;
DELETE FROM sessions WHERE family IN (SELECT id FROM retiring_households);
DELETE FROM service_configs WHERE family IN (SELECT id FROM retiring_households);
DELETE FROM adult_accounts WHERE family IN (SELECT id FROM retiring_households);
DELETE FROM service_usage WHERE family IN (SELECT id FROM retiring_households);
DELETE FROM generation WHERE family IN (SELECT id FROM retiring_households);
DELETE FROM covers WHERE family IN (SELECT id FROM retiring_households);
DELETE FROM credentials WHERE family IN (SELECT id FROM retiring_households);
DELETE FROM chores WHERE family IN (SELECT id FROM retiring_households);
DELETE FROM families WHERE id IN (SELECT id FROM retiring_households);
DROP TABLE retiring_households;
-- A migrated family may still have an adult using only a retired credential.
DELETE FROM sessions WHERE NOT EXISTS
  (SELECT 1 FROM email_accounts e WHERE e.family=sessions.family AND e.adult=sessions.adult);
DELETE FROM service_configs WHERE owner<>'owner' AND EXISTS
  (SELECT 1 FROM adult_accounts a WHERE a.family=service_configs.family AND a.id=service_configs.owner AND a.pending=0)
  AND NOT EXISTS (SELECT 1 FROM email_accounts e WHERE e.family=service_configs.family AND e.adult=service_configs.owner);
DELETE FROM adult_accounts WHERE pending=0 AND NOT EXISTS
  (SELECT 1 FROM email_accounts e WHERE e.family=adult_accounts.family AND e.adult=adult_accounts.id);
