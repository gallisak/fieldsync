import type { Row } from '@fieldsync/sync-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { PartRow, type Part } from '@/entities/part';
import { selectPartsOfTicket } from '@/entities/part/model/selectors';

const part = (id: string, ticketId: string, name: string, quantity = 1): Part => ({
  id,
  ticketId,
  siteId: 'site',
  name,
  quantity,
});

describe('part selectors', () => {
  it("lists a ticket's valid parts by name, then id", () => {
    const view = new Map<string, Row>([
      ['part/3', { ...part('3', 'a', 'Valve') }],
      ['part/2', { ...part('2', 'a', 'Filter') }],
      ['part/1', { ...part('1', 'a', 'Filter') }],
      ['part/4', { ...part('4', 'b', 'Belt') }],
      ['part/5', { id: '5', ticketId: 'a', name: 'Broken', quantity: 'many' }],
      ['ticket/a', { id: 'a', ticketId: 'a' }],
    ]);
    expect(selectPartsOfTicket(view, 'a').map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(selectPartsOfTicket(view, 'none')).toEqual([]);
  });
});

describe('part UI', () => {
  it('renders name, quantity and actions, and marks unsynced parts', () => {
    const html = renderToStaticMarkup(
      <PartRow part={part('1', 'a', 'Filter', 3)} unsynced={false} actions={<button>+</button>} />,
    );
    expect(html).toContain('Filter');
    expect(html).toContain('× 3');
    expect(html).toContain('<button>+</button>');
    expect(html).not.toContain('Not synced');
    expect(renderToStaticMarkup(<PartRow part={part('1', 'a', 'Filter')} unsynced />)).toContain('Not synced');
  });
});
