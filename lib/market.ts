'use client';

/**
 * Market data for the screener and coin pages, from GeckoTerminal's public API: it indexes Meteora
 * bonding curves (meteora-dbc) and DAMM v2 pools. Read-only and straight from the browser, so each
 * visitor has their own rate limit (~30 calls a minute); pages poll gently and keep the last answer.
 */
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';

/** Every MetPad coin mints a billion (TOTAL_SUPPLY in lib/launch-config, which is server-side), so market cap = price × this. */
export const SUPPLY = 1_000_000_000;

const BUSY = 'GeckoTerminal is rate-limiting this browser for a minute; the numbers will catch up.';

/** null = GeckoTerminal hasn't seen this pool yet (a brand-new coin with no trades). */
async function gt<T>(path: string): Promise<T | null> {
  // A 429 comes back without CORS headers, so the browser only sees "Failed to fetch".
  const res = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } }).catch(() => null);
  if (!res || res.status === 429) throw new Error(BUSY);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Market data failed (${res.status}).`);
  return (await res.json()) as T;
}

type Entry = { at: number; ok: boolean; data?: unknown; pending?: Promise<unknown> };
const memo = new Map<string, Entry>();
let pausedUntil = 0;

/**
 * One request per path per ttl, shared by every caller. When GeckoTerminal says no, every call backs
 * off for a minute and pages keep showing the last good answer instead of going blank.
 */
function cached<T>(path: string, ttlMs: number): Promise<T | null> {
  const e = memo.get(path);
  if (e?.pending) return e.pending as Promise<T | null>;
  if (e?.ok && (Date.now() - e.at < ttlMs || Date.now() < pausedUntil)) return Promise.resolve(e.data as T | null);
  if (Date.now() < pausedUntil) return Promise.reject(new Error(BUSY));
  const pending = gt<T>(path).then(
    (data) => {
      memo.set(path, { at: Date.now(), ok: true, data });
      return data;
    },
    (err: Error) => {
      pausedUntil = Date.now() + 60_000;
      if (e?.ok) {
        memo.set(path, e);
        return e.data as T | null;
      }
      memo.delete(path);
      throw err;
    },
  );
  memo.set(path, { ...(e ?? { at: 0, ok: false }), pending });
  return pending;
}

type Windowed = { m5: number; h1: number; h6: number; h24: number };

export type PoolStats = {
  priceUsd: number;
  volume: Windowed;
  /** Percent. */
  change: Windowed;
  buys24: number;
  sells24: number;
  txns1h: number;
  liquidityUsd: number;
  /** Unix seconds. */
  createdAt: number;
};

type GtPool = {
  attributes: {
    address: string;
    base_token_price_usd: string | null;
    volume_usd: Record<string, string | null>;
    price_change_percentage: Record<string, string | null>;
    transactions: Record<string, { buys: number; sells: number } | undefined>;
    reserve_in_usd: string | null;
    pool_created_at: string;
  };
};

const num = (v: unknown) => Number(v) || 0;
const windowed = (r: Record<string, unknown>): Windowed => ({ m5: num(r.m5), h1: num(r.h1), h6: num(r.h6), h24: num(r.h24) });

/** Price, volume, % change and trade counts for any number of pools, 30 per request. */
export async function poolStats(pools: string[], ttlMs = 25_000): Promise<Map<string, PoolStats>> {
  const unique = [...new Set(pools)];
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(unique.length / 30) }, (_, i) => cached<{ data?: GtPool[] }>(`/pools/multi/${unique.slice(i * 30, i * 30 + 30).join(',')}`, ttlMs)),
  );
  const out = new Map<string, PoolStats>();
  for (const { attributes: a } of pages.flatMap((p) => p?.data ?? [])) {
    out.set(a.address, {
      priceUsd: num(a.base_token_price_usd),
      volume: windowed(a.volume_usd),
      change: windowed(a.price_change_percentage),
      buys24: a.transactions.h24?.buys ?? 0,
      sells24: a.transactions.h24?.sells ?? 0,
      txns1h: (a.transactions.h1?.buys ?? 0) + (a.transactions.h1?.sells ?? 0),
      liquidityUsd: num(a.reserve_in_usd),
      createdAt: Date.parse(a.pool_created_at) / 1000,
    });
  }
  return out;
}

const WINDOW_SECONDS: Windowed = { m5: 300, h1: 3600, h6: 21600, h24: 86400 };

/**
 * A graduated coin trades on two pools: its finished curve, then its DAMM v2 pool. Activity adds up;
 * the price is the pool's, and a % change whose window starts before the pool existed is measured
 * from the curve's price at the start of that window.
 */
export function mergeStats(curve: PoolStats | undefined, pool: PoolStats | undefined): PoolStats | null {
  if (!curve || !pool) return pool ?? curve ?? null;
  const now = Date.now() / 1000;
  const change = { ...pool.change };
  for (const k of Object.keys(change) as (keyof Windowed)[]) {
    if (pool.createdAt <= now - WINDOW_SECONDS[k] || !curve.priceUsd) continue;
    const then = curve.priceUsd / (1 + curve.change[k] / 100);
    change[k] = then > 0 ? (pool.priceUsd / then - 1) * 100 : 0;
  }
  const add = (a: Windowed, b: Windowed): Windowed => ({ m5: a.m5 + b.m5, h1: a.h1 + b.h1, h6: a.h6 + b.h6, h24: a.h24 + b.h24 });
  return {
    ...pool,
    change,
    volume: add(curve.volume, pool.volume),
    buys24: curve.buys24 + pool.buys24,
    sells24: curve.sells24 + pool.sells24,
    txns1h: curve.txns1h + pool.txns1h,
    createdAt: curve.createdAt,
  };
}

/** One candle; t = its opening second. Prices are USD per token, v is USD traded. */
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type Resolution = { s: number; tf: 'minute' | 'hour' | 'day'; agg: number };
export const RESOLUTIONS: Resolution[] = [
  { s: 60, tf: 'minute', agg: 1 },
  { s: 300, tf: 'minute', agg: 5 },
  { s: 900, tf: 'minute', agg: 15 },
  { s: 3600, tf: 'hour', agg: 1 },
  { s: 14400, tf: 'hour', agg: 4 },
  { s: 43200, tf: 'hour', agg: 12 },
  { s: 86400, tf: 'day', agg: 1 },
];

/** The most recent candles that had trades (quiet stretches have none), oldest first. */
export async function candles(pool: string, res: Resolution, limit: number, ttlMs = 25_000): Promise<Candle[]> {
  const r = await cached<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
    `/pools/${pool}/ohlcv/${res.tf}?aggregate=${res.agg}&limit=${Math.min(1000, Math.max(1, Math.ceil(limit)))}&currency=usd`,
    ttlMs,
  );
  return (r?.data?.attributes?.ohlcv_list ?? []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })).sort((a, b) => a.t - b.t);
}

/** Rolls candles up into wider ones (s seconds, a multiple of theirs): 1-minute into 5-minute, and so on. */
export function rollUp(list: Candle[], s: number): Candle[] {
  const out: Candle[] = [];
  for (const k of list) {
    const t = Math.floor(k.t / s) * s;
    const last = out[out.length - 1];
    if (last?.t === t) Object.assign(last, { h: Math.max(last.h, k.h), l: Math.min(last.l, k.l), c: k.c, v: last.v + k.v });
    else out.push({ ...k, t });
  }
  return out;
}

/** Candles from a curve and the pool it graduated into, as one series (the curve's come first). */
export function mergeCandles(lists: Candle[][]): Candle[] {
  const byT = new Map<number, Candle>();
  for (const k of lists.flat().sort((a, b) => a.t - b.t)) {
    const prev = byT.get(k.t);
    byT.set(k.t, prev ? { t: k.t, o: prev.o, h: Math.max(prev.h, k.h), l: Math.min(prev.l, k.l), c: k.c, v: prev.v + k.v } : { ...k });
  }
  return [...byT.values()];
}

export type Trade = { t: number; kind: 'buy' | 'sell'; sol: number; usd: number; priceUsd: number; wallet: string; tx: string };

type GtTrade = {
  attributes: {
    block_timestamp: string;
    kind: string;
    from_token_amount: string;
    to_token_amount: string;
    price_from_in_usd: string;
    price_to_in_usd: string;
    volume_in_usd: string;
    tx_hash: string;
    tx_from_address: string;
  };
};

/** The pool's latest trades (GeckoTerminal keeps the last 24 hours), newest first. */
export async function trades(pool: string, ttlMs = 25_000): Promise<Trade[]> {
  const r = await cached<{ data?: GtTrade[] }>(`/pools/${pool}/trades`, ttlMs);
  return (r?.data ?? []).map(({ attributes: a }) => {
    const buy = a.kind === 'buy'; // a buy pays SOL in and takes the coin out; a sell the other way round
    return {
      t: Date.parse(a.block_timestamp) / 1000,
      kind: buy ? 'buy' : 'sell',
      sol: num(buy ? a.from_token_amount : a.to_token_amount),
      usd: num(a.volume_in_usd),
      priceUsd: num(buy ? a.price_to_in_usd : a.price_from_in_usd),
      wallet: a.tx_from_address,
      tx: a.tx_hash,
    };
  });
}

/** Holder count, when GeckoTerminal has counted them. */
export async function holders(mint: string): Promise<number | null> {
  const r = await cached<{ data?: { attributes?: { holders?: { count?: number | null } } } }>(`/tokens/${mint}/info`, 120_000).catch(() => null);
  return r?.data?.attributes?.holders?.count ?? null;
}

/** $1.23M · $45.6K · $8.12K · $812 · $0.42 */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(2)}K`;
  if (a >= 100) return `${sign}$${a.toFixed(0)}`;
  if (a >= 0.01) return `${sign}$${a.toFixed(2)}`;
  return a === 0 ? '$0' : '<$0.01';
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
/** Token prices are tiny, so the zeros get counted: 0.000004072 → $0.0₅4072. */
export function tinyUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 0.01) return usd(n);
  let zeros = Math.floor(-Math.log10(n));
  let digits = Math.round(n * 10 ** (zeros + 4)); // four significant digits
  if (digits >= 10_000) [zeros, digits] = [zeros - 1, Math.round(digits / 10)];
  if (zeros < 4) return `$${n.toFixed(zeros + 3)}`;
  return `$0.0${[...String(zeros)].map((d) => SUB[Number(d)]).join('')}${digits}`;
}

/** A coin as /api/screener returns it: the board's record plus what its pool says right now. */
export type ScreenCoin = {
  mint: string;
  pool: string;
  venue?: 'dbc' | 'damm-v2';
  position?: string;
  name: string;
  symbol: string;
  description: string;
  image: string;
  banner: string | null;
  twitter: string | null;
  website: string | null;
  creator: string;
  feeBps: number;
  startFeeBps: number | null;
  decaySeconds: number | null;
  startMarketCapSol: number;
  migrationMarketCapSol?: number;
  graduatedPoolFeeBps?: number;
  launchType?: 'standard' | 'migration-tax' | 'timed-tax' | 'range-tax' | 'custom-price';
  targetMarketCapSol?: number;
  rangeSchedule?: { cliffFeeNumerator: number; reductionFactor: number; numberOfPeriod: number; sqrtPriceStepBps: number };
  lockLiquidity?: boolean;
  initialLiquiditySol?: number;
  signature: string;
  network: string;
  createdAt: string;
  live: {
    venue: 'dbc' | 'damm-v2';
    pool: string;
    graduated: boolean;
    gradPool: string | null;
    priceSol: number;
    marketCapSol: number;
    curveProgress: number;
    solInPool: number | null;
    activationPoint: number | null;
  } | null;
};

export type Stage = 'bonding' | 'graduating' | 'migrated' | 'pool';

/** On its curve, curve finished (waiting for Meteora's keeper), graduated, or launched straight onto a pool. */
export function stageOf(c: ScreenCoin): Stage {
  if (!c.live) return c.venue === 'damm-v2' || !c.venue ? 'pool' : 'bonding';
  if (c.live.graduated) return 'migrated';
  if (c.live.venue === 'damm-v2') return 'pool';
  return c.live.curveProgress >= 1 ? 'graduating' : 'bonding';
}

/** Where its trades happen and where they used to: the curve and, once graduated, its DAMM v2 pool. */
export const poolsOf = (c: ScreenCoin): string[] => (c.live?.gradPool ? [c.pool, c.live.gradPool] : [c.live?.pool ?? c.pool]);

/** A graduated coin's old curve: nothing trades there any more, so its history can be cached for long. */
export const finishedCurveOf = (c: ScreenCoin): string | null => (c.live?.gradPool ? c.pool : null);

/** A coin's market across its pools (a graduated coin's curve and pool together). */
export const statsOf = (c: ScreenCoin, stats: Map<string, PoolStats>): PoolStats | null =>
  c.live?.gradPool ? mergeStats(stats.get(c.pool), stats.get(c.live.gradPool)) : stats.get(c.live?.pool ?? c.pool) ?? null;

export const LAUNCH_TYPES: Record<NonNullable<ScreenCoin['launchType']>, string> = {
  standard: 'Standard',
  'migration-tax': 'Migration tax',
  'timed-tax': 'Timed tax',
  'range-tax': 'Range tax',
  'custom-price': 'Custom price',
};

const pctOf = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** The tax the next trade pays, as far as the record and the clock can tell. */
export function taxNow(c: ScreenCoin, now = Date.now() / 1000): string {
  if (c.live?.graduated && c.graduatedPoolFeeBps != null) return pctOf(c.graduatedPoolFeeBps);
  if (c.launchType === 'range-tax' && c.startFeeBps != null) return `${pctOf(c.startFeeBps)}→${pctOf(c.feeBps)}`;
  if (c.startFeeBps != null && c.decaySeconds && c.live?.activationPoint) {
    const elapsed = Math.floor(now - c.live.activationPoint);
    if (elapsed >= c.decaySeconds) return pctOf(c.feeBps);
    if (c.launchType === 'timed-tax') return pctOf(c.startFeeBps - ((c.startFeeBps - c.feeBps) * Math.max(0, elapsed)) / c.decaySeconds);
    return `${pctOf(c.startFeeBps)}→${pctOf(c.feeBps)}`;
  }
  return pctOf(c.feeBps);
}

/** +12.3% · −4.5% · +1,193% */
export function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const body = a >= 1000 ? Math.round(a).toLocaleString('en-US') : a >= 100 ? a.toFixed(0) : a.toFixed(1);
  return `${n >= 0 ? '+' : '−'}${body}%`;
}

/** 42s · 5m · 3h · 2d */
export function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A coin's logo at the size it's shown: uploads are full size (often 100–300 KB), so Netlify's image CDN serves a small copy. */
export function thumb(src: string, px: number): string {
  const path = /^https:\/\/(?:mettpad\.com|metpad\.netlify\.app)(\/api\/img\/[\w-]+)$/.exec(src)?.[1];
  return path ? `/.netlify/images?url=${encodeURIComponent(path)}&w=${px}&h=${px}&fit=cover` : src;
}
