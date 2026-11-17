import { MUTATORS, MutationRejected, type MutatorTx } from '../src/mutators';
import type { EntityName, Row } from '../src/protocol/types';

class FakeTx implements MutatorTx {
  readonly rows = new Map<string, Row>();

  constructor(initial: Array<[EntityName, string, Row]> = []) {
    for (const [entity, id, row] of initial) this.rows.set(`${entity}/${id}`, row);
  }

  get(entity: EntityName, id: string) {
    return this.rows.get(`${entity}/${id}`);
  }

  put(entity: EntityName, id: string, row: Row) {
    this.rows.set(`${entity}/${id}`, row);
  }

  del(entity: EntityName, id: string) {
    this.rows.delete(`${entity}/${id}`);
  }
}

const TICKET = '11111111-1111-4111-8111-111111111111';
const PART = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';

const ticket = (status: string): Row => ({ id: TICKET, siteId: SITE, title: 't', description: '', status });

describe('ticket mutators', () => {
  it('creates a ticket in the open status', () => {
    const tx = new FakeTx();
    MUTATORS['ticket.create'].apply(tx, { siteId: SITE, title: 'Broken pump', description: '' });
    const [created] = [...tx.rows.values()];
    expect(created.status).toBe('open');
    expect(created.siteId).toBe(SITE);
  });

  it('rejects an update for a ticket that does not exist', () => {
    const tx = new FakeTx();
    expect(() =>
      MUTATORS['ticket.update'].apply(tx, { id: TICKET, siteId: SITE, title: 'x', description: '' }),
    ).toThrow(MutationRejected);
  });

  it('moves a ticket along an allowed transition', () => {
    const tx = new FakeTx([['ticket', TICKET, ticket('open')]]);
    MUTATORS['ticket.setStatus'].apply(tx, { id: TICKET, siteId: SITE, from: 'open', to: 'in_progress' });
    expect(tx.get('ticket', TICKET)?.status).toBe('in_progress');
  });

  it('rejects an invalid status transition', () => {
    const tx = new FakeTx([['ticket', TICKET, ticket('done')]]);
    const act = () =>
      MUTATORS['ticket.setStatus'].apply(tx, { id: TICKET, siteId: SITE, from: 'done', to: 'in_progress' });
    expect(act).toThrow(MutationRejected);
    expect(act).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(tx.get('ticket', TICKET)?.status).toBe('done');
  });
});

describe('part mutators', () => {
  it('does not let a quantity go below zero', () => {
    const tx = new FakeTx([['part', PART, { id: PART, quantity: 1 }]]);
    expect(() => MUTATORS['part.adjust'].apply(tx, { id: PART, siteId: SITE, delta: -2 })).toThrow(
      MutationRejected,
    );
  });

  it('adds to the quantity', () => {
    const tx = new FakeTx([['part', PART, { id: PART, quantity: 1 }]]);
    MUTATORS['part.adjust'].apply(tx, { id: PART, siteId: SITE, delta: 3 });
    expect(tx.get('part', PART)?.quantity).toBe(4);
  });
});
