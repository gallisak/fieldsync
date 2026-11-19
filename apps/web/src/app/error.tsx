'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/shared/ui/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/ui/card';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('fieldsync: a page failed to render', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-5xl p-4">
      <Card>
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>This page could not be shown. Changes you made are kept on this device.</CardDescription>
        </CardHeader>
        <CardFooter className="gap-2">
          <Button onClick={reset}>Try again</Button>
          <Button variant="outline" asChild>
            <Link href="/">Back to tickets</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
