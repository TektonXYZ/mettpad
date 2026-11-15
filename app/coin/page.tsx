'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '../../lib/api';
import { explorer, useSettings } from '../settings';
import RangeChart, { money } from '../range-chart';
import PriceChart, { type Scrub, moment } from '../price-chart';
import type { RangeSchedule } from '../../lib/range-tax';
import { shortAddress } from '../../lib/wallet';
import {
  type Candle,
  type PoolStats,
  type ScreenCoin,
  type Trade,
  LAUNCH_TYPES,
  RESOLUTIONS,
  SUPPLY,
  ago,
  candles,
  finishedCurveOf,
  holders,
  mergeCandles,
  pct,
  poolStats,
  poolsOf,
  rollUp,
  stageOf,
  statsOf,
  taxNow,
  tinyUsd,
  trades,
  usd,
} from '../../lib/market';

type Coin = ScreenCoin;

type PoolState = {
  venue: 'dbc' | 'damm-v2';
  graduated: boolean;
  curveProgress: number;
  priceSol: number;
  marketCapSol: number;
  solInPool: number | null;
  lockedForever?: boolean;
  /** Unix seconds the curve opened (timed tax counts from here). */
  activationPoint?: number;
  /** Range-tax pools: the tax the next trade pays, worked out from the live price the way the pool does. */
  range?: { taxNowBps: number; openingBps: number; floorBps: number; startMarketCapSol: number; targetMarketCapSol: number; schedule: RangeSchedule } | null;
  tax: { creatorSol: number; protocolSol: number; totalSol: number } | null;
};

type Range = '1H' | '6H' | '1D' | '1W' | 'ALL';
const RANGES: { id: Range; seconds: number | null; label: string }[] = [
  { id: '1H', seconds: 3600, label: 'past hour' },
  { id: '6H', seconds: 21600, label: 'past 6 hours' },
  { id: '1D', seconds: 86400, label: 'past day' },
  { id: '1W', seconds: 604800, label: 'past week' },
  { id: 'ALL', seconds: null, label: 'since launch' },
];
type Mode = 'line' | 'candles';

/**
 * The chart's window (a young coin fills the width). Candles come fine enough for a smooth line
 * (≤360 points) and are rolled up for the candle view (≤120), so switching views costs no request.
 */
function windowOf(range: Range, launched: number, now: number) {
  const seconds = RANGES.find((r) => r.id === range)?.seconds ?? Infinity;
  const span = Math.max(600, now - Math.max(now - seconds, launched - 60));
  const pick = (max: number) => RESOLUTIONS.find((r) => span / r.s <= max) ?? RESOLUTIONS[RESOLUTIONS.length - 1];
  const res = pick(360);
  return { from: now - span, to: now, res, limit: span / res.s + 5, bucket: pick(120).s };
}

/** Live readout for a timed-tax coin: the tax steps down once a second, straight from the on-chain schedule. */
function TimedTaxNow({ coin, activationPoint }: { coin: Coin; activationPoint: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  const start = coin.startFeeBps ?? coin.feeBps;
  const seconds = coin.decaySeconds ?? 0;
  const steps = Math.min(seconds, Math.max(0, Math.floor(now - activationPoint)));
  const done = steps >= seconds;
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 250);
    return () => clearInterval(t);
  }, [done]);
  const currentBps = done ? coin.feeBps : start - (steps * (start - coin.feeBps)) / seconds;
  return (
    <>
      <br />
      {done ? (
        <>The timer has run out: the tax is <b>{coin.feeBps / 100}%</b> for good.</>
      ) : (
        <>
          Tax right now: <b id="timed-now">{(currentBps / 100).toFixed(2)}%</b>, reaching {coin.feeBps / 100}% in {seconds - steps}s.
        </>
      )}
    </>
  );
}

function CoinDetail() {
  const mint = useSearchParams().get('mint');
  const { settings } = useSettings();
  const solUsd = settings?.solUsd ?? null;
  const [coin, setCoin] = useState<Coin | null>(null);
  const [state, setState] = useState<PoolState | null>(null);
  const [curveState, setCurveState] = useState<PoolState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [range, setRange] = useState<Range>('ALL');
  const [mode, setMode] = useState<Mode>('line');
  const [series, setSeries] = useState<{ candles: Candle[]; step: number; bucket: number; from: number; to: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [statsMap, setStatsMap] = useState<Map<string, PoolStats>>(new Map());
  const [tradeList, setTradeList] = useState<Trade[] | null>(null);
  const [holderCount, setHolderCount] = useState<number | null>(null);
  const [marketNote, setMarketNote] = useState<string | null>(null);
  const [scrub, setScrub] = useState<Scrub | null>(null);
  const [copied, setCopied] = useState(false);

  // The coin and its pool, every 20 s: price, progress, and the moment it graduates.
  useEffect(() => {
    if (!mint) return;
    let stop = false;
    const load = async (first: boolean) => {
      if (!first && document.hidden) return;
      try {
        const r = await api<{ coins: Coin[] }>(`/api/screener?mint=${mint}`);
        if (stop) return;
        const found = r.coins[0] ?? null;
        if (!found) {
          if (first) setError('This site has no record of that coin.');
          return;
        }
        setCoin(found);
        api<PoolState>(`/api/pool-state?pool=${found.live?.pool ?? found.pool}`)
          .then((s) => !stop && setState(s))
          .catch(() => undefined);
        if (found.live?.gradPool) {
          api<PoolState>(`/api/pool-state?pool=${found.pool}`)
            .then((s) => !stop && setCurveState(s))
            .catch(() => undefined);
        }
      } catch (err) {
        if (first && !stop) setError((err as Error).message);
      }
    };
    load(true);
    const t = setInterval(() => load(false), 20_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [mint]);

  const poolsKey = coin ? poolsOf(coin).join(',') : '';
  const finished = coin ? finishedCurveOf(coin) : null;
  const launched = coin ? Date.parse(coin.createdAt) / 1000 : 0;

  // Candles for the chosen window, from the curve and (once graduated) the DAMM v2 pool, every 30 s.
  useEffect(() => {
    if (!poolsKey) return;
    let stop = false;
    const load = async () => {
      if (document.hidden) return;
      const w = windowOf(range, launched, Math.floor(Date.now() / 1000));
      setBusy(true);
      const got = await Promise.allSettled(
        // A finished curve never changes: ask for all of it once and keep it for ten minutes.
        poolsKey.split(',').map((p) => (p === finished ? candles(p, w.res, 1000, 600_000) : candles(p, w.res, w.limit))),
      );
      if (stop) return;
      setBusy(false);
      const ok = got.flatMap((g) => (g.status === 'fulfilled' ? [g.value] : []));
      if (!ok.length) {
        setMarketNote(((got[0] as PromiseRejectedResult).reason as Error)?.message ?? 'Market data is unavailable right now.');
        return;
      }
      const mc = (k: Candle): Candle => ({ ...k, o: k.o * SUPPLY, h: k.h * SUPPLY, l: k.l * SUPPLY, c: k.c * SUPPLY });
      setSeries({ candles: mergeCandles(ok).map(mc), step: w.res.s, bucket: w.bucket, from: w.from, to: w.to });
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [poolsKey, finished, launched, range]);

  // Volume, % change, trades and holders, every 30 s.
  useEffect(() => {
    if (!poolsKey || !mint) return;
    let stop = false;
    const pools = poolsKey.split(',');
    const load = async () => {
      if (document.hidden) return;
      try {
        const [m, ...lists] = await Promise.all([poolStats(pools), ...pools.map((p) => trades(p, p === finished ? 600_000 : undefined))]);
        if (stop) return;
        setStatsMap(m);
        setTradeList(lists.flat().sort((a, b) => b.t - a.t));
        setMarketNote(null);
      } catch (err) {
        if (!stop) setMarketNote((err as Error).message);
      }
    };
    load();
    holders(mint).then((n) => !stop && setHolderCount(n));
    const t = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [poolsKey, finished, mint]);

  const stats = coin ? statsOf(coin, statsMap) : null;
  const nowMc = coin?.live && solUsd ? coin.live.marketCapSol * solUsd : stats ? stats.priceUsd * SUPPLY : null;
  const startMc = useMemo(() => {
    if (!series) return null;
    const before = [...series.candles].reverse().find((k) => k.t + series.step <= series.from);
    return before?.c ?? series.candles.find((k) => k.t + series.step > series.from)?.o ?? null;
  }, [series]);
  const drawn = useMemo(() => (series && mode === 'candles' ? rollUp(series.candles, series.bucket) : series?.candles ?? []), [series, mode]);

  if (!mint) return <div className="empty">No mint given. <Link href="/coins">Back to the board.</Link></div>;
  if (error) return <div className="notice err">{error}</div>;
  if (!coin) return <div className="empty"><span className="spin" /> Loading…</div>;

  const stage = stageOf(coin);
  const shownMc = scrub?.mc ?? nowMc;
  const delta = shownMc != null && startMc ? (shownMc / startMc - 1) * 100 : null;
  const gradAt = coin.live?.graduated ? coin.live.activationPoint : null;
  const solIn = coin.live?.solInPool ?? null;
  const copy = () => {
    navigator.clipboard?.writeText(coin.mint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="coinx">
      {coin.banner ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={coin.banner} alt="" className="cx-banner" />
      ) : null}

      <div className="cx-main">
        <div className="cx-head">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={coin.image} alt="" />
          <div className="cx-id">
            <h1>
              ${coin.symbol}
              {stage === 'migrated' ? (
                <span className="badge badge-good">Graduated</span>
              ) : stage === 'graduating' ? (
                <span className="badge">Graduating…</span>
              ) : stage === 'pool' ? (
                <span className="badge">DAMM v2 pool</span>
              ) : (
                <span className="badge">Bonding {((coin.live?.curveProgress ?? 0) * 100).toFixed(1)}%</span>
              )}
            </h1>
            <div className="cx-sub">
              <span>{coin.name}</span>
              <button type="button" className="cx-ca" onClick={copy} title="Copy the mint address">
                {copied ? 'Copied' : shortAddress(coin.mint, 5)}
              </button>
              {coin.twitter ? <a href={coin.twitter} target="_blank" rel="noreferrer">X ↗</a> : null}
              {coin.website ? <a href={coin.website} target="_blank" rel="noreferrer">Website ↗</a> : null}
            </div>
          </div>
        </div>
        {coin.description ? <p className="cx-desc">{coin.description}</p> : null}

        <div className="cx-mc">
          <span className="cx-label">Market cap</span>
          <div className="cx-big">{usd(shownMc)}</div>
          <div className={`cx-delta ${delta == null || delta === 0 ? '' : delta > 0 ? 'up' : 'down'}`}>
            {delta == null ? '—' : `${delta > 0 ? '▲' : delta < 0 ? '▼' : ''} ${pct(delta).replace(/^[+−]/, '')}`}
            <span>{scrub ? (scrub.candle ? moment(scrub.candle.t) : 'now') : RANGES.find((r) => r.id === range)?.label}</span>
          </div>
        </div>

        <div className="cx-controls">
          <div className="chips" role="group" aria-label="Chart style">
            {(['line', 'candles'] as const).map((m) => (
              <button key={m} type="button" className={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === 'line' ? 'Line' : 'Candles'}
              </button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.id} type="button" className={range === r.id ? 'on' : ''} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
                {r.id}
              </button>
            ))}
          </div>
        </div>

        {series ? (
          <PriceChart
            candles={drawn}
            from={series.from}
            to={series.to}
            step={mode === 'candles' ? series.bucket : series.step}
            mode={mode}
            now={nowMc}
            gradAt={gradAt}
            busy={busy}
            empty="No trades yet: the price is still where it launched."
            onScrub={setScrub}
          />
        ) : (
          <div className="pc pc-loading">{marketNote ?? <><span className="spin" /> Loading the chart…</>}</div>
        )}
        {marketNote && series ? <div className="scr-note">{marketNote}</div> : null}

        <div className="cx-cta">
          <a className="btn-buy" href={explorer.trade(coin.mint)} target="_blank" rel="noreferrer">Trade on Jupiter ↗</a>
          <a className="btn-ghost btn-sm" href={`https://www.geckoterminal.com/solana/pools/${coin.live?.pool ?? coin.pool}`} target="_blank" rel="noreferrer">GeckoTerminal ↗</a>
          <a className="btn-ghost btn-sm" href={explorer.token(coin.mint, coin.network)} target="_blank" rel="noreferrer">Solscan ↗</a>
        </div>

        <div className="cx-stats">
          <div><span>Price</span><b>{tinyUsd(nowMc != null ? nowMc / SUPPLY : null)}</b></div>
          <div><span>Market cap</span><b>{coin.live ? `${Number(coin.live.marketCapSol.toPrecision(4)).toLocaleString('en-US')} SOL` : '—'}</b></div>
          <div><span>24h volume</span><b>{stats ? usd(stats.volume.h24) : '—'}</b></div>
          <div>
            <span>{coin.live?.venue === 'dbc' ? 'SOL in curve' : 'Liquidity'}</span>
            <b>{solIn == null ? '—' : coin.live?.venue === 'dbc' ? `${solIn.toFixed(2)} SOL` : solUsd ? usd(solIn * 2 * solUsd) : `${(solIn * 2).toFixed(1)} SOL`}</b>
          </div>
          <div><span>Holders</span><b>{holderCount ?? '—'}</b></div>
          <div>
            <span>24h trades</span>
            <b>{stats ? <>{stats.buys24 + stats.sells24} <small><span className="up">{stats.buys24}</span>/<span className="down">{stats.sells24}</span></small></> : '—'}</b>
          </div>
          <div><span>Tax now</span><b>{taxNow(coin)}</b></div>
          <div><span>Launched</span><b>{ago(launched)} ago</b></div>
        </div>

        <div className="card cx-trades">
          <h2>Trades</h2>
          {tradeList === null ? (
            <div className="hint" style={{ margin: 0 }}><span className="spin" /> Loading trades…</div>
          ) : tradeList.length === 0 ? (
            <div className="hint" style={{ margin: 0 }}>No trades in the last 24 hours.</div>
          ) : (
            <div className="tr">
              <div className="tr-row tr-head" aria-hidden="true">
                <span>Type</span>
                <span className="r">Market cap</span>
                <span className="r">SOL</span>
                <span className="r tr-usd">USD</span>
                <span className="tr-who">Trader</span>
                <span className="r">Age</span>
              </div>
              {tradeList.slice(0, 40).map((t) => (
                <a key={`${t.tx}${t.kind}${t.sol}`} className="tr-row" href={explorer.tx(t.tx, coin.network)} target="_blank" rel="noreferrer">
                  <span className={t.kind === 'buy' ? 'up' : 'down'}>{t.kind === 'buy' ? 'Buy' : 'Sell'}</span>
                  <span className="r tnum">{usd(t.priceUsd * SUPPLY)}</span>
                  <span className="r tnum">{t.sol.toFixed(t.sol >= 10 ? 1 : 3)}</span>
                  <span className="r tnum tr-usd">{usd(t.usd)}</span>
                  <span className="tr-who">{shortAddress(t.wallet)}</span>
                  <span className="r">{ago(t.t)}</span>
                </a>
              ))}
            </div>
          )}
          <p className="hint" style={{ margin: '10px 0 0' }}>The last 24 hours of trades, from GeckoTerminal. Click one for Solscan.</p>
        </div>
      </div>

      <aside className="cx-side">
        <div className="card">
          <h2>{state?.venue === 'dbc' && !state.graduated ? 'Bonding curve' : 'Meteora DAMM v2 pool'}</h2>
          {state ? (
            <>
              <div className="readout" style={{ marginTop: 0 }}>
                Market cap <b>{state.marketCapSol.toFixed(2)} SOL</b>
                {state.solInPool != null ? <> · {state.solInPool.toFixed(3)} SOL in it</> : null}
                {state.venue === 'dbc' && !state.graduated ? (
                  <>
                    {' '}· <b>{(state.curveProgress * 100).toFixed(1)}%</b> of the way to graduating
                    {coin.migrationMarketCapSol ? <> at {coin.migrationMarketCapSol} SOL market cap</> : null} into a locked DAMM v2 pool
                  </>
                ) : (
                  <> · liquidity <b>locked forever</b></>
                )}
                {gradAt ? (
                  <div style={{ marginTop: 8 }} id="graduated">
                    <b>Graduated</b> {moment(gradAt)}: its bonding curve filled and Meteora moved it into this pool.
                  </div>
                ) : null}
                {coin.launchType === 'custom-price' && coin.migrationMarketCapSol ? (
                  <div style={{ marginTop: 8 }} id="custom-price">
                    <b>Custom price:</b> opened at <b>{Number((coin.startMarketCapSol / 1e9).toPrecision(3))} SOL</b> a token
                    {solUsd ? <> (≈{money(coin.startMarketCapSol, solUsd)} market cap)</> : null} and migrates at{' '}
                    <b>{Number((coin.migrationMarketCapSol / 1e9).toPrecision(3))} SOL</b> a token{solUsd ? <> (≈{money(coin.migrationMarketCapSol, solUsd)})</> : null}, as its creator set.
                  </div>
                ) : null}
              </div>
              {state.venue === 'dbc' && !state.graduated ? (
                <div className="bar">
                  <i style={{ width: `${Math.min(100, state.curveProgress * 100)}%` }} />
                </div>
              ) : null}
            </>
          ) : (
            <div className="hint" style={{ margin: 0 }}>
              <span className="spin" /> Reading the pool…
            </div>
          )}
        </div>

        <div className="card">
          <h2>Tax</h2>
          {coin.launchType === 'range-tax' && coin.startFeeBps != null && coin.targetMarketCapSol ? (
            <div className="readout" style={{ marginTop: 0 }} id="range-tax">
              <b>Range tax:</b> the tax follows the market cap. It&rsquo;s <b>{coin.startFeeBps / 100}%</b> at the launch price ({money(coin.startMarketCapSol, solUsd)}), falls as the
              market cap climbs, and from <b>{money(coin.targetMarketCapSol, solUsd)}</b> ({Number(coin.targetMarketCapSol.toPrecision(4)).toLocaleString('en-US')} SOL) up it&rsquo;s{' '}
              <b>{coin.feeBps / 100}%</b>. Below that it climbs back the same way. Paid in SOL; 80% goes to the creator, <b style={{ wordBreak: 'break-all' }}>{coin.creator}</b>; Meteora keeps 20%.
              {state?.range ? (
                <>
                  <br />
                  Tax right now: <b id="range-now">{(state.range.taxNowBps / 100).toFixed(2)}%</b> at a {money(state.marketCapSol, solUsd)} market cap.
                </>
              ) : null}
              {state?.tax ? (
                <>
                  <br />
                  Tax earned so far: <b>{state.tax.creatorSol.toFixed(6)} SOL</b> to the creator · {state.tax.protocolSol.toFixed(6)} SOL to Meteora
                </>
              ) : null}
              <RangeChart schedule={state?.range?.schedule ?? (coin.rangeSchedule as RangeSchedule)} startMcSol={state?.range?.startMarketCapSol ?? coin.startMarketCapSol} solUsd={solUsd} nowMcSol={state?.marketCapSol ?? null} />
            </div>
          ) : (
            <div className="readout" style={{ marginTop: 0 }}>
              Every buy and sell pays <b>{coin.feeBps / 100}%</b>
              {coin.launchType === 'timed-tax' && coin.startFeeBps != null && coin.decaySeconds ? (
                <>
                  {' '}once its timer runs out (timed tax: opened at <b>{coin.startFeeBps / 100}%</b> and drops{' '}
                  {Number(((coin.startFeeBps - coin.feeBps) / 100 / coin.decaySeconds).toPrecision(3))}% every second for {coin.decaySeconds} seconds)
                </>
              ) : coin.startFeeBps != null ? (
                <> (opened at <b>{coin.startFeeBps / 100}%</b>, decaying over {Math.round((coin.decaySeconds ?? 0) / 60)} minutes)</>
              ) : null}
              , in SOL
              {coin.launchType === 'migration-tax' && coin.graduatedPoolFeeBps ? (
                <>
                  {' '}while it&rsquo;s on the bonding curve, then <b>{coin.graduatedPoolFeeBps / 100}%</b> once it graduates
                  {state?.graduated ? <> (graduated: <b>{coin.graduatedPoolFeeBps / 100}%</b> now)</> : null}
                </>
              ) : coin.live?.graduated && coin.graduatedPoolFeeBps != null ? (
                <> on the bonding curve; since graduating, the pool charges <b>{coin.graduatedPoolFeeBps / 100}%</b></>
              ) : null}
              . 80% goes to the creator, <b style={{ wordBreak: 'break-all' }}>{coin.creator}</b>; Meteora keeps 20%.
              {coin.launchType === 'timed-tax' && coin.decaySeconds && state?.activationPoint != null && state.venue === 'dbc' && !state.graduated ? (
                <TimedTaxNow coin={coin} activationPoint={state.activationPoint} />
              ) : null}
              {curveState?.tax ? (
                <>
                  <br />
                  Tax earned on the curve: <b>{curveState.tax.creatorSol.toFixed(6)} SOL</b> to the creator · {curveState.tax.protocolSol.toFixed(6)} SOL to Meteora
                </>
              ) : null}
              {state?.tax ? (
                <>
                  <br />
                  {curveState ? 'Pool fees since graduating' : 'Tax earned so far'}: <b>{state.tax.creatorSol.toFixed(6)} SOL</b> to the creator · {state.tax.protocolSol.toFixed(6)} SOL to Meteora
                </>
              ) : null}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <Link href="/fees">
              <button type="button" className="btn-ghost btn-sm">Go to claims</button>
            </Link>
          </div>
        </div>

        <div className="card">
          <h2>Addresses</h2>
          <dl className="kv">
            <dt>Mint</dt>
            <dd><a href={explorer.token(coin.mint, coin.network)} target="_blank" rel="noreferrer">{coin.mint}</a></dd>
            <dt>{coin.live?.gradPool ? 'Curve' : 'Pool'}</dt>
            <dd><a href={explorer.account(coin.pool, coin.network)} target="_blank" rel="noreferrer">{coin.pool}</a></dd>
            {coin.live?.gradPool ? (
              <>
                <dt>Pool</dt>
                <dd><a href={explorer.account(coin.live.gradPool, coin.network)} target="_blank" rel="noreferrer">{coin.live.gradPool}</a></dd>
              </>
            ) : null}
            {coin.position ? (
              <>
                <dt>Position</dt>
                <dd><a href={explorer.account(coin.position, coin.network)} target="_blank" rel="noreferrer">{coin.position}</a></dd>
              </>
            ) : null}
            <dt>Type</dt>
            <dd>{LAUNCH_TYPES[coin.launchType ?? 'standard']}</dd>
            <dt>Launched by</dt>
            <dd>{coin.creator}</dd>
            <dt>Launch tx</dt>
            <dd><a href={explorer.tx(coin.signature, coin.network)} target="_blank" rel="noreferrer">{coin.signature}</a></dd>
          </dl>
        </div>
      </aside>
    </div>
  );
}

export default function CoinPage() {
  return (
    <Suspense fallback={<div className="empty"><span className="spin" /> Loading…</div>}>
      <CoinDetail />
    </Suspense>
  );
}
