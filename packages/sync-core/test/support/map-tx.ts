import type { EntityName, MutatorTx, Row } from '../../src';

/** In-memory row store for mutator-level tests. */
export class MapTx implements MutatorTx {
  readonly rows = new Map<string, Row>();

  constructor(initial: Array<[EntityName, Row]> = []) {
    for (const [entity, row] of initial) this.rows.set(`${entity}/${String(row.id)}`, row);
  }

  get(entity: EntityName, id: string): Row | undefined {
    return this.rows.get(`${entity}/${id}`);
  }

  put(entity: EntityName, id: string, row: Row): void {
    this.rows.set(`${entity}/${id}`, row);
  }

  del(entity: EntityName, id: string): void {
    this.rows.delete(`${entity}/${id}`);
  }

  all(entity: EntityName): Row[] {
    return [...this.rows].filter(([key]) => key.startsWith(`${entity}/`)).map(([, row]) => row);
  }
}
