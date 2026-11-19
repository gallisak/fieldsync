import type { Row, StoredMutation, StoredRejection } from '@fieldsync/sync-core';
import { groupRejections } from '@/widgets/rejection-inbox/model/group-rejections';

let nextId = 0;
const rejected = (name: StoredMutation['name'], args: Record<string, unknown>): StoredRejection => ({
  id: ++nextId,
  mutation: { id: nextId, name, args, createdAt: '2026-01-01T00:00:00.000Z' },
  code: 'NO_ACCESS',
  message: 'no',
  at: '2026-01-01T00:00:00.000Z',
});

describe('groupRejections', () => {
  const view = new Map<string, Row>([
    ['ticket/t1', { id: 't1', title: 'Broken pump' }],
    ['part/p1', { id: 'p1', ticketId: 't1' }],
  ]);

  it('groups by the targeted ticket: ticket mutators, part.add by ticketId, part.adjust through its part', () => {
    const status = rejected('ticket.setStatus', { id: 't1', from: 'open', to: 'done' });
    const add = rejected('part.add', { id: 'p2', ticketId: 't1', name: 'Belt', quantity: 1 });
    const adjust = rejected('part.adjust', { id: 'p1', delta: -1 });
    const gone = rejected('ticket.delete', { id: 't9' });
    const orphan = rejected('part.adjust', { id: 'p9', delta: 1 });

    expect(groupRejections([status, gone, add, orphan, adjust], view)).toEqual([
      { ticketId: 't1', title: 'Broken pump', notCreated: null, rejections: [status, add, adjust] },
      { ticketId: 't9', title: null, notCreated: null, rejections: [gone] },
      { ticketId: null, title: null, notCreated: null, rejections: [orphan] },
    ]);
  });

  it('keeps the title of a ticket whose creation was rejected', () => {
    const create = rejected('ticket.create', { id: 't5', siteId: 's', title: 'Leaking valve', description: '' });
    expect(groupRejections([create], view)).toEqual([
      { ticketId: 't5', title: null, notCreated: 'Leaking valve', rejections: [create] },
    ]);
  });

  it('is empty without rejections', () => {
    expect(groupRejections([], view)).toEqual([]);
  });
});
