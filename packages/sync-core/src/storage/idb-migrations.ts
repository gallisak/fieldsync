export const LOCAL_SCHEMA = 1;

/** A step must never clear `mutations`: they are the user's unsynced work. */
export const migrations: Record<number, (db: IDBDatabase, tx: IDBTransaction) => void> = {
  1(db) {
    db.createObjectStore('meta');
    const entities = db.createObjectStore('entities');
    entities.createIndex('entity', 'entity');
    entities.createIndex('siteId', 'siteId');
    db.createObjectStore('mutations', { keyPath: 'id' });
    db.createObjectStore('rejections', { keyPath: 'mutation.id' });
  },
};
