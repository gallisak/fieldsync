-- Part of every cursor's fingerprint. After restoring a backup, set a new one so that clients which saw the lost
-- versions take a snapshot instead of skipping the reused ones: UPDATE sync_state SET epoch = gen_random_uuid();
ALTER TABLE sync_state ADD COLUMN epoch uuid NOT NULL DEFAULT gen_random_uuid();
