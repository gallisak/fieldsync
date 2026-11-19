import { MapTx } from '../support/map-tx';
import { expectRejected, run } from '../support/mutate';

const SITE = '33333333-3333-4333-8333-33333333333a';
const TICKET = '11111111-1111-4111-8111-111111111111';
const PART = '22222222-2222-4222-8222-222222222222';

const ticket = { id: TICKET, siteId: SITE, title: 'Pump', description: '', status: 'open' };
const part = (quantity: number) => ({ id: PART, ticketId: TICKET, siteId: SITE, name: 'Seal', quantity });

describe('part.add', () => {
  const args = { id: PART, ticketId: TICKET, name: ' Seal ', quantity: 2 };

  it("adds a part on the ticket's site", () => {
    const tx = new MapTx([['ticket', ticket]]);
    run(tx, 'part.add', args);
    expect(tx.get('part', PART)).toEqual(part(2));
  });

  it('is a no-op when the part already exists', () => {
    const tx = new MapTx([['ticket', ticket], ['part', part(7)]]);
    run(tx, 'part.add', args);
    expect(tx.get('part', PART)).toEqual(part(7));
  });

  it('rejects a missing ticket with NO_ACCESS', () => {
    expectRejected(new MapTx(), 'part.add', args, 'NO_ACCESS');
  });

  it.each([
    ['quantity 0', { ...args, quantity: 0 }],
    ['quantity 1001', { ...args, quantity: 1001 }],
    ['a fractional quantity', { ...args, quantity: 1.5 }],
    ['an empty name', { ...args, name: ' ' }],
    ['a client-supplied siteId only', { id: PART, siteId: SITE, name: 'Seal', quantity: 1 }],
  ])('rejects %s with BAD_ARGS', (_label, bad) => {
    const tx = new MapTx([['ticket', ticket]]);
    expectRejected(tx, 'part.add', bad, 'BAD_ARGS');
    expect(tx.get('part', PART)).toBeUndefined();
  });
});

describe('part.adjust', () => {
  it('adds the delta to the quantity', () => {
    const tx = new MapTx([['part', part(1)]]);
    run(tx, 'part.adjust', { id: PART, delta: 3 });
    expect(tx.get('part', PART)?.quantity).toBe(4);
  });

  it('allows reaching exactly zero', () => {
    const tx = new MapTx([['part', part(2)]]);
    run(tx, 'part.adjust', { id: PART, delta: -2 });
    expect(tx.get('part', PART)?.quantity).toBe(0);
  });

  it('rejects going below zero with NEGATIVE_QUANTITY', () => {
    const tx = new MapTx([['part', part(1)]]);
    expectRejected(tx, 'part.adjust', { id: PART, delta: -2 }, 'NEGATIVE_QUANTITY');
    expect(tx.get('part', PART)?.quantity).toBe(1);
  });

  it('rejects a missing part with NO_ACCESS', () => {
    expectRejected(new MapTx(), 'part.adjust', { id: PART, delta: 1 }, 'NO_ACCESS');
  });

  it.each([
    ['a fractional delta', 0.5],
    ['a delta above 1000', 1001],
    ['a delta below -1000', -1001],
  ])('rejects %s with BAD_ARGS', (_label, delta) => {
    expectRejected(new MapTx([['part', part(1)]]), 'part.adjust', { id: PART, delta }, 'BAD_ARGS');
  });

  it('is commutative: every order of three deltas gives the same quantity', () => {
    const deltas = [5, -3, 2];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const results = orders.map((order) => {
      const tx = new MapTx([['part', part(3)]]);
      for (const i of order) run(tx, 'part.adjust', { id: PART, delta: deltas[i] });
      return tx.get('part', PART)?.quantity;
    });
    expect(results).toEqual(Array(6).fill(7));
  });
});
