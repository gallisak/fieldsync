import { deriveStatus, type SyncBadge, type SyncFacts } from '../../src';

const calm: SyncFacts = {
  connection: 'online',
  phase: 'idle',
  pendingCount: 0,
  unresolvedRejections: 0,
  blocked: null,
  storage: 'durable',
};

describe('deriveStatus', () => {
  const cases: [string, Partial<SyncFacts>, SyncBadge][] = [
    ['nothing to do', {}, 'synced'],
    ['queued changes', { pendingCount: 2 }, 'pending'],
    ['a request running', { pendingCount: 2, phase: 'pushing' }, 'syncing'],
    ['pulling', { phase: 'pulling' }, 'syncing'],
    ['resyncing', { phase: 'resyncing' }, 'syncing'],
    ['offline wins over syncing and pending', { pendingCount: 2, phase: 'pushing', connection: 'offline' }, 'offline'],
    ['a rejection wins over offline', { pendingCount: 2, connection: 'offline', unresolvedRejections: 1 }, 'rejected'],
    ['blocked wins over everything', { connection: 'offline', unresolvedRejections: 1, blocked: 'error' }, 'error'],
    ['blocked by auth', { blocked: 'auth' }, 'auth'],
    ['blocked by an upgrade', { blocked: 'upgrade', unresolvedRejections: 3 }, 'upgrade'],
    ['memory storage alone is not a badge', { storage: 'memory' }, 'synced'],
  ];

  it.each(cases)('%s', (_label, facts, badge) => {
    expect(deriveStatus({ ...calm, ...facts })).toBe(badge);
  });
});
