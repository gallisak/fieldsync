import { signOut } from '@/entities/session';
import { localDatabaseName } from '@/shared/api';

// The open connections close when signing out unmounts the client; the deletion waits for them.
export function signOutAndClear(userId: string): void {
  signOut();
  try {
    globalThis.indexedDB?.deleteDatabase(localDatabaseName(userId));
  } catch (err) {
    console.error('fieldsync: could not clear the data on this device', err);
  }
}
