import type { TicketStatus } from '@fieldsync/sync-core';
import { Badge, type BadgeProps } from '@/shared/ui/badge';

const VARIANT: Record<TicketStatus, BadgeProps['variant']> = {
  open: 'outline',
  in_progress: 'default',
  done: 'secondary',
  cancelled: 'destructive',
};

const LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge variant={VARIANT[status]}>{LABEL[status]}</Badge>;
}
