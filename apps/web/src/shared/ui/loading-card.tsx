import { Card, CardDescription, CardHeader, CardTitle } from './card';
import { Skeleton } from './skeleton';

export type LoadingState = 'loading' | 'offline' | 'stopped';

const TEXT: Record<LoadingState, string> = {
  loading: 'Loading from the server…',
  offline: 'This device has not synced yet. It loads as soon as it is online.',
  stopped: 'Sync has stopped before anything was loaded. See the status in the header.',
};

export function LoadingCard({ title, state }: { title: string; state: LoadingState }) {
  const loading = state === 'loading';
  return (
    <Card aria-busy={loading}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{TEXT[state]}</CardDescription>
        {loading && <Skeleton className="h-24 w-full" />}
      </CardHeader>
    </Card>
  );
}
