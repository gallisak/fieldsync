import type { RejectionCode, StoredMutation, StoredRejection } from '@fieldsync/sync-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { RejectionItem, describeRejection } from '@/entities/rejection';
import { describeMutation } from '@/entities/rejection/model/messages';
import { newestFirst } from '@/entities/rejection/model/selectors';

const mutation = (name: StoredMutation['name'], args: Record<string, unknown>, id = 1): StoredMutation => ({
  id,
  name,
  args,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const rejection = (
  code: RejectionCode,
  m: StoredMutation = mutation('ticket.setStatus', { id: 't', from: 'in_progress', to: 'done' }),
  extra: Partial<StoredRejection> = {},
): StoredRejection => ({ id: m.id, mutation: m, code, message: 'server says no', at: '2026-01-01T00:00:00.000Z', ...extra });

describe('rejection messages', () => {
  it.each<[RejectionCode, StoredRejection, string, string]>([
    [
      'STATUS_CONFLICT',
      rejection('STATUS_CONFLICT', undefined, { details: { current: 'cancelled' } }),
      'Status was changed by someone else',
      'It is now cancelled.',
    ],
    [
      'INVALID_TRANSITION',
      rejection('INVALID_TRANSITION', mutation('ticket.setStatus', { id: 't', from: 'done', to: 'in_progress' })),
      'This status change is not allowed',
      'Done cannot go to in progress.',
    ],
    [
      'NEGATIVE_QUANTITY',
      rejection('NEGATIVE_QUANTITY'),
      'Quantity cannot go below zero',
      'Someone else reduced it first. Check the current quantity.',
    ],
    [
      'NO_ACCESS',
      rejection('NO_ACCESS'),
      'Ticket is no longer available',
      'It was deleted, moved to another site, or your access was removed.',
    ],
    ['ALREADY_EXISTS', rejection('ALREADY_EXISTS'), 'This item already exists', 'Reload and try again.'],
    ['BAD_ARGS', rejection('BAD_ARGS'), 'The change was not valid', 'server says no'],
    ['INTERNAL', rejection('INTERNAL'), 'Server error', 'Your change was not applied. You can try again.'],
  ])('%s', (_code, r, title, hint) => {
    expect(describeRejection(r)).toEqual({ title, hint });
  });

  it('falls back to the server message when a conflict carries no current status', () => {
    expect(describeRejection(rejection('STATUS_CONFLICT')).hint).toBe('server says no');
  });

  it.each<[StoredMutation, string]>([
    [mutation('ticket.create', { title: 'Broken pump' }), 'Create ticket "Broken pump"'],
    [mutation('ticket.update', { patch: { title: 'x', description: 'y' } }), 'Edit title and description'],
    [mutation('ticket.setStatus', { to: 'done' }), 'Mark done'],
    [mutation('ticket.setStatus', { to: 'in_progress' }), 'Start work'],
    [mutation('ticket.delete', {}), 'Delete ticket'],
    [mutation('ticket.move', {}), 'Move ticket to another site'],
    [mutation('part.add', { name: 'Filter' }), 'Add part "Filter"'],
    [mutation('part.adjust', { delta: -1 }), "Remove 1 from a part's quantity"],
  ])('describes %j as "%s"', (m, text) => {
    expect(describeMutation(m)).toBe(text);
  });
});

describe('rejection selectors', () => {
  it('lists the newest first', () => {
    const list = [
      rejection('INTERNAL', mutation('ticket.delete', {}, 1), { at: '2026-01-01T00:00:00.000Z' }),
      rejection('INTERNAL', mutation('ticket.delete', {}, 3), { at: '2026-01-03T00:00:00.000Z' }),
      rejection('INTERNAL', mutation('ticket.delete', {}, 2), { at: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(newestFirst(list).map((r) => r.mutation.id)).toEqual([3, 2, 1]);
    expect(list.map((r) => r.mutation.id)).toEqual([1, 3, 2]);
  });
});

describe('rejection UI', () => {
  it('shows what was tried, why it failed and the actions', () => {
    const html = renderToStaticMarkup(
      <RejectionItem
        rejection={rejection('STATUS_CONFLICT', undefined, { details: { current: 'cancelled' } })}
        actions={<button>Dismiss</button>}
      />,
    );
    expect(html).toContain('Mark done');
    expect(html).toContain('Status was changed by someone else');
    expect(html).toContain('It is now cancelled.');
    expect(html).toContain('<button>Dismiss</button>');
  });
});
