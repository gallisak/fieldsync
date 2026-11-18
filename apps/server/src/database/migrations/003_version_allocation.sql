UPDATE sync_state SET last_version = GREATEST(last_version, (SELECT COALESCE(max(version), 0) FROM change_log));
ALTER TABLE change_log ALTER COLUMN version DROP DEFAULT;
DROP SEQUENCE change_log_version_seq;
UPDATE change_log SET tx_seq = version WHERE tx_seq = 0;
ALTER TABLE change_log ALTER COLUMN tx_seq DROP DEFAULT;
