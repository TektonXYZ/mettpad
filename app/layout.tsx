import type { Metadata } from 'next';
import './globals.css';
import Nav from './nav';

export const metadata: Metadata = {
  title: 'MetPad — create a coin on Solana',
  description:
    'Launch a coin on Meteora like pump.fun: bonding curve, set your own tax, graduates into a locked DAMM v2 pool.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Nav />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
