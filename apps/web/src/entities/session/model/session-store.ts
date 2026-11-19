'use client';

import { useSyncExternalStore } from 'react';
import { z } from 'zod';

const KEY = 'fs_session';

const sessionSchema = z.object({
  token: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(['admin', 'technician']),
  sites: z.array(z.object({ id: z.string(), name: z.string() })),
});

export type Session = z.infer<typeof sessionSchema>;

export interface Viewer {
  id: string;
  role: Session['role'];
  sites: Session['sites'];
}

const listeners = new Set<() => void>();
let cached: { raw: string | null; session: Session | null } = { raw: null, session: null };
const viewers = new WeakMap<Session, Viewer>();

export function readSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  if (raw !== cached.raw) {
    let session: Session | null = null;
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(raw ?? 'null'));
      session = parsed.success ? parsed.data : null;
    } catch {
      session = null;
    }
    cached = { raw, session };
  }
  return cached.session;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** `undefined` until the browser's storage has been read (on the server and during hydration). */
export function useSession(): Session | null | undefined {
  return useSyncExternalStore(subscribe, readSession, () => undefined);
}

export function useViewer(): Viewer {
  const session = useSession();
  if (!session) throw new Error('useViewer() is used without a signed-in session');
  let viewer = viewers.get(session);
  if (!viewer) {
    viewer = { id: session.userId, role: session.role, sites: session.sites };
    viewers.set(session, viewer);
  }
  return viewer;
}

export function signIn(session: Session): void {
  localStorage.setItem(KEY, JSON.stringify(session));
  emit();
}

export function signOut(): void {
  localStorage.removeItem(KEY);
  emit();
}
