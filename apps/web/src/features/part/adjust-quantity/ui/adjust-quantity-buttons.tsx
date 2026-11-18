'use client';

import { Minus, Plus } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { useAdjustQuantity } from '../model/use-adjust-quantity';

export function AdjustQuantityButtons({ partId, quantity }: { partId: string; quantity: number }) {
  const adjust = useAdjustQuantity(partId);
  return (
    <div className="flex gap-1">
      <Button
        variant="outline"
        size="icon"
        aria-label="Decrease quantity"
        disabled={quantity === 0}
        onClick={() => adjust(-1)}
      >
        <Minus />
      </Button>
      <Button variant="outline" size="icon" aria-label="Increase quantity" onClick={() => adjust(1)}>
        <Plus />
      </Button>
    </div>
  );
}
