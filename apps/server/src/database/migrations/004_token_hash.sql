-- Only a hash of each token is kept: a leaked database or backup no longer hands out working credentials (F11).
ALTER TABLE users ADD COLUMN token_hash bytea;
UPDATE users SET token_hash = sha256(convert_to(token, 'UTF8'));
ALTER TABLE users ALTER COLUMN token_hash SET NOT NULL, ADD UNIQUE (token_hash), DROP COLUMN token;
