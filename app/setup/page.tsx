'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, decodeTransaction, sendAndConfirm } from '../../lib/api';
import { useWallet } from '../../lib/wallet';
import WalletButton from '../wallet-button';

type Status = { ready: boolean; address: string | null; addresses: string[] };

/** One-time setup: the frozen lookup table that lets a launch + dev buy fit in one transaction. */
export default function SetupPage() {
  const wallet = useWallet();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Status>('/api/setup-lookup-table').then(setStatus).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    if (!wallet.address) return;
    setBusy(true);
    setError(null);
    try {
      setNote('Building…');
      const built = await api<{ address?: string; transaction?: string; lastValidBlockHeight?: number; ready?: boolean }>('/api/setup-lookup-table', { wallet: wallet.address });
      if (built.ready) return void (await load());
      const signed = await wallet.signTransaction(decodeTransaction(built.transaction!));
      await sendAndConfirm(signed, built.lastValidBlockHeight!, setNote);
      setNote('Checking it on chain…');
      for (let i = 0; i < 10; i++) {
        try {
          await api('/api/setup-lookup-table', { confirm: built.address });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
      setNote('');
    }
  }, [wallet, load]);

  return (
    <>
      <div className="hero">
        <h1>
          One-time <em>setup</em>.
        </h1>
        <p>
          Dev buys make a launch too big for one Solana transaction unless the fixed addresses every launch uses come
          from a lookup table. This creates that table, fills it, and freezes it so nobody can ever change it. It
          costs about 0.006 SOL, once, and works for every coin after.
        </p>
      </div>
      {error ? <div className="notice err">{error}</div> : null}
      {!status ? (
        <div className="empty"><span className="spin" /> Checking…</div>
      ) : status.ready ? (
        <div className="notice ok" id="setup-ready">
          <b>Done.</b> Dev buys are on. Lookup table <code>{status.address}</code>.
        </div>
      ) : (
        <div className="card">
          <h2>Lookup table</h2>
          <p className="hint">It will hold these {status.addresses.length} addresses:</p>
          <dl className="kv" style={{ marginBottom: 16 }}>
            {status.addresses.map((a) => (
              <dd key={a} style={{ gridColumn: '1 / -1' }}>{a}</dd>
            ))}
          </dl>
          <div className="row" style={{ alignItems: 'center' }}>
            <WalletButton wallet={wallet} />
            <button type="button" className="btn-primary btn-create" id="setup-btn" disabled={!wallet.address || busy} onClick={create}>
              {busy ? <><span className="spin" /> {note || 'Working…'}</> : 'Create lookup table · ~0.006 SOL'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
