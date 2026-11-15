'use client';

import type { Transaction, VersionedTransaction } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';

export type Provider = {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect(): Promise<void>;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions?(txs: Transaction[]): Promise<Transaction[]>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
};

type Detected = { provider: Provider; name: string };

/** Uses whichever Solana wallet the browser already injected — no adapter bundle. */
function detect(): Detected | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, any>;
  if (w.phantom?.solana?.isPhantom) return { provider: w.phantom.solana, name: 'Phantom' };
  if (w.solflare?.isSolflare) return { provider: w.solflare, name: 'Solflare' };
  if (w.backpack?.isBackpack) return { provider: w.backpack, name: 'Backpack' };
  if (w.solana) return { provider: w.solana, name: w.solana.isPhantom ? 'Phantom' : 'Wallet' };
  return null;
}

export function useWallet() {
  const [detected, setDetected] = useState<Detected | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Extensions inject late on a cold load, so look again shortly after mount.
    let cancelled = false;
    const look = () => {
      if (cancelled) return;
      const found = detect();
      if (found) {
        setDetected(found);
        found.provider.connect({ onlyIfTrusted: true })
          .then((r) => !cancelled && setAddress(r.publicKey.toBase58()))
          .catch(() => undefined);
      }
    };
    look();
    const t1 = setTimeout(look, 400);
    const t2 = setTimeout(look, 1200);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  useEffect(() => {
    const p = detected?.provider;
    if (!p?.on) return;
    const onDisconnect = () => setAddress(null);
    const onAccountChanged = (...args: unknown[]) => {
      const key = args[0] as { toBase58(): string } | null;
      setAddress(key ? key.toBase58() : null);
    };
    p.on('disconnect', onDisconnect);
    p.on('accountChanged', onAccountChanged);
    return () => {
      p.removeListener?.('disconnect', onDisconnect);
      p.removeListener?.('accountChanged', onAccountChanged);
    };
  }, [detected]);

  const connect = useCallback(async () => {
    const found = detected ?? detect();
    if (!found) {
      setError('No Solana wallet found in this browser. Install Phantom, then reload.');
      return;
    }
    setDetected(found);
    setConnecting(true);
    setError(null);
    try {
      const res = await found.provider.connect();
      setAddress(res.publicKey.toBase58());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Wallet connection was rejected.';
      setError(/reject|denied|cancel/i.test(message) ? 'Connection cancelled in the wallet.' : message);
    } finally {
      setConnecting(false);
    }
  }, [detected]);

  const disconnect = useCallback(async () => {
    try {
      await detected?.provider.disconnect();
    } catch {
      /* wallets differ on whether this resolves; the UI state is what matters */
    }
    setAddress(null);
  }, [detected]);

  const signTransaction = useCallback(
    async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (!detected) throw new Error('No wallet connected.');
      return detected.provider.signTransaction(tx);
    },
    [detected],
  );

  /** One wallet prompt for several transactions, falling back to one prompt each. */
  const signAllTransactions = useCallback(
    async (txs: Transaction[]): Promise<Transaction[]> => {
      if (!detected) throw new Error('No wallet connected.');
      if (detected.provider.signAllTransactions) return detected.provider.signAllTransactions(txs);
      const out: Transaction[] = [];
      for (const tx of txs) out.push(await detected.provider.signTransaction(tx));
      return out;
    },
    [detected],
  );

  return {
    address,
    walletName: detected?.name ?? null,
    available: Boolean(detected),
    connecting,
    error,
    connect,
    disconnect,
    signTransaction,
    signAllTransactions,
    clearError: () => setError(null),
  };
}

export function shortAddress(value: string, size = 4): string {
  return value.length <= size * 2 + 1 ? value : `${value.slice(0, size)}…${value.slice(-size)}`;
}
