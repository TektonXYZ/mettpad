'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, decodeTransaction, sendAndConfirm } from '../../lib/api';
import { shortAddress, useWallet } from '../../lib/wallet';
import WalletButton from '../wallet-button';
import { explorer, useSettings } from '../settings';

type Row = {
  mint: string;
  pool: string;
  name: string;
  symbol: string;
  image: string;
  unclaimedSol: number;
  claimedSol: number;
  totalSol: number;
  graduated: boolean;
  error: string | null;
};

type FeesResponse = {
  wallet: string;
  rows: Row[];
  totals: { unclaimedSol: number; claimedSol: number; totalSol: number };
};

export default function FeesPage() {
  const wallet = useWallet();
  const { settings } = useSettings();
  const [data, setData] = useState<FeesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<{ pool: string; signature: string } | null>(null);

  const load = useCallback(
    async (address: string) => {
      setLoading(true);
      setError(null);
      try {
        setData(await api<FeesResponse>(`/api/fees?wallet=${address}`));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load fees.');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (wallet.address) void load(wallet.address);
    else setData(null);
  }, [wallet.address, load]);

  const claim = useCallback(
    async (pool: string, mint: string) => {
      if (!wallet.address) return;
      setClaiming(pool);
      setError(null);
      setClaimed(null);
      try {
        const built = await api<{ transaction: string; lastValidBlockHeight: number }>('/api/build-claim', {
          wallet: wallet.address,
          mint,
        });
        const signed = await wallet.signTransaction(decodeTransaction(built.transaction));
        const signature = await sendAndConfirm(signed, built.lastValidBlockHeight);
        setClaimed({ pool, signature });
        await load(wallet.address);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'The claim failed.';
        setError(/reject|denied|cancel/i.test(message) ? 'You cancelled the signature. Nothing was claimed.' : message);
      } finally {
        setClaiming(null);
      }
    },
    [wallet, load],
  );

  return (
    <>
      <div className="hero">
        <h1>
          Claim your <em>tax</em>.
        </h1>
        <p>
          The tax from every trade sits in each pool until the creator wallet signs for it. Connect the wallet that created the coin
          and claim it in SOL.
        </p>
      </div>

      <div className="top" style={{ padding: '0 0 14px' }}>
        <div className="hint" style={{ margin: 0 }}>
          Tax goes to whichever wallet created each coin.
        </div>
        <WalletButton wallet={wallet} />
      </div>

      {wallet.error ? <div className="notice err">{wallet.error}</div> : null}
      {error ? <div className="notice err">{error}</div> : null}
      {claimed ? (
        <div className="notice ok">
          Claimed.{' '}
          <a href={explorer.tx(claimed.signature, settings?.network ?? 'mainnet')} target="_blank" rel="noreferrer">
            View the transaction ↗
          </a>
        </div>
      ) : null}

      {!wallet.address ? (
        <div className="empty">Connect a wallet to see what it can claim.</div>
      ) : loading && !data ? (
        <div className="empty"><span className="spin" /> Reading pools…</div>
      ) : data && data.rows.length === 0 ? (
        <div className="empty">
          No coins pay this wallet yet. <Link href="/">Launch one.</Link>
        </div>
      ) : null}

      {data && data.rows.length > 0 ? (
        <>
          <div className="card">
            <h2>Total</h2>
            <div className="readout" style={{ marginTop: 0 }}>
              <span className="big">
                <b>{data.totals.unclaimedSol.toFixed(6)} SOL</b> unclaimed
              </span>
              <br />
              {data.totals.claimedSol.toFixed(6)} SOL already claimed · {data.totals.totalSol.toFixed(6)} SOL earned in
              total across {data.rows.length} coin{data.rows.length === 1 ? '' : 's'}
            </div>
          </div>

          <div className="coins">
            {data.rows.map((row) => (
              <div className="coin" key={row.pool}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={row.image} alt="" />
                <div className="meta">
                  <div className="nm">
                    ${row.symbol}
                    <b>{row.name}</b>
                  </div>
                  <div className="sub">
                    {row.error
                      ? row.error
                      : `${row.unclaimedSol.toFixed(6)} SOL unclaimed · ${row.totalSol.toFixed(6)} SOL lifetime${row.graduated ? ' · graduated' : ' · on the curve'}`}
                  </div>
                </div>
                <div className="right">
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    disabled={claiming === row.pool || row.unclaimedSol <= 0}
                    onClick={() => claim(row.pool, row.mint)}
                  >
                    {claiming === row.pool ? <><span className="spin" /> Claiming…</> : 'Claim'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="card" style={{ marginTop: 16 }}>
        <h2>How the tax works</h2>
        <p className="hint" style={{ margin: 0 }}>
          Every MetPad coin starts on Meteora&rsquo;s bonding curve and pays the tax its creator picked, in SOL, on every
          buy and sell. Meteora keeps 20%; the other 80% is the creator&rsquo;s. After graduation the coin trades in a DAMM v2
          pool with locked liquidity, and that pool&rsquo;s fees go to the creator as well. One Claim button collects both.
        </p>
      </div>
    </>
  );
}
