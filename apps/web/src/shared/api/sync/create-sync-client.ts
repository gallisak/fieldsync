import { HttpTransport, IdbStorage, SyncClient, WebLocksCoordinator } from '@fieldsync/sync-core';

const LEGACY_TOKEN_KEY = 'fs_token';

export const localDatabaseName = (userId: string) => `fieldsync:${userId}`;

// Reading `localStorage` itself throws when the browser blocks site data.
function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createSyncClient({ apiUrl, token, userId }: { apiUrl: string; token: string; userId: string }) {
  const local = browserStorage();
  // Only the user who wrote the legacy state may import it, or their queue would be pushed under another account.
  const ownsLegacyState = local?.getItem(LEGACY_TOKEN_KEY) === token;

  const client = new SyncClient({
    transport: new HttpTransport(apiUrl, token),
    storage: new IdbStorage(localDatabaseName(userId), undefined, { legacy: ownsLegacyState ? local : null }),
    stream: { url: `${apiUrl}/sync/stream`, token },
    tabs: new WebLocksCoordinator(userId),
  });
  // Only once the import has committed: a failed one is tried again on the next load.
  if (ownsLegacyState) {
    void client.ready.then(() => {
      if (client.facts.storage === 'durable') local?.removeItem(LEGACY_TOKEN_KEY);
    });
  }
  return client;
}
