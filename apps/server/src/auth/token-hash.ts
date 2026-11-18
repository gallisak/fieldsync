import { createHash } from 'crypto';

/** What `users.token_hash` holds: the SHA-256 of the token's UTF-8 bytes, as migration 004 computes it. */
export const tokenHash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();
