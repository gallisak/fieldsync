import type { ReactNode } from 'react';
import { Badge } from '@/shared/ui/badge';
import type { Part } from '../model/types';

export function PartRow({ part, unsynced, actions }: { part: Part; unsynced: boolean; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium">{part.name}</span>
        <span className="text-muted-foreground">× {part.quantity}</span>
        {unsynced && (
          <Badge variant="outline" className="text-muted-foreground">
            Not synced
          </Badge>
        )}
      </div>
      {actions}
    </div>
  );
}
