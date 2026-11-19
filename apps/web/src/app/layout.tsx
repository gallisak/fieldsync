import type { ReactNode } from 'react';
import { Toaster } from '@/shared/ui/sonner';
import { ServiceWorkerRegistration } from './providers/service-worker';
import { SessionProvider } from './providers/session-provider';
import { SyncProvider } from './providers/sync-provider';
import './styles/globals.css';

export const metadata = { title: 'FieldSync' };

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <SessionProvider>
          <SyncProvider>{children}</SyncProvider>
        </SessionProvider>
        <Toaster />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
