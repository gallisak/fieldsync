'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSyncClient, useSyncState } from './providers';
import { StatusBar } from './status-bar';

export default function HomePage() {
  const client = useSyncClient();
  useSyncState(client);
  const [title, setTitle] = useState('');
  const [siteId, setSiteId] = useState('00000000-0000-4000-8000-0000000000a1');

  if (!client) return <p>Loading…</p>;
  const tickets = client.rows('ticket');

  return (
    <>
      <h1>Tickets</h1>
      <StatusBar client={client} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          client.mutate('ticket.create', { siteId, title: title.trim(), description: '' });
          setTitle('');
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
    </>
  );
}
