'use client';

import type { TicketStatus } from '@fieldsync/sync-core';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';
import { useViewer } from '@/entities/session';
import { SiteSelect } from '@/entities/site';
import { TicketRow, usePendingKeys, useTickets } from '@/entities/ticket';
import { CreateTicketDialog } from '@/features/ticket/create';
import { useHasSynced, useSyncStatus } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { LoadingCard } from '@/shared/ui/loading-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/shared/ui/table';
import { STATUS_LABEL, filterTickets, readFilters } from '../model/filters';

const ALL = 'all';

// The router would fetch the page from the server, which offline turns into a full reload; Next keeps
// useSearchParams in step with history.replaceState.
const replaceUrl = (url: string) => window.history.replaceState(null, '', url);

export function TicketTable() {
  return (
    <Suspense>
      <TicketTableContent />
    </Suspense>
  );
}

function TicketTableContent() {
  const tickets = useTickets();
  const { sites } = useViewer();
  const pending = usePendingKeys();
  const params = useSearchParams();
  const pathname = usePathname() ?? '/';
  const synced = useHasSynced();
  const { facts } = useSyncStatus();
  const loading = facts.blocked ? 'stopped' : facts.connection !== 'online' ? 'offline' : 'loading';

  const siteIds = useMemo(() => sites.map((s) => s.id), [sites]);
  const filters = useMemo(() => readFilters(params, siteIds), [params, siteIds]);
  const visible = useMemo(() => filterTickets(tickets, filters), [tickets, filters]);

  const setFilter = (key: 'site' | 'status', value: string | null) => {
    const next = new URLSearchParams(params?.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const query = next.toString();
    replaceUrl(query ? `${pathname}?${query}` : pathname);
  };

  if (tickets.length === 0 && !synced) return <LoadingCard title="Tickets" state={loading} />;
  if (tickets.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No tickets yet</CardTitle>
          <CardDescription>Tickets you create, or that are assigned to your sites, appear here.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateTicketDialog sites={sites} />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {sites.length > 1 && (
          <div className="w-48">
            <SiteSelect
              sites={[{ id: ALL, name: 'All sites' }, ...sites]}
              value={filters.site ?? ALL}
              onChange={(v) => setFilter('site', v === ALL ? null : v)}
            />
          </div>
        )}
        <div className="w-48">
          <Select value={filters.status ?? ALL} onValueChange={(v) => setFilter('status', v === ALL ? null : v)}>
            <SelectTrigger aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto">
          <CreateTicketDialog key={filters.site ?? ALL} sites={sites} defaultSiteId={filters.site ?? undefined} />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="space-y-2 rounded-md border p-6 text-center">
          <p>No tickets match the filters</p>
          <Button variant="outline" onClick={() => replaceUrl(pathname)}>
            Clear filters
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>
                <span className="sr-only">Sync</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((t) => (
              <TicketRow
                key={t.id}
                ticket={t}
                siteName={sites.find((s) => s.id === t.siteId)?.name ?? 'Unknown site'}
                unsynced={pending.has(`ticket/${t.id}`)}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
