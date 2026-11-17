import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata = { title: 'FieldSync' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f6f7f9' }}>
        <Providers>
          <main style={{ maxWidth: 760, margin: '0 auto', padding: 16 }}>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
