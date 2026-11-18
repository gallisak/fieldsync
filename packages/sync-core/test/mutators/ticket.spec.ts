import { MapTx } from '../support/map-tx';
import { CTX, expectRejected, run } from '../support/mutate';

const SITE_A = '33333333-3333-4333-8333-33333333333a';
const SITE_B = '33333333-3333-4333-8333-33333333333b';
const TICKET = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const LATER = { now: '2026-01-01T11:00:00.000Z' };

const ticket = (over: Record<string, unknown> = {}) => ({
  id: TICKET,
  siteId: SITE_A,
  title: 'Pump',
  description: 'Leaks',
  status: 'open',
  assigneeId: null,
  createdAt: CTX.now,
  updatedAt: CTX.now,
  ...over,
});
const part = (n: number, over: Record<string, unknown> = {}) => ({
  id: `22222222-2222-4222-8222-00000000000${n}`,
  ticketId: TICKET,
  siteId: SITE_A,
  name: `Part ${n}`,
  quantity: n,
  ...over,
});

describe('ticket.create', () => {
  const args = { id: TICKET, siteId: SITE_A, title: '  Pump  ', description: 'Leaks' };

  it('creates an open ticket with the given id and ctx time', () => {
    const tx = new MapTx();
    run(tx, 'ticket.create', args);
    expect(tx.get('ticket', TICKET)).toEqual({ ...ticket(), title: 'Pump' });
  });

  it('rejects an id that already exists with ALREADY_EXISTS', () => {
    const tx = new MapTx([['ticket', ticket()]]);
    expectRejected(tx, 'ticket.create', args, 'ALREADY_EXISTS');
    expect(tx.get('ticket', TICKET)).toEqual(ticket());
  });

  it('rejects the id of a deleted ticket with ALREADY_EXISTS instead of reviving it', () => {
    const tx = new MapTx();
    tx.exists = (entity, id) => entity === 'ticket' && id === TICKET; // a tombstone: it exists, get() is undefined
    expectRejected(tx, 'ticket.create', args, 'ALREADY_EXISTS');
    expect(tx.all('ticket')).toEqual([]);
  });

  it.each([
    ['a non-uuid id', { ...args, id: 'x' }],
    ['an empty title', { ...args, title: '   ' }],
    ['a 201-char title', { ...args, title: 'x'.repeat(201) }],
    ['a 5001-char description', { ...args, description: 'x'.repeat(5001) }],
    ['a missing siteId', { id: TICKET, title: 'Pump', description: '' }],
  ])('rejects %s with BAD_ARGS', (_label, bad) => {
    const tx = new MapTx();
    expectRejected(tx, 'ticket.create', bad, 'BAD_ARGS');
    expect(tx.all('ticket')).toEqual([]);
  });
});

describe('ticket.update', () => {
  it('writes only the patched fields and bumps updatedAt', () => {
    const tx = new MapTx([['ticket', ticket()]]);
    run(tx, 'ticket.update', { id: TICKET, patch: { description: 'Seal replaced', assigneeId: USER } }, LATER);
    expect(tx.get('ticket', TICKET)).toEqual(
      ticket({ description: 'Seal replaced', assigneeId: USER, updatedAt: LATER.now }),
    );
  });

  it('can unassign with assigneeId null', () => {
    const tx = new MapTx([['ticket', ticket({ assigneeId: USER })]]);
    run(tx, 'ticket.update', { id: TICKET, patch: { assigneeId: null } });
    expect(tx.get('ticket', TICKET)?.assigneeId).toBeNull();
  });

  it('rejects a missing ticket with NO_ACCESS', () => {
    expectRejected(new MapTx(), 'ticket.update', { id: TICKET, patch: { title: 'x' } }, 'NO_ACCESS');
  });

  it.each([
    ['an empty patch', { id: TICKET, patch: {} }],
    ['a patch of a non-editable field', { id: TICKET, patch: { status: 'done' } }],
    ['a patch that moves the ticket', { id: TICKET, patch: { siteId: SITE_B } }],
    ['an empty title', { id: TICKET, patch: { title: '' } }],
  ])('rejects %s with BAD_ARGS', (_label, bad) => {
    const tx = new MapTx([['ticket', ticket()]]);
    expectRejected(tx, 'ticket.update', bad, 'BAD_ARGS');
    expect(tx.get('ticket', TICKET)).toEqual(ticket());
  });
});

describe('ticket.setStatus', () => {
  it('moves along an allowed transition', () => {
    const tx = new MapTx([['ticket', ticket()]]);
    run(tx, 'ticket.setStatus', { id: TICKET, from: 'open', to: 'in_progress' }, LATER);
    expect(tx.get('ticket', TICKET)).toEqual(ticket({ status: 'in_progress', updatedAt: LATER.now }));
  });

  it('rejects a stale "from" with STATUS_CONFLICT and reports the current status', () => {
    const tx = new MapTx([['ticket', ticket({ status: 'done' })]]);
    const err = expectRejected(
      tx,
      'ticket.setStatus',
      { id: TICKET, from: 'open', to: 'in_progress' },
      'STATUS_CONFLICT',
    );
    expect(err.details).toEqual({ current: 'done' });
  });

  it('rejects a missing ticket with NO_ACCESS', () => {
    expectRejected(new MapTx(), 'ticket.setStatus', { id: TICKET, from: 'open', to: 'done' }, 'NO_ACCESS');
  });

  it('rejects an unknown status with BAD_ARGS', () => {
    const tx = new MapTx([['ticket', ticket()]]);
    expectRejected(tx, 'ticket.setStatus', { id: TICKET, from: 'open', to: 'archived' }, 'BAD_ARGS');
  });
});

describe('ticket.delete', () => {
  it('deletes the ticket and only its parts', () => {
    const other = part(3, { ticketId: '11111111-1111-4111-8111-999999999999' });
    const tx = new MapTx([
      ['ticket', ticket()],
      ['part', part(1)],
      ['part', part(2)],
      ['part', other],
    ]);
    run(tx, 'ticket.delete', { id: TICKET });
    expect(tx.get('ticket', TICKET)).toBeUndefined();
    expect(tx.all('part')).toEqual([other]);
  });

  it('is a no-op for a missing ticket', () => {
    const tx = new MapTx([['part', part(1)]]);
    run(tx, 'ticket.delete', { id: TICKET });
    expect(tx.all('part')).toEqual([part(1)]);
  });

  it('rejects a non-uuid id with BAD_ARGS', () => {
    expectRejected(new MapTx(), 'ticket.delete', { id: 'x' }, 'BAD_ARGS');
  });
});

describe('ticket.move', () => {
  it('moves the ticket and its parts to the target site', () => {
    const tx = new MapTx([
      ['ticket', ticket()],
      ['part', part(1)],
      ['part', part(2)],
    ]);
    run(tx, 'ticket.move', { id: TICKET, toSiteId: SITE_B }, LATER);
    expect(tx.get('ticket', TICKET)).toEqual(ticket({ siteId: SITE_B, updatedAt: LATER.now }));
    expect(tx.all('part')).toEqual([part(1, { siteId: SITE_B }), part(2, { siteId: SITE_B })]);
  });

  it('is a no-op when the ticket is already on the target site', () => {
    const tx = new MapTx([['ticket', ticket()]]);
    run(tx, 'ticket.move', { id: TICKET, toSiteId: SITE_A }, LATER);
    expect(tx.get('ticket', TICKET)).toEqual(ticket());
  });

  it('rejects a missing ticket with NO_ACCESS', () => {
    expectRejected(new MapTx(), 'ticket.move', { id: TICKET, toSiteId: SITE_B }, 'NO_ACCESS');
  });

  it('rejects a non-uuid target with BAD_ARGS', () => {
    expectRejected(new MapTx([['ticket', ticket()]]), 'ticket.move', { id: TICKET, toSiteId: 'b' }, 'BAD_ARGS');
  });
});
