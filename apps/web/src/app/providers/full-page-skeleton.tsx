import { Skeleton } from '@/shared/ui/skeleton';

export function FullPageSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4" aria-busy="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
