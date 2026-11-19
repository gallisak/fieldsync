/** @jest-environment jsdom */
import { randomUUID } from 'crypto';
import { MemoryStorage, SyncClient } from '@fieldsync/sync-core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTicket } from '@/entities/ticket';
import { EditTicketFields } from '@/features/ticket/edit-fields';
import { SyncClientProvider } from '@/shared/api/sync/sync-context';

jest.mock('sonner', () => ({ toast: { error: jest.fn() } }));

const SITE = '00000000-0000-4000-8000-0000000000a1';
const TICKET = '00000000-0000-4000-8000-000000000101';

class FlakyStorage extends MemoryStorage {
  fail = false;
  async enqueue(m: Parameters<MemoryStorage['enqueue']>[0]) {
    if (this.fail) throw new Error('disk full');
    return super.enqueue(m);
  }
}

function Card() {
  const ticket = useTicket(TICKET);
  return ticket ? <EditTicketFields ticket={ticket} /> : null;
}

const actEnv = (on: boolean) => ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = on);

describe('EditTicketFields', () => {
  let root: Root;
  let client: SyncClient;
  beforeAll(() => {
    (globalThis as { structuredClone?: unknown }).structuredClone ??= (v: unknown) => JSON.parse(JSON.stringify(v));
    (globalThis.crypto as { randomUUID?: () => string }).randomUUID ??= randomUUID;
  });
  afterEach(async () => {
    actEnv(true);
    await act(async () => root.unmount());
    client.dispose();
  });

  // Outside act on purpose: React re-renders with the old title before the submit handler resumes, as in a browser.
  it('keeps the typed text as unsaved when the device cannot store the change', async () => {
    actEnv(true);
    const storage = new FlakyStorage();
    client = new SyncClient({ transport: {} as never, storage, env: {} });
    await client.ready;
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'Old', description: '' });
    const div = document.body.appendChild(document.createElement('div'));
    root = createRoot(div);
    await act(async () =>
      root.render(
        <SyncClientProvider client={client}>
          <Card />
        </SyncClientProvider>,
      ),
    );
    const input = div.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'New');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    storage.fail = true;
    actEnv(false);
    div.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));

    expect(client.rows('ticket')[0]).toMatchObject({ title: 'Old' });
    expect(div.querySelector('input')!.value).toBe('New');
    expect(div.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(false);
  });
});
