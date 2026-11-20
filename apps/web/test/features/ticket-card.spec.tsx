/** @jest-environment jsdom */
import { randomUUID } from 'crypto';
import { MemoryStorage, SyncClient } from '@fieldsync/sync-core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { signIn } from '@/entities/session';
import { RelativeTime } from '@/shared/ui/relative-time';
import { SyncClientProvider } from '@/shared/api/sync/sync-context';
import { TicketDetailsCard } from '@/widgets/ticket-details-card';

jest.mock('sonner', () => ({ toast: { error: jest.fn() } }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const SITE = '00000000-0000-4000-8000-0000000000a1';
const TICKET = '00000000-0000-4000-8000-000000000101';
const ME = '00000000-0000-4000-8000-000000000002';

describe('ticket card', () => {
  let root: Root;
  let div: HTMLDivElement;
  let client: SyncClient;
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { structuredClone?: unknown }).structuredClone ??= (v: unknown) => JSON.parse(JSON.stringify(v));
    (globalThis.crypto as { randomUUID?: () => string }).randomUUID ??= randomUUID;
    signIn({ token: 't', userId: ME, role: 'technician', sites: [{ id: SITE, name: 'North' }] });
  });
  beforeEach(async () => {
    client = new SyncClient({ transport: {} as never, storage: new MemoryStorage(), env: {} });
    await client.ready;
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'Pump', description: '' });
    div = document.body.appendChild(document.createElement('div'));
    root = createRoot(div);
    await act(async () =>
      root.render(
        <SyncClientProvider client={client}>
          <TicketDetailsCard id={TICKET} />
        </SyncClientProvider>,
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.dispose();
    document.body.innerHTML = '';
  });
  const button = (text: string) => [...div.querySelectorAll('button')].find((b) => b.textContent === text)!;

  it('assigns the ticket to the viewer and back', async () => {
    expect(div.textContent).toContain('Unassigned');
    await act(async () => button('Assign to me').click());
    expect(client.rows('ticket')[0]).toMatchObject({ assigneeId: ME });
    expect(div.textContent).toContain('Assigned to you');

    await act(async () => button('Unassign').click());
    expect(client.rows('ticket')[0]).toMatchObject({ assigneeId: null });
    expect(client.pending.at(-1)).toMatchObject({ name: 'ticket.update', args: { patch: { assigneeId: null } } });
  });

  it('says a ticket deleted on this device is deleted, not unavailable', async () => {
    await act(async () => client.mutate('ticket.delete', { id: TICKET }));
    expect(div.textContent).toContain('Ticket deleted');
    expect(div.textContent).not.toContain('Ticket unavailable');
  });
});

describe('RelativeTime', () => {
  afterEach(() => jest.useRealTimers());

  it('moves on as time passes', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z') });
    const div = document.body.appendChild(document.createElement('div'));
    const root = createRoot(div);
    await act(async () => root.render(<RelativeTime iso="2026-01-01T00:00:00Z" />));
    expect(div.textContent).toBe('just now');

    await act(async () => jest.advanceTimersByTime(60_000));
    expect(div.textContent).toBe('1 minute ago');
    await act(async () => root.unmount());
  });

  it('runs one timer for every timestamp on the page, and none once they are gone', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-01-01T00:00:10Z') });
    const div = document.body.appendChild(document.createElement('div'));
    const root = createRoot(div);
    const times = Array.from({ length: 100 }, (_, i) => <RelativeTime key={i} iso="2026-01-01T00:00:00Z" />);
    await act(async () => root.render(<>{times}</>));
    expect(jest.getTimerCount()).toBe(1);

    await act(async () => jest.advanceTimersByTime(60_000));
    expect(div.querySelectorAll('time')[99].textContent).toBe('1 minute ago');
    await act(async () => root.unmount());
    expect(jest.getTimerCount()).toBe(0);
  });
});
