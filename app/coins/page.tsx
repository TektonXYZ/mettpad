'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useSettings } from '../settings';
import { LAUNCH_TYPES, type PoolStats, type ScreenCoin, type Stage, SUPPLY, ago, pct, poolStats, poolsOf, stageOf, statsOf, taxNow, thumb, usd } from '../../lib/market';

type Tab = 'all' | 'bonding' | 'migrated';
type Sort = 'trending' | 'new' | 'mcap' | 'change' | 'progress';

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'bonding', label: 'Bonding' },
  { id: 'migrated', label: 'Migrated' },
];
const SORTS: { id: Sort; label: string }[] = [
  { id: 'trending', label: 'Trending (24h volume)' },
  { id: 'new', label: 'Newest' },
  { id: 'mcap', label: 'Market cap' },
  { id: 'change', label: '24h change' },
  { id: 'progress', label: 'Closest to graduating' },
];
const REFRESH_MS = 30_000;

type Row = {
  coin: ScreenCoin;
  stage: Stage;
  mcapUsd: number | null;
  change24: number | null;
  vol24: number;
  buys: number;
  sells: number;
  hot: boolean;
  progress: number;
  created: number;
};

function Progress({ row }: { row: Row }) {
  if (row.stage === 'migrated') return <span className="badge badge-good">Graduated</span>;
  if (row.stage === 'graduating') return <span className="badge">Graduating…</span>;
  if (row.stage === 'pool') return <span className="badge">DAMM v2 pool</span>;
  return (
    <span className="prog">
      <span className="bar"><i style={{ width: `${Math.max(2, row.progress * 100)}%` }} /></span>
      <span className="prog-n">{(row.progress * 100).toFixed(row.progress < 0.1 ? 1 : 0)}%</span>
    </span>
  );
}

function Screener() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'all') as Tab;
  const sort = (SORTS.some((s) => s.id === params.get('sort')) ? params.get('sort') : 'trending') as Sort;
  const type = params.get('type') ?? '';
  const [query, setQuery] = useState(params.get('q') ?? '');
  const { settings } = useSettings();
  const solUsd = settings?.solUsd ?? null;

  const [coins, setCoins] = useState<ScreenCoin[] | null>(null);
  const [stats, setStats] = useState<Map<string, PoolStats>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [marketNote, setMarketNote] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    let stop = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    const load = async (followUp = true) => {
      if (document.hidden) return;
      try {
        const r = await api<{ coins: ScreenCoin[]; at: number }>('/api/screener');
        if (stop) return;
        setCoins(r.coins);
        setError(null);
        // An old copy the CDN answered with while it fetches a fresh one: ask again in a moment.
        clearTimeout(again);
        if (followUp && Date.now() - r.at > 20_000) again = setTimeout(() => load(false), 4_000);
        poolStats(r.coins.flatMap(poolsOf), 55_000) // the board's on-chain numbers refresh every 30 s; volume and % change every minute
          .then((m) => !stop && (setStats(m), setMarketNote(null)))
          .catch((err: Error) => !stop && setMarketNote(err.message));
      } catch (err) {
        if (!stop) setError((err as Error).message);
      }
    };
    load();
    const t = setInterval(() => (load(), tick((n) => n + 1)), REFRESH_MS);
    const wake = () => !document.hidden && load();
    document.addEventListener('visibilitychange', wake);
    return () => {
      stop = true;
      clearInterval(t);
      clearTimeout(again);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  const set = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `/coins?${qs}` : '/coins', { scroll: false });
  };

  const rows = useMemo<Row[]>(
    () =>
      (coins ?? []).map((coin) => {
        const s = statsOf(coin, stats);
        const mcapSol = coin.live?.marketCapSol ?? null;
        return {
          coin,
          stage: stageOf(coin),
          mcapUsd: mcapSol != null && solUsd ? mcapSol * solUsd : s ? s.priceUsd * SUPPLY : null,
          change24: s ? s.change.h24 : null,
          vol24: s?.volume.h24 ?? 0,
          buys: s?.buys24 ?? 0,
          sells: s?.sells24 ?? 0,
          hot: (s?.txns1h ?? 0) > 0,
          progress: coin.live?.curveProgress ?? 0,
          created: Date.parse(coin.createdAt) / 1000,
        };
      }),
    [coins, stats, solUsd],
  );

  const counts = useMemo(
    () => ({ all: rows.length, bonding: rows.filter((r) => r.stage === 'bonding' || r.stage === 'graduating').length, migrated: rows.filter((r) => r.stage === 'migrated').length }),
    [rows],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (tab === 'bonding' && r.stage !== 'bonding' && r.stage !== 'graduating') return false;
      if (tab === 'migrated' && r.stage !== 'migrated') return false;
      if (type && (r.coin.launchType ?? 'standard') !== type) return false;
      if (!q) return true;
      return r.coin.symbol.toLowerCase().includes(q.replace(/^\$/, '')) || r.coin.name.toLowerCase().includes(q) || r.coin.mint.toLowerCase() === q;
    });
    const by: Record<Sort, (a: Row, b: Row) => number> = {
      trending: (a, b) => b.vol24 - a.vol24 || b.buys + b.sells - (a.buys + a.sells) || b.created - a.created,
      new: (a, b) => b.created - a.created,
      mcap: (a, b) => (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0),
      change: (a, b) => (b.change24 ?? -Infinity) - (a.change24 ?? -Infinity),
      progress: (a, b) => b.progress - a.progress || (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0),
    };
    return list.sort(by[sort]);
  }, [rows, tab, type, query, sort]);

  const vol24 = rows.reduce((sum, r) => sum + r.vol24, 0);
  const hot = rows.filter((r) => r.hot).length;

  return (
    <div className="screener">
      <div className="hero">
        <h1>
          Coins launched <em>here</em>.
        </h1>
        <p>Every coin launched through MetPad, live from its Meteora pool. Click one for its chart.</p>
      </div>

      <div className="tiles">
        <div className="tile"><span>Coins</span><b>{coins ? rows.length : '—'}</b></div>
        <div className="tile"><span>Migrated</span><b>{coins ? counts.migrated : '—'}</b></div>
        <div className="tile"><span>24h volume</span><b>{stats.size ? usd(vol24) : '—'}</b></div>
        <div className="tile"><span>Traded in the last hour</span><b>{stats.size ? hot : '—'}</b></div>
      </div>

      <div className="scr-bar">
        <div className="tabs" role="tablist" aria-label="Which coins">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => set('tab', t.id, 'all')}>
              {t.label} <span className="n">{coins ? counts[t.id] : ''}</span>
            </button>
          ))}
        </div>
        <div className="scr-tools">
          <input
            type="text"
            className="scr-search"
            placeholder="Search name, $ticker or mint"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => set('q', query.trim(), '')}
            aria-label="Search coins"
          />
          <select value={type} onChange={(e) => set('type', e.target.value, '')} aria-label="Launch type">
            <option value="">All launch types</option>
            {Object.entries(LAUNCH_TYPES).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <select value={sort} onChange={(e) => set('sort', e.target.value, 'trending')} aria-label="Sort by">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && !coins ? <div className="notice err">{error}</div> : null}
      {marketNote ? <div className="scr-note">{marketNote}</div> : null}
      {coins === null && !error ? <div className="empty"><span className="spin" /> Loading the board…</div> : null}

      {coins && shown.length === 0 ? (
        <div className="empty">
          {tab === 'migrated' && !query && !type ? 'No coin has graduated yet. When a curve fills, Meteora moves it into a locked DAMM v2 pool and it shows up here.' : 'Nothing matches.'}{' '}
          {coins.length === 0 ? <Link href="/">Launch the first one.</Link> : null}
        </div>
      ) : null}

      {shown.length ? (
        <div className="scr" role="list">
          <div className="scr-row scr-head" aria-hidden="true">
            <span>Coin</span>
            <span className="r">Market cap</span>
            <span className="r">24h</span>
            <span className="r c-vol">Volume</span>
            <span className="r c-txns">Txns</span>
            <span className="c-prog">Bonding</span>
            <span className="r c-tax">Tax</span>
            <span className="r c-age">Age</span>
          </div>
          {shown.map((r) => (
            <Link key={r.coin.mint} href={`/coin?mint=${r.coin.mint}`} className="scr-row" role="listitem">
              <span className="c-coin">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumb(r.coin.image, 72)}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    if (e.currentTarget.src !== r.coin.image) e.currentTarget.src = r.coin.image;
                  }}
                />
                <span className="c-id">
                  <b>
                    ${r.coin.symbol}
                    {r.hot ? <i className="live-dot" title="Traded in the last hour" /> : null}
                  </b>
                  <span className="c-name">{r.coin.name}</span>
                  <span className="c-mob"><Progress row={r} /></span>
                </span>
              </span>
              <span className="r tnum">
                {usd(r.mcapUsd)}
                <span className="c-sub">{r.coin.live ? `${Number(r.coin.live.marketCapSol.toPrecision(3))} SOL` : ''}</span>
              </span>
              <span className={`r tnum ${r.change24 == null || r.change24 === 0 ? '' : r.change24 > 0 ? 'up' : 'down'}`}>
                {r.change24 == null ? '—' : r.change24 === 0 ? '0%' : `${r.change24 > 0 ? '▲' : '▼'} ${pct(r.change24).slice(1)}`}
              </span>
              <span className="r tnum c-vol">{r.vol24 ? usd(r.vol24) : '—'}</span>
              <span className="r tnum c-txns">
                {r.buys + r.sells ? (
                  <>
                    {r.buys + r.sells}
                    <span className="c-sub"><span className="up">{r.buys}</span> / <span className="down">{r.sells}</span></span>
                  </>
                ) : '—'}
              </span>
              <span className="c-prog"><Progress row={r} /></span>
              <span className="r c-tax">
                {taxNow(r.coin)}
                <span className="c-sub">{LAUNCH_TYPES[r.coin.launchType ?? 'standard']}</span>
              </span>
              <span className="r c-age">{ago(r.created)}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {coins?.length ? <p className="scr-foot">Prices and progress are read from each coin&rsquo;s Meteora pool; volume, trades and % change come from GeckoTerminal. Updates every 30 seconds.</p> : null}
    </div>
  );
}

export default function CoinsPage() {
  return (
    <Suspense fallback={<div className="empty"><span className="spin" /> Loading…</div>}>
      <Screener />
    </Suspense>
  );
}
