/** Version of the local IndexedDB schema. Raise it together with a new entry in `migrations`. */
export const LOCAL_SCHEMA = 1;

/**
 * Schema steps of the local database, keyed by the version they lead to; all steps after the stored version run
 * in order inside the upgrade transaction. A step may add stores and indexes and transform rows; it must never
 * clear `mutations` (the user's unsynced work).
 */
export const migrations: Record<number, (db: IDBDatabase, tx: IDBTransaction) => void> = {
  1(db) {
    db.createObjectStore('meta'); // out-of-line keys: clientId, cursor, lastMutationId, nextMutationId
    const entities = db.createObjectStore('entities'); // key "<entity>/<id>", value { entity, siteId, data }
    entities.createIndex('entity', 'entity');
    entities.createIndex('siteId', 'siteId');
    db.createObjectStore('mutations', { keyPath: 'id' });
    db.createObjectStore('rejections', { keyPath: 'mutation.id' });
  },
};
