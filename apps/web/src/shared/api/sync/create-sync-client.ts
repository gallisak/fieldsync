import { HttpTransport, IdbStorage, SyncClient, WebLocksCoordinator } from '@fieldsync/sync-core';

const LEGACY_TOKEN_KEY = 'fs_token';

export function createSyncClient({ apiUrl, token, userId }: { apiUrl: string; token: string; userId: string }) {
  // The pre-IndexedDB app kept one unscoped state in localStorage. Only the user who wrote it may import it:
  // anyone else would push that user's queued changes under their own account.
  const ownsLegacyState = globalThis.localStorage?.getItem(LEGACY_TOKEN_KEY) === token;
  if (ownsLegacyState) globalThis.localStorage.removeItem(LEGACY_TOKEN_KEY);

  return new SyncClient({
    transport: new HttpTransport(apiUrl, token),
    storage: new IdbStorage(`fieldsync:${userId}`, undefined, {
      legacy: ownsLegacyState ? globalThis.localStorage : null,
    }),
    stream: { url: `${apiUrl}/sync/stream`, token },
    tabs: new WebLocksCoordinator(userId),
  });
}
