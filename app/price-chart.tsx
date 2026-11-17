'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { type Candle, usd } from '../lib/market';

/** What the pointer is over: a moment on the chart, the market cap then, and its candle. */
export type Scrub = { t: number; mc: number; candle: Candle | null };

type Props = {
  /** Market-cap candles (o/h/l/c in USD; v = USD traded), oldest first; may start before the window. */
  candles: Candle[];
  /** The window, unix seconds. */
  from: number;
  to: number;
  /** Seconds per candle. */
  step: number;
  mode: 'line' | 'candles';
  /** Market cap right now (USD): where the line ends. */
  now: number | null;
  /** When the curve graduated into its DAMM v2 pool. */
  gradAt?: number | null;
  /** Refetching: the last frame stays up, dimmed. */
  busy?: boolean;
  empty?: string | null;
  onScrub?: (s: Scrub | null) => void;
};

const TIME_STEPS = [60, 300, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
}

/** Axis labels drop trailing zeros: $4.00K → $4K, $2.50K → $2.5K. */
const tick = (v: number) => usd(v).replace(/(\.\d*?)0+([KMB])$/, '$1$2').replace(/\.([KMB])$/, '$1');
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const day = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const moment = (t: number) => `${day(t)}, ${clock(t)}`;

/** A fomo-style market-cap chart: a line (or candles) over volume, with a crosshair you can scrub. */
export default function PriceChart({ candles, from, to, step, mode, now, gradAt, busy, empty, onScrub }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const gradId = useId().replace(/:/g, '');
  const [W, setW] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = W < 560;
  const H = narrow ? 250 : 330;
  const L = 6, R = narrow ? 52 : 62, T = 14, B = 24;
  const volH = narrow ? 34 : 48;
  const priceBottom = H - B - volH - 10;
  const volBottom = H - B;
  const span = Math.max(1, to - from);
  const x = (t: number) => L + ((t - from) / span) * (W - L - R);

  const g = useMemo(() => {
    const inWin = candles.filter((k) => k.t + step > from && k.t <= to);
    const before = [...candles].reverse().find((k) => k.t + step <= from) ?? null;
    // Anchors the pointer snaps to: each candle's close (its middle, drawn as candles), then "now".
    const anchors: Scrub[] = inWin.map((k) => ({ t: mode === 'candles' ? k.t + step / 2 : Math.min(to, k.t + step), mc: k.c, candle: k }));
    const pts: [number, number][] = [];
    if (before) pts.push([from, before.c]);
    for (const k of inWin) pts.push([Math.max(from, k.t), k.o], [Math.min(to, k.t + step), k.c]);
    const last = now ?? inWin[inWin.length - 1]?.c ?? before?.c ?? null;
    if (last != null && pts.length) pts.push([to, last]);
    // No trades at all: the price hasn't moved from where it opened, so the line is flat.
    if (!pts.length && now != null) pts.push([from, now], [to, now]);
    if (now != null) anchors.push({ t: to, mc: now, candle: null });

    const values = mode === 'candles' ? inWin.flatMap((k) => [k.h, k.l]).concat(now != null ? [now] : []) : pts.map(([, v]) => v);
    let lo = values.length ? Math.min(...values) : 0;
    let hi = values.length ? Math.max(...values) : 1;
    if (hi - lo < hi * 0.02) [lo, hi] = [hi * 0.95, hi * 1.05 || 1];
    const pad = (hi - lo) * 0.1;
    lo = Math.max(0, lo - pad);
    hi += pad;
    const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (priceBottom - T);

    const first = pts[0]?.[1] ?? inWin[0]?.o ?? 0;
    const up = (last ?? 0) >= first;
    const line = pts.length ? `M${pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('L')}` : '';
    const area = pts.length ? `${line}L${x(pts[pts.length - 1][0]).toFixed(1)},${priceBottom}L${x(pts[0][0]).toFixed(1)},${priceBottom}Z` : '';

    const ystep = niceStep((hi - lo) / 5);
    const yticks: number[] = [];
    for (let v = Math.ceil(lo / ystep) * ystep; v <= hi; v += ystep) yticks.push(v);

    const tstep = TIME_STEPS.find((s) => span / s <= Math.max(3, Math.floor((W - L - R) / 120))) ?? 604800;
    const tz = -new Date().getTimezoneOffset() * 60;
    const xticks: number[] = [];
    for (let t = Math.ceil((from + tz) / tstep) * tstep - tz; t < to; t += tstep) if (x(t) > L + 24 && x(t) < W - R - 24) xticks.push(t);

    const vmax = Math.max(1e-9, ...inWin.map((k) => k.v));
    const slot = ((W - L - R) * step) / span;
    return { inWin, before, anchors, line, area, y, up, yticks, xticks, tstep, vmax, slot, last };
  }, [candles, from, to, step, mode, now, W]); // eslint-disable-line react-hooks/exhaustive-deps

  const color = g.up ? 'var(--accent)' : 'var(--bad)';
  const anchor = hover != null ? g.anchors[hover] ?? null : null;
  const pick = (i: number | null) => {
    setHover(i);
    onScrub?.(i == null ? null : g.anchors[i] ?? null);
  };
  const nearest = (px: number) => {
    if (!g.anchors.length) return null;
    const t = from + ((px - L) / (W - L - R)) * span;
    let best = 0;
    g.anchors.forEach((a, i) => Math.abs(a.t - t) < Math.abs(g.anchors[best].t - t) && (best = i));
    return best;
  };

  const bodyW = Math.max(1, Math.min(10, g.slot * 0.7));
  const volW = Math.max(1, Math.min(10, g.slot - 2));
  const labelOf = (t: number) => (g.tstep >= 86400 ? day(t) : clock(t));
  const isEmpty = !g.inWin.length && !g.before;
  const gradX = gradAt != null && gradAt > from && gradAt < to ? x(gradAt) : null;

  return (
    <div ref={box} className={`pc${busy ? ' busy' : ''}`}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        tabIndex={0}
        aria-label={isEmpty ? 'No trades yet' : `Market cap from ${usd(g.anchors[0]?.mc)} to ${usd(g.last)}`}
        onPointerMove={(e) => pick(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
        onPointerLeave={() => pick(null)}
        onKeyDown={(e) => {
          if (!g.anchors.length) return;
          if (e.key === 'ArrowLeft') pick(Math.max(0, (hover ?? g.anchors.length) - 1));
          else if (e.key === 'ArrowRight') pick(Math.min(g.anchors.length - 1, (hover ?? -1) + 1));
          else if (e.key === 'Escape') pick(null);
          else return;
          e.preventDefault();
        }}
        onBlur={() => pick(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.16" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {g.yticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={g.y(v)} y2={g.y(v)} className="pc-grid" />
            <text x={W - R + 8} y={g.y(v) + 4} className="pc-t">{tick(v)}</text>
          </g>
        ))}
        <line x1={L} x2={W - R} y1={volBottom} y2={volBottom} className="pc-grid" />
        {g.xticks.map((t) => (
          <text key={t} x={x(t)} y={H - 7} textAnchor="middle" className="pc-t">{labelOf(t)}</text>
        ))}

        {g.inWin.map((k) => {
          const h = Math.max(1, (k.v / g.vmax) * volH);
          return <rect key={`v${k.t}`} x={x(k.t + step / 2) - volW / 2} width={volW} y={volBottom - h} height={h} rx={volW > 4 ? 1.5 : 0} className={k.c >= k.o ? 'pc-vol up' : 'pc-vol down'} />;
        })}

        {gradX != null ? (
          <g>
            <line x1={gradX} x2={gradX} y1={T} y2={volBottom} className="pc-grad" />
            <text x={gradX + (gradX > W - R - 90 ? -6 : 6)} y={T + 10} textAnchor={gradX > W - R - 90 ? 'end' : 'start'} className="pc-t pc-label">
              Graduated
            </text>
          </g>
        ) : null}

        {mode === 'line' ? (
          <>
            <path d={g.area} fill={`url(#${gradId})`} />
            <path d={g.line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          </>
        ) : (
          g.inWin.map((k) => {
            const cx = x(k.t + step / 2);
            const top = g.y(Math.max(k.o, k.c));
            return (
              <g key={`c${k.t}`} className={k.c >= k.o ? 'pc-candle up' : 'pc-candle down'}>
                <line x1={cx} x2={cx} y1={g.y(k.h)} y2={g.y(k.l)} />
                <rect x={cx - bodyW / 2} width={bodyW} y={top} height={Math.max(1, g.y(Math.min(k.o, k.c)) - top)} rx={bodyW > 4 ? 1 : 0} />
              </g>
            );
          })
        )}

        {now != null && !anchor ? (
          <g>
            <circle cx={x(to)} cy={g.y(now)} r="4" fill={color} className="pc-pulse" />
            <circle cx={x(to)} cy={g.y(now)} r="4" fill={color} stroke="var(--panel)" strokeWidth="2" />
          </g>
        ) : null}

        {anchor ? (
          <g>
            <line x1={x(anchor.t)} x2={x(anchor.t)} y1={T} y2={volBottom} className="pc-cross" />
            <circle cx={x(anchor.t)} cy={g.y(anchor.mc)} r="4" fill={color} stroke="var(--panel)" strokeWidth="2" />
          </g>
        ) : null}
      </svg>

      {anchor ? (
        <div className="pc-tip" style={{ left: Math.min(Math.max(0, x(anchor.t) + 12), W - 176) }}>
          <b>{usd(anchor.mc)}</b>
          <span>{anchor.candle ? moment(anchor.candle.t) : 'Now'}</span>
          {anchor.candle && mode === 'candles' ? (
            <span className="pc-ohlc">
              O {usd(anchor.candle.o)} · H {usd(anchor.candle.h)}
              <br />L {usd(anchor.candle.l)} · C {usd(anchor.candle.c)}
            </span>
          ) : null}
          {anchor.candle ? <span>Volume {usd(anchor.candle.v)}</span> : null}
        </div>
      ) : null}

      {isEmpty && empty ? <div className="pc-empty">{empty}</div> : null}
    </div>
  );
}
