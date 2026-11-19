export const LOCAL_SCHEMA = 4;

/**
 * A step keeps data: it adds, or copies into a new store. It must never clear `mutations` (the user's unsynced
 * work); it may drop `entities` only together with setting the cursor to `null`, so the next pull re-fetches them.
 */
export const migrations: Record<number, (db: IDBDatabase, tx: IDBTransaction) => void> = {
  1(db) {
    db.createObjectStore('meta');
    const entities = db.createObjectStore('entities');
    entities.createIndex('entity', 'entity');
    entities.createIndex('siteId', 'siteId');
    db.createObjectStore('mutations', { keyPath: 'id' });
    db.createObjectStore('rejections', { keyPath: 'mutation.id' });
  },
  2(_db, tx) {
    tx.objectStore('entities').createIndex('ticketId', 'data.ticketId');
  },
  // Keyed by mutation id, a rejection kept from before a client id reset was overwritten by a new one.
  3(db, tx) {
    const old = tx.objectStore('rejections');
    old.name = 'rejections_v2';
    const rejections = db.createObjectStore('rejections', { keyPath: 'id', autoIncrement: true });
    const all = old.getAll();
    all.onsuccess = () => {
      for (const r of all.result as object[]) rejections.add(r);
      db.deleteObjectStore('rejections_v2');
    };
  },
  // Nothing reads by these: the client keeps its base in memory. Each put still had to update all three.
  4(_db, tx) {
    const entities = tx.objectStore('entities');
    for (const index of ['entity', 'siteId', 'ticketId']) {
      if (entities.indexNames.contains(index)) entities.deleteIndex(index);
    }
  },
};
