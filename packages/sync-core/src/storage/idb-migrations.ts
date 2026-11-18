export const LOCAL_SCHEMA = 2;

/**
 * Additive only. A step must never clear `mutations` (the user's unsynced work); it may drop `entities` only
 * together with setting the cursor to `null`, so the next pull re-fetches them.
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
};
