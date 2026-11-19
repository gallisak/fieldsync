import type { SyncBadge, SyncFacts } from '@fieldsync/sync-core';
import { badgeDisplay } from '@/widgets/app-header/model/badge-display';

const facts = (pendingCount: number, unresolvedRejections = 0): SyncFacts => ({
  connection: 'online',
  phase: 'idle',
  pendingCount,
  unresolvedRejections,
  blocked: null,
  storage: 'durable',
});

describe('badgeDisplay', () => {
  it.each<[SyncBadge, SyncFacts, string, string | undefined]>([
    ['synced', facts(0), 'All changes saved', undefined],
    ['pending', facts(3), '3 waiting to sync', 'Will be sent automatically.'],
    ['syncing', facts(1), 'Syncing…', undefined],
    ['offline', facts(6), 'Offline · 6 saved on this device', 'Changes are kept and sent when the connection returns.'],
    ['unavailable', facts(2), 'Server unavailable · 2 saved on this device', 'Retrying automatically. Changes are kept.'],
    ['rejected', facts(0, 1), '1 change was rejected', undefined],
    ['rejected', facts(0, 2), '2 changes were rejected', undefined],
    ['auth', facts(2), 'Sign in again', 'Your unsynced changes are kept.'],
    ['upgrade', facts(2), 'Update required', undefined],
    ['error', facts(2), 'Sync stopped', 'Reload the page. Unsynced changes are kept.'],
  ])('%s → "%s"', (badge, f, text, tooltip) => {
    const shown = badgeDisplay(badge, f);
    expect(shown.text).toBe(text);
    expect(shown.tooltip).toBe(tooltip);
  });

  it('colours: green outline, amber, blue, grey, red', () => {
    expect(badgeDisplay('synced', facts(0)).className).toContain('border-green-600');
    expect(badgeDisplay('pending', facts(1)).className).toContain('bg-amber-500');
    expect(badgeDisplay('syncing', facts(1)).className).toContain('bg-blue-600');
    expect(badgeDisplay('offline', facts(1)).className).toContain('bg-slate-200');
    for (const b of ['rejected', 'auth', 'upgrade', 'error'] as const) {
      expect(badgeDisplay(b, facts(1, 1)).className).toContain('bg-destructive');
    }
  });
});
