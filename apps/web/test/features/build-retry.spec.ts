import type { RejectionCode, Row, StoredMutation, StoredRejection, TicketStatus } from '@fieldsync/sync-core';
import { buildRetry } from '@/features/rejection/resolve/model/build-retry';

const TICKET = '00000000-0000-4000-8000-000000000101';

const setStatus = (from: TicketStatus, to: TicketStatus): StoredMutation => ({
  id: 7,
  name: 'ticket.setStatus',
  args: { id: TICKET, from, to },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const rejected = (
  code: RejectionCode,
  mutation: StoredMutation = setStatus('in_progress', 'open'),
): StoredRejection => ({
  id: 1,
  mutation,
  code,
  message: 'no',
  at: '2026-01-01T00:00:00.000Z',
});

const viewWith = (status?: TicketStatus) =>
  new Map<string, Row>(status ? [[`ticket/${TICKET}`, { id: TICKET, status }]] : []);

describe('buildRetry', () => {
  it('INTERNAL: the same change again', () => {
    const add: StoredMutation = {
      id: 3,
      name: 'part.add',
      args: { id: 'p', ticketId: TICKET, name: 'Filter', quantity: 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(buildRetry(rejected('INTERNAL', add), viewWith())).toEqual({ name: 'part.add', args: add.args });
  });

  describe('STATUS_CONFLICT', () => {
    const conflict = rejected('STATUS_CONFLICT', setStatus('in_progress', 'open'));

    it('the same target status, from the status the ticket has now', () => {
      expect(buildRetry(conflict, viewWith('done'))).toEqual({
        name: 'ticket.setStatus',
        args: { id: TICKET, from: 'done', to: 'open' },
      });
    });

    it('nothing when the target is no longer reachable', () => {
      expect(buildRetry(conflict, viewWith('cancelled'))).toBeNull();
    });

    it('nothing when the ticket already has that status', () => {
      expect(buildRetry(conflict, viewWith('open'))).toBeNull();
    });

    it('nothing when the ticket is gone', () => {
      expect(buildRetry(conflict, viewWith())).toBeNull();
    });
  });

  it.each<RejectionCode>([
    'NO_ACCESS',
    'ALREADY_EXISTS',
    'INVALID_TRANSITION',
    'NEGATIVE_QUANTITY',
    'BAD_ARGS',
    'QUEUE_FULL',
  ])('%s: dismiss only', (code) => {
    expect(buildRetry(rejected(code), viewWith('done'))).toBeNull();
  });
});
