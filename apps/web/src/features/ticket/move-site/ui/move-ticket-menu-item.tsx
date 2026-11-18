'use client';

import { useState } from 'react';
import { SiteSelect, type Site } from '@/entities/site';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { DropdownMenuItem } from '@/shared/ui/dropdown-menu';
import { useMoveTicket } from '../model/use-move-ticket';

interface MoveTicketMenuItemProps {
  ticketId: string;
  currentSiteId: string;
  sites: readonly Site[];
}

/** A dropdown menu item: render it inside a `DropdownMenuContent`. */
export function MoveTicketMenuItem({ ticketId, currentSiteId, sites }: MoveTicketMenuItemProps) {
  const [open, setOpen] = useState(false);
  const [toSiteId, setToSiteId] = useState<string>();
  const move = useMoveTicket(ticketId);
  const others = sites.filter((s) => s.id !== currentSiteId);

  if (sites.length < 2 || others.length === 0) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setToSiteId(undefined);
      }}
    >
      <DialogTrigger asChild>
        <DropdownMenuItem onSelect={(e) => e.preventDefault()}>Move to another site…</DropdownMenuItem>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move ticket</DialogTitle>
          <DialogDescription>The ticket and its parts move to the chosen site.</DialogDescription>
        </DialogHeader>
        <SiteSelect sites={others} value={toSiteId} onChange={setToSiteId} />
        <DialogFooter>
          <Button
            disabled={!toSiteId}
            onClick={() => {
              if (toSiteId && move(toSiteId)) setOpen(false);
            }}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
