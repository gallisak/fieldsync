-- Versions are now allocated from sync_state inside the writing transaction (commit order), not from a sequence.
UPDATE sync_state SET last_version = GREATEST(last_version, (SELECT COALESCE(max(version), 0) FROM change_log));
ALTER TABLE change_log ALTER COLUMN version DROP DEFAULT;
DROP SEQUENCE change_log_version_seq;
-- Rows written before v2 have no transaction grouping; treat each as its own, or they would form one huge
-- transaction that pull must never split across pages.
UPDATE change_log SET tx_seq = version WHERE tx_seq = 0;
ALTER TABLE change_log ALTER COLUMN tx_seq DROP DEFAULT;
