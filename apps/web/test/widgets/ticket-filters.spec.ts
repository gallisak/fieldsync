import type { Ticket } from '@/entities/ticket';
import { filterTickets, readFilters } from '@/widgets/ticket-table/model/filters';

const ticket = (id: string, siteId: string, status: Ticket['status']): Ticket => ({
  id,
  siteId,
  title: id,
  description: '',
  status,
  assigneeId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const tickets = [ticket('1', 'a', 'open'), ticket('2', 'a', 'done'), ticket('3', 'b', 'open')];

describe('ticket filters', () => {
  it('reads site and status from the URL, ignoring an unknown status', () => {
    const sites = ['a', 'b'];
    expect(readFilters(new URLSearchParams('site=a&status=done'), sites)).toEqual({ site: 'a', status: 'done' });
    expect(readFilters(new URLSearchParams('status=lost&site='), sites)).toEqual({ site: null, status: null });
    expect(readFilters(null, sites)).toEqual({ site: null, status: null });
  });

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])('does not take "%s" for a status', (s) => {
    expect(readFilters(new URLSearchParams(`status=${s}`), []).status).toBeNull();
  });

  it('ignores a site the viewer cannot see', () => {
    expect(readFilters(new URLSearchParams('site=c'), ['a', 'b']).site).toBeNull();
  });

  it('filters by site, by status, by both, or not at all', () => {
    const ids = (f: Parameters<typeof filterTickets>[1]) => filterTickets(tickets, f).map((t) => t.id);
    expect(ids({ site: null, status: null })).toEqual(['1', '2', '3']);
    expect(ids({ site: 'a', status: null })).toEqual(['1', '2']);
    expect(ids({ site: null, status: 'open' })).toEqual(['1', '3']);
    expect(ids({ site: 'a', status: 'open' })).toEqual(['1']);
    expect(ids({ site: 'c', status: null })).toEqual([]);
  });
});
