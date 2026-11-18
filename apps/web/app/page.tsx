'use client';

import Link from 'next/link';
import { useState } from 'react';
import { MutationRejected } from '@fieldsync/sync-core';
import { toast } from 'sonner';
import { SignOutButton } from '@/features/auth/sign-out';
import { useSyncClient, useSyncSelector, useSyncStatus } from '@/shared/api';

const selectView = <T,>(view: T) => view;

function act(action: () => unknown): void {
  try {
    action();
  } catch (err) {
    if (!(err instanceof MutationRejected)) throw err;
    toast.error(err.message);
  }
}

export default function HomePage() {
  const client = useSyncClient();
  useSyncSelector(selectView);
  const { badge, facts } = useSyncStatus();
  const [title, setTitle] = useState('');
  const [siteId, setSiteId] = useState('00000000-0000-4000-8000-0000000000a1');

  const tickets = client.rows('ticket');

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <h1>Tickets</h1>
      <p className="text-sm text-muted-foreground">
        {badge} · {facts.pendingCount} pending
        {facts.storage === 'memory' ? ' · this browser cannot store data: changes are lost on reload' : ''}
      </p>
      <SignOutButton />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          act(() => {
            client.mutate('ticket.create', { id: crypto.randomUUID(), siteId, title: title.trim(), description: '' });
            setTitle('');
          });
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New ticket title" />
        <input value={siteId} onChange={(e) => setSiteId(e.target.value)} size={38} />
        <button type="submit">Create</button>
      </form>
      {tickets.length === 0 && <p>No tickets yet.</p>}
      <ul>
        {tickets.map((t) => (
          <li key={String(t.id)}>
            <Link href={`/tickets/${String(t.id)}`}>{String(t.title)}</Link> — {String(t.status)}
          </li>
        ))}
      </ul>
    </main>
  );
}
