import { MutationRejected, getMutator, type MutatorTx } from '../src/mutators';
import type { EntityName, Row } from '../src/protocol/types';

class FakeTx implements MutatorTx {
  readonly rows = new Map<string, Row>();

  constructor(initial: Array<[EntityName, string, Row]> = []) {
    for (const [entity, id, row] of initial) this.rows.set(`${entity}/${id}`, row);
  }

  get(entity: EntityName, id: string) {
    return this.rows.get(`${entity}/${id}`);
  }

  exists(entity: EntityName, id: string) {
    return this.rows.has(`${entity}/${id}`);
  }

  put(entity: EntityName, id: string, row: Row) {
    this.rows.set(`${entity}/${id}`, row);
  }

  del(entity: EntityName, id: string) {
    this.rows.delete(`${entity}/${id}`);
  }

  scan(entity: 'part', by: { ticketId: string }) {
    return [...this.rows].filter(([k, r]) => k.startsWith(`${entity}/`) && r.ticketId === by.ticketId).map(([, r]) => r);
  }
}

const ctx = { now: '2026-01-01T00:00:00.000Z' };
const run = (name: string, tx: MutatorTx, args: Record<string, unknown>) => getMutator(name)!.apply(tx, args, ctx);

const TICKET = '11111111-1111-4111-8111-111111111111';
const PART = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';

const ticket = (status: string): Row => ({ id: TICKET, siteId: SITE, title: 't', description: '', status });

describe('ticket mutators', () => {
  it('creates a ticket in the open status', () => {
    const tx = new FakeTx();
    run('ticket.create', tx, { id: TICKET, siteId: SITE, title: 'Broken pump', description: '' });
    const [created] = [...tx.rows.values()];
    expect(created.status).toBe('open');
    expect(created.siteId).toBe(SITE);
  });

  it('rejects an update for a ticket that does not exist', () => {
    const tx = new FakeTx();
    expect(() => run('ticket.update', tx, { id: TICKET, patch: { title: 'x' } })).toThrow(
      expect.objectContaining({ name: 'MutationRejected', code: 'NO_ACCESS' }),
    );
    expect(tx.rows.size).toBe(0);
  });

  it('moves a ticket along an allowed transition', () => {
    const tx = new FakeTx([['ticket', TICKET, ticket('open')]]);
    run('ticket.setStatus', tx, { id: TICKET, from: 'open', to: 'in_progress' });
    expect(tx.get('ticket', TICKET)?.status).toBe('in_progress');
  });

  it('rejects an invalid status transition', () => {
    const tx = new FakeTx([['ticket', TICKET, ticket('done')]]);
    const act = () => run('ticket.setStatus', tx, { id: TICKET, from: 'done', to: 'in_progress' });
    expect(act).toThrow(MutationRejected);
    expect(act).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(tx.get('ticket', TICKET)?.status).toBe('done');
  });
});

describe('part mutators', () => {
  it('does not let a quantity go below zero', () => {
    const tx = new FakeTx([['part', PART, { id: PART, quantity: 1 }]]);
    expect(() => run('part.adjust', tx, { id: PART, delta: -2 })).toThrow(
      expect.objectContaining({ name: 'MutationRejected', code: 'NEGATIVE_QUANTITY' }),
    );
    expect(tx.get('part', PART)?.quantity).toBe(1);
  });

  it('adds to the quantity', () => {
    const tx = new FakeTx([['part', PART, { id: PART, quantity: 1 }]]);
    run('part.adjust', tx, { id: PART, delta: 3 });
    expect(tx.get('part', PART)?.quantity).toBe(4);
  });
});
