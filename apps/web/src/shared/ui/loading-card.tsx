import { Card, CardDescription, CardHeader, CardTitle } from './card';
import { Skeleton } from './skeleton';

export function LoadingCard({ title, offline }: { title: string; offline: boolean }) {
  return (
    <Card aria-busy={!offline}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {offline ? 'This device has not synced yet. It loads as soon as it is online.' : 'Loading from the server…'}
        </CardDescription>
        {!offline && <Skeleton className="h-24 w-full" />}
      </CardHeader>
    </Card>
  );
}
