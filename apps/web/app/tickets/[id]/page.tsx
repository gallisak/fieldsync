'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ALLOWED_TRANSITIONS, type TicketStatus } from '@fieldsync/sync-core';
import { useSyncClient, useSyncState } from '../../providers';
import { StatusBar } from '../../status-bar';

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const client = useSyncClient();
  useSyncState(client);
  const ticket = client?.view().get(`ticket/${id}`);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [partName, setPartName] = useState('');

  useEffect(() => {
    if (ticket) {
      setTitle(String(ticket.title));
      setDescription(String(ticket.description));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.id]);

  if (!client) return <p>Loading…</p>;
  if (!ticket) return <p>Ticket not found. <Link href="/">Back</Link></p>;

  const siteId = String(ticket.siteId);
  const status = ticket.status as TicketStatus;
  const parts = client.rows('part').filter((p) => p.ticketId === id);

  return (
    <>
      <Link href="/">← All tickets</Link>
      <h1>{String(ticket.title)}</h1>
      <StatusBar client={client} />

      <section>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
        <br />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} cols={50} />
        <br />
        <button onClick={() => client.mutate('ticket.update', { id, siteId, title, description })}>Save</button>
      </section>

      <section>
        <h3>Status: {status}</h3>
        {ALLOWED_TRANSITIONS[status].map((to) => (
          <button key={to} onClick={() => client.mutate('ticket.setStatus', { id, siteId, from: status, to })}>
            {to}
          </button>
        ))}
      </section>

      <section>
        <h3>Parts</h3>
        <ul>
          {parts.map((p) => (
            <li key={String(p.id)}>
              {String(p.name)} × {String(p.quantity)}{' '}
              <button onClick={() => client.mutate('part.adjust', { id: p.id, siteId, delta: 1 })}>+</button>
              <button onClick={() => client.mutate('part.adjust', { id: p.id, siteId, delta: -1 })}>−</button>
            </li>
          ))}
        </ul>
        <input value={partName} onChange={(e) => setPartName(e.target.value)} placeholder="Part name" />
        <button
          onClick={() => {
            if (!partName.trim()) return;
            client.mutate('part.add', { id: crypto.randomUUID(), ticketId: id, siteId, name: partName.trim(), quantity: 1 });
            setPartName('');
          }}
        >
          Add part
        </button>
      </section>

      {client.rejections.length > 0 && (
        <section>
          <h3>Rejected changes</h3>
          <ul>
            {client.rejections.map((r) => (
              <li key={r.mutation.id}>{r.mutation.name}: {r.error}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
