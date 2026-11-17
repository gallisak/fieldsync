-- Versions are now allocated from sync_state inside the writing transaction (commit order), not from a sequence.
UPDATE sync_state SET last_version = GREATEST(last_version, (SELECT COALESCE(max(version), 0) FROM change_log));
ALTER TABLE change_log ALTER COLUMN version DROP DEFAULT;
DROP SEQUENCE change_log_version_seq;
ALTER TABLE change_log ALTER COLUMN tx_seq DROP DEFAULT;
