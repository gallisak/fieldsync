'use client';

import Link from 'next/link';
import { useCallback, type ReactElement } from 'react';
import { RejectionItem, useRejections } from '@/entities/rejection';
import { DismissAllButton, ResolveRejectionActions } from '@/features/rejection/resolve';
import { useSyncSelector } from '@/shared/api';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/ui/sheet';
import { groupRejections } from '../model/group-rejections';

export function RejectionInbox({ trigger }: { trigger: ReactElement }) {
  const rejections = useRejections();
  const groups = useSyncSelector(useCallback((view) => groupRejections(rejections, view), [rejections]));

  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Rejected changes</SheetTitle>
          <SheetDescription>The server refused these changes. They are not applied.</SheetDescription>
        </SheetHeader>
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing was rejected.</p>
        ) : (
          <ScrollArea className="-mx-6 flex-1 px-6">
            <div className="space-y-6 pb-4">
              {groups.map((g) => (
                <section key={g.ticketId ?? 'unknown'} className="space-y-2">
                  <h3 className="font-medium">
                    {g.ticketId && g.title !== null ? (
                      <Link href={`/tickets/${g.ticketId}`} className="hover:underline">
                        {g.title}
                      </Link>
                    ) : g.notCreated !== null ? (
                      `Not created: ${g.notCreated}`
                    ) : (
                      'Deleted ticket'
                    )}
                  </h3>
                  {g.rejections.map((r) => (
                    <RejectionItem
                      key={r.id}
                      rejection={r}
                      actions={<ResolveRejectionActions rejection={r} />}
                    />
                  ))}
                </section>
              ))}
            </div>
          </ScrollArea>
        )}
        {groups.length > 0 && (
          <SheetFooter>
            <DismissAllButton />
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
