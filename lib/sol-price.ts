/**
 * SOL in US dollars, from keyless public feeds tried in order. Range-tax creators type their
 * target market cap in dollars; the chain only knows SOL, so this is the rate a launch locks in.
 */

export class PriceUnavailableError extends Error {}

const SOURCES: Array<[string, (body: any) => unknown]> = [
  ['https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', (b) => b?.So11111111111111111111111111111111111111112?.usdPrice],
  ['https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', (b) => b?.solana?.usd],
  ['https://api.coinbase.com/v2/prices/SOL-USD/spot', (b) => b?.data?.amount],
];

let cached: { usd: number; at: number } | null = null;

export async function solUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < 60_000) return cached.usd;
  for (const [url, pick] of SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) continue;
      const usd = Number(pick(await res.json()));
      // A sanity band: a feed answering 0 or nonsense must not set anyone's target.
      if (Number.isFinite(usd) && usd > 1 && usd < 100_000) {
        cached = { usd, at: Date.now() };
        return usd;
      }
    } catch {
      /* next feed */
    }
  }
  throw new PriceUnavailableError('Could not get the SOL price right now, so the dollar target can’t be converted. Try again in a moment.');
}
