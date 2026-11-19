'use client';

import { Button } from '@/shared/ui/button';
import { useDismissAll } from '../model/use-dismiss-all';

export function DismissAllButton() {
  const dismissAll = useDismissAll();
  return (
    <Button variant="outline" onClick={() => void dismissAll()}>
      Dismiss all
    </Button>
  );
}
