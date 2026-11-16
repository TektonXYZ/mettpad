'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Create' },
  { href: '/coins', label: 'Coins' },
  { href: '/fees', label: 'Claim tax' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <div className="top">
      <Link href="/" className="brand" style={{ color: 'var(--text)' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect width="24" height="24" rx="7" fill="#86efac" />
          <path d="M6 17V7.5l6 6 6-6V17" fill="none" stroke="#0d1a12" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>
          Met<b>Pad</b>
        </span>
      </Link>
      <nav className="nav">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={path === l.href ? 'on' : ''}>
            {l.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
