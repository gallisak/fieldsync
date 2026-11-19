'use client';

import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// Replaces the root layout, so it cannot use its styles or providers.
export function GlobalErrorPage({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error('fieldsync: the app failed to start', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 480, margin: '4rem auto', padding: '0 1rem' }}>
        <h1 style={{ fontSize: '1.25rem' }}>FieldSync could not start</h1>
        <p>Changes you made are kept on this device. Try again, or reload the page.</p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </body>
    </html>
  );
}
