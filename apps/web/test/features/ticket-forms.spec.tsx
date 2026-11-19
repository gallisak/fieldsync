/** @jest-environment jsdom */
import { randomUUID } from 'crypto';
import { MemoryStorage, SyncClient } from '@fieldsync/sync-core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTicket } from '@/entities/ticket';
import { ChangeStatusButtons } from '@/features/ticket/change-status';
import { CreateTicketDialog } from '@/features/ticket/create';
import { EditTicketFields } from '@/features/ticket/edit-fields';
import { SyncClientProvider } from '@/shared/api/sync/sync-context';

jest.mock('sonner', () => ({ toast: { error: jest.fn() } }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const SITE_A = '00000000-0000-4000-8000-0000000000a1';
const SITE_B = '00000000-0000-4000-8000-0000000000b1';
const TICKET = '00000000-0000-4000-8000-000000000101';

function Edit() {
  const ticket = useTicket(TICKET);
  return ticket ? <EditTicketFields ticket={ticket} /> : null;
}

function Status() {
  const ticket = useTicket(TICKET);
  return ticket ? <ChangeStatusButtons ticketId={ticket.id} status={ticket.status} /> : null;
}

const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('ticket forms', () => {
  let root: Root;
  let div: HTMLDivElement;
  let client: SyncClient;
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { structuredClone?: unknown }).structuredClone ??= (v: unknown) => JSON.parse(JSON.stringify(v));
    (globalThis.crypto as { randomUUID?: () => string }).randomUUID ??= randomUUID;
  });
  beforeEach(async () => {
    client = new SyncClient({ transport: {} as never, storage: new MemoryStorage(), env: {} });
    await client.ready;
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE_A, title: 'Old', description: 'Kept' });
    div = document.body.appendChild(document.createElement('div'));
    root = createRoot(div);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.dispose();
    document.body.innerHTML = '';
  });
  const render = (node: React.ReactNode) =>
    act(async () => root.render(<SyncClientProvider client={client}>{node}</SyncClientProvider>));
  const last = () => client.pending.at(-1)!;

  // F18: sending both fields would overwrite a description someone else changed meanwhile.
  it('sends only the field that was edited', async () => {
    await render(<Edit />);
    await act(async () => type(div.querySelector('input')!, 'New'));
    await act(async () => {
      div.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(last()).toMatchObject({ name: 'ticket.update', args: { id: TICKET, patch: { title: 'New' } } });
    expect(Object.keys(last().args.patch as object)).toEqual(['title']);
  });

  it('takes a double click on a status button as one change', async () => {
    await render(<Status />);
    const first = () => div.querySelector('button')!;
    expect(first().textContent).toBe('Start work');

    await act(async () => first().click());
    await act(async () => first().click());

    expect(client.rows('ticket')[0]).toMatchObject({ status: 'in_progress' });
    expect(client.pending.filter((m) => m.name === 'ticket.setStatus')).toHaveLength(1);
  });

  it('creates the ticket in the one site the user has now, not the one they had when the page opened', async () => {
    await render(<CreateTicketDialog sites={[{ id: SITE_A, name: 'A' }]} />);
    await render(<CreateTicketDialog sites={[{ id: SITE_B, name: 'B' }]} />);
    await act(async () => div.querySelector('button')!.click());
    await act(async () => type(document.querySelector<HTMLInputElement>('[role=dialog] input')!, 'Pump'));
    await act(async () => {
      document.querySelector('[role=dialog] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(last()).toMatchObject({ name: 'ticket.create', args: { siteId: SITE_B, title: 'Pump' } });
  });
});
