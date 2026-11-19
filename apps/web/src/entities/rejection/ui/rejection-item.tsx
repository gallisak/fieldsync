import type { StoredRejection } from '@fieldsync/sync-core';
import type { ReactNode } from 'react';
import { formatRelative } from '@/shared/lib/relative-time';
import { describeMutation, describeRejection } from '../model/messages';

interface RejectionItemProps {
  rejection: StoredRejection;
  actions?: ReactNode;
}

export function RejectionItem({ rejection, actions }: RejectionItemProps) {
  const { title, hint } = describeRejection(rejection);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm text-muted-foreground">{describeMutation(rejection.mutation)}</p>
      <p className="font-medium">{title}</p>
      <p className="text-sm">{hint}</p>
      <div className="flex items-center justify-between gap-2">
        <time dateTime={rejection.at} className="text-xs text-muted-foreground">
          {formatRelative(rejection.at)}
        </time>
        {actions}
      </div>
    </div>
  );
}
