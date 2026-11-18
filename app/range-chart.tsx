'use client';

import { useEffect, useRef, useState } from 'react';
import { floorBpsOf, rangeTaxBps, targetMultipleOf, type RangeSchedule } from '../lib/range-tax';

/** 15000 → "$15k", 3284 → "$3.28k"; in SOL when there's no dollar price. */
export function money(sol: number, solUsd: number | null | undefined): string {
  if (!solUsd) return `${Number(sol.toPrecision(3)).toLocaleString('en-US')} SOL`;
  const usd = sol * solUsd;
  if (usd >= 1e6) return `$${Number((usd / 1e6).toPrecision(3))}M`;
  if (usd >= 1e3) return `$${Number((usd / 1e3).toPrecision(3))}k`;
  return `$${Math.round(usd)}`;
}

const pct = (bps: number) => `${Number((bps / 100).toPrecision(3))}%`;

/** Tax (y) against market cap (x): falls to the floor at the target, flat beyond it. */
export default function RangeChart({ schedule, startMcSol, solUsd, nowMcSol }: { schedule: RangeSchedule; startMcSol: number; solUsd?: number | null; nowMcSol?: number | null }) {
  // Drawn in real pixels (1 unit = 1 px), so the labels stay readable from phones to desktops.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = W < 440;
  const H = narrow ? 150 : 176, L = 38, R = 10, T = 14, B = 26;
  const target = startMcSol * targetMultipleOf(schedule);
  const end = Math.max(target * 2, (nowMcSol ?? 0) * 1.1);
  const top = schedule.cliffFeeNumerator / 1e5;
  const floor = floorBpsOf(schedule);
  const x = (mc: number) => L + ((mc - startMcSol) / (end - startMcSol)) * (W - L - R);
  const y = (bps: number) => T + (1 - bps / top) * (H - T - B);
  const pts: string[] = [];
  for (let i = 0; i <= 200; i++) {
    const mc = startMcSol + ((end - startMcSol) * i) / 200;
    pts.push(`${x(mc).toFixed(1)},${y(rangeTaxBps(schedule, startMcSol, mc)).toFixed(1)}`);
  }
  const line = `M${pts.join(' L')}`;
  const now = nowMcSol != null && nowMcSol >= startMcSol ? nowMcSol : null;
  return (
    <div ref={box} className="range-chart-box">
    <svg className="range-chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Tax ${pct(top)} at launch, falling to ${pct(floor)} at ${money(target, solUsd)} market cap`}>
      <line x1={L} x2={W - R} y1={y(top)} y2={y(top)} stroke="var(--line)" />
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="var(--line)" />
      <path d={`${line} L${x(end)},${H - B} L${x(startMcSol)},${H - B} Z`} fill="var(--accent)" opacity="0.08" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" />
      <line x1={x(target)} x2={x(target)} y1={T} y2={H - B} stroke="var(--muted)" strokeDasharray="3 4" />
      <text x={L - 6} y={y(top) + 4} textAnchor="end" className="rc-t">{pct(top)}</text>
      <text x={L - 6} y={y(floor) + 4} textAnchor="end" className="rc-t">{pct(floor)}</text>
      <text x={x(startMcSol)} y={H - 9} className="rc-t">{money(startMcSol, solUsd)}</text>
      <text x={x(target)} y={H - 9} textAnchor="middle" className="rc-t rc-hi">{money(target, solUsd)}</text>
      <text x={W - R} y={H - 9} textAnchor="end" className="rc-t">{money(end, solUsd)}</text>
      <text x={x(target) + 6} y={y(floor) - 8} className="rc-t">{narrow ? 'floor' : 'floor from here up'}</text>
      {now != null ? (
        <g>
          <circle cx={x(Math.min(now, end))} cy={y(rangeTaxBps(schedule, startMcSol, now))} r="5" fill="var(--text)" stroke="var(--bg)" strokeWidth="2" />
          <text x={x(Math.min(now, end)) + 10} y={y(rangeTaxBps(schedule, startMcSol, now)) + (y(rangeTaxBps(schedule, startMcSol, now)) < T + 20 ? 18 : -8)} className="rc-t rc-hi">now</text>
        </g>
      ) : null}
    </svg>
    </div>
  );
}
