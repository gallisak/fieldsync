import type { QueuedMutation, Row, TicketStatus } from '@fieldsync/sync-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { TicketRow, TicketStatusBadge, type Ticket } from '@/entities/ticket';
import { selectPendingKeys, selectTicket, selectTickets } from '@/entities/ticket/model/selectors';

const SITE = '00000000-0000-4000-8000-0000000000a1';
const T1 = '00000000-0000-4000-8000-000000000101';
const T2 = '00000000-0000-4000-8000-000000000102';
const P1 = '00000000-0000-4000-8000-000000000201';

const ticket = (id: string, updatedAt: string, extra: Partial<Ticket> = {}): Ticket => ({
  id,
  siteId: SITE,
  title: `Ticket ${id}`,
  description: '',
  status: 'open',
  assigneeId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
  ...extra,
});

const queued = (name: QueuedMutation['name'], args: Record<string, unknown>): QueuedMutation => ({
  id: 1,
  name,
  args,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('ticket selectors', () => {
  const view = new Map<string, Row>([
    ['ticket/b', { ...ticket('b', '2026-01-02T00:00:00.000Z') }],
    ['ticket/a', { ...ticket('a', '2026-01-02T00:00:00.000Z') }],
    ['ticket/c', { ...ticket('c', '2026-01-03T00:00:00.000Z') }],
    ['ticket/bad', { id: 'bad', title: 42 }],
    ['part/p', { id: 'p', ticketId: 'a', siteId: SITE, name: 'Filter', quantity: 1 }],
  ]);

  it('lists valid tickets, newest change first, ties by id; skips malformed rows and other entities', () => {
    expect(selectTickets(view).map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('finds one ticket, or null when it is missing or malformed', () => {
    expect(selectTicket(view, 'a')).toEqual(ticket('a', '2026-01-02T00:00:00.000Z'));
    expect(selectTicket(view, 'bad')).toBeNull();
    expect(selectTicket(view, 'nope')).toBeNull();
  });

  it('collects the rows touched by queued mutations, skipping one whose args no longer parse', () => {
    const keys = selectPendingKeys([
      queued('ticket.setStatus', { id: T1, from: 'open', to: 'in_progress' }),
      queued('part.add', { id: P1, ticketId: T2, name: 'Filter', quantity: 1 }),
      queued('ticket.update', { id: 'not-a-uuid', patch: {} }),
    ]);
    expect([...keys].sort()).toEqual([`part/${P1}`, `ticket/${T1}`, `ticket/${T2}`]);
  });
});

describe('ticket UI', () => {
  it.each<[TicketStatus, string]>([
    ['open', 'Open'],
    ['in_progress', 'In progress'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
  ])('labels the %s status "%s"', (status, label) => {
    expect(renderToStaticMarkup(<TicketStatusBadge status={status} />)).toContain(`>${label}</div>`);
  });

  const row = (unsynced: boolean) =>
    renderToStaticMarkup(
      <table>
        <tbody>
          <TicketRow
            ticket={ticket(T1, new Date().toISOString(), { title: 'Broken pump', status: 'in_progress' })}
            siteName="North yard"
            unsynced={unsynced}
          />
        </tbody>
      </table>,
    );

  it('renders a row linking to the ticket, with its status, site and age', () => {
    const html = row(false);
    expect(html).toContain(`href="/tickets/${T1}"`);
    expect(html).toContain('Broken pump');
    expect(html).toContain('In progress');
    expect(html).toContain('North yard');
    expect(html).toContain('just now');
    expect(html).not.toContain('Not synced');
  });

  it('marks a row whose changes are not synced', () => {
    expect(row(true)).toContain('Not synced');
  });
});
