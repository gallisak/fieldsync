import { TransportError } from '@fieldsync/sync-core';
import { StorageUnavailableError, signIn } from '@/entities/session';
import { fetchMe } from '@/shared/api';

export async function signInByToken(token: string): Promise<string | null> {
  try {
    const me = await fetchMe(token);
    signIn({ token, userId: me.id, role: me.role, sites: me.sites });
    return null;
  } catch (err) {
    if (err instanceof StorageUnavailableError) return 'This browser blocks site data. Allow it for this site to sign in.';
    if (!(err instanceof TransportError)) {
      console.error('fieldsync: sign-in failed', err);
      return 'Sign-in failed. Try again.';
    }
    if (err.status === 401) return 'Invalid token';
    if (err.kind !== 'http') return 'You need a connection for the first sign-in';
    if (err.status === 426) return 'A new version of FieldSync is required. Reload the page.';
    return 'Sign-in failed. Try again.';
  }
}
