import { createHash } from 'crypto';

export const tokenHash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();
