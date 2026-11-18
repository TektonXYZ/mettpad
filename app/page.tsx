'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, decodeTransaction, decodeVersioned, encodePartial, sendAndConfirm } from '../lib/api';
import { prepareImage } from '../lib/image';
import { shortAddress, useWallet } from '../lib/wallet';
import WalletButton from './wallet-button';
import { explorer, useSettings } from './settings';
import RangeChart, { money } from './range-chart';
import { rangeSchedule, rangeTaxBps } from '../lib/range-tax';

type BuiltLaunch = {
  launchId: string;
  versioned: boolean;
  /** Range tax: two transactions (coin, then pool), signed together in one wallet prompt. */
  rangeTax?: boolean;
  transactions: string[];
  mint: string;
  config: string | null;
  pool: string;
  lastValidBlockHeight: number;
  launchFeeSol: number;
  treasury: string;
  network: string;
};

type Uploaded = { id: string; uri: string; image: string; banner: string | null };
type Done = { mint: string; pool: string; signature: string; network: string; creator: string; symbol: string; rangeTax: boolean };
/** A range-tax launch whose coin landed but whose pool didn't: "Finish launch" rebuilds just the pool. */
type Unfinished = { mint: string; symbol: string; payload: Record<string, unknown> };
type LinkCheck = { kind: 'metadata' | 'no-image' | 'page' | 'unreachable'; image?: string | null; status?: number | null };
type CurvePreview = { graduationSol: number; startMarketCapSol: number };
type PriceUnit = 'usd' | 'sol';

const TOTAL_SUPPLY = 1_000_000_000;

const STEPS = ['Uploading artwork', 'Approve in your wallet', 'Creating the coin on Meteora', 'Listing it'];

const SolMark = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle cx="9" cy="9" r="9" fill="#0b0c10" />
    <path d="M5 6.2h7.4l-1.4 1.4H3.6zM5 11.8h7.4l-1.4-1.4H3.6zM6.4 9.7h7.4L15 8.3H7.8z" fill="#5be0b2" />
  </svg>
);

const TAX_PRESETS = ['0.5', '1', '2', '3', '5', '10'];
const PRE_TAX_PRESETS = ['1', '3', '5', '10', '25', '50', '99'];
const POST_TAX_PRESETS = ['1', '2', '3', '5', '10'];
const DEV_BUY_PRESETS = ['0', '0.5', '1', '2', '5'];
const START_TAX_PRESETS = ['25', '50', '75', '90', '99'];
const TARGET_PRESETS: [string, string][] = [['10000', '$10k'], ['15000', '$15k'], ['25000', '$25k'], ['50000', '$50k'], ['100000', '$100k']];
/** "Migrates at" shortcuts on the Custom price tab: that many times the starting price. */
const MULTIPLE_PRESETS = [5, 10, 25, 50, 100];
const TIMER_PRESETS: [string, string][] = [['30', '30s'], ['60', '1m'], ['174', '2m 54s'], ['300', '5m'], ['600', '10m'], ['1800', '30m']];

/** 174 → "2m 54s". */
function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', sec || (!h && !m) ? `${sec}s` : ''].filter(Boolean).join(' ');
}

/** A token price as typed text, never in exponent form: 0.00000315 → "0.00000315", 1234.5 → "1234.5". */
function plainNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1) return String(Number(n.toPrecision(6)));
  const decimals = Math.min(20, Math.ceil(-Math.log10(n)) + 3); // 4 significant digits
  return n.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/** 0.5 → "0.5", 0.04971 → "0.0497". */
function formatPct(n: number): string {
  return String(Number(n.toPrecision(3)));
}

function readImage(file: File | null | undefined, onPick: (file: File | null) => void) {
  if (file && /^image\/(png|jpeg|gif|webp)$/.test(file.type)) onPick(file);
}

export default function LaunchPage() {
  const wallet = useWallet();
  const { settings } = useSettings();

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [bio, setBio] = useState('');
  const [xLink, setXLink] = useState('');
  const [website, setWebsite] = useState('');

  const [pfp, setPfp] = useState<File | null>(null);
  const [pfpPreview, setPfpPreview] = useState<string | null>(null);
  const [banner, setBanner] = useState<File | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);

  const [feePct, setFeePct] = useState('1');
  const [launchType, setLaunchType] = useState<'migration-tax' | 'timed-tax' | 'range-tax' | 'custom-price'>('migration-tax');
  const [priceUnit, setPriceUnit] = useState<PriceUnit>('usd');
  const [startPrice, setStartPrice] = useState('');
  const [gradPrice, setGradPrice] = useState('');
  const [rangeStartPct, setRangeStartPct] = useState('50');
  const [targetUsd, setTargetUsd] = useState('15000');
  const [unfinished, setUnfinished] = useState<Unfinished | null>(null);
  const [timedStartPct, setTimedStartPct] = useState('90');
  const [timerSeconds, setTimerSeconds] = useState('174');
  const [postFeePct, setPostFeePct] = useState('1');
  const [socialsOpen, setSocialsOpen] = useState(false);
  const [metaLinkOpen, setMetaLinkOpen] = useState(false);
  const [metaLink, setMetaLink] = useState('');
  const [linkCheck, setLinkCheck] = useState<LinkCheck | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [decayOn, setDecayOn] = useState(false);
  const [openFeePct, setOpenFeePct] = useState('40');
  const [decayMinutes, setDecayMinutes] = useState('10');

  const [startMc, setStartMc] = useState('30');
  const [gradMc, setGradMc] = useState('400');
  const [devBuy, setDevBuy] = useState('0');
  const [gradFeeBps, setGradFeeBps] = useState('100');
  const [curve, setCurve] = useState<CurvePreview | null>(null);
  const [curveError, setCurveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepIndex, setStepIndex] = useState(-1);
  const [stepNote, setStepNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const pickImage = useCallback(
    async (file: File | null, which: 'pfp' | 'banner') => {
      setError(null);
      if (!file) return;
      let dataUrl: string;
      try {
        // Coin image: 1000 px is what launchpads and wallets display. Banner: wide, so allow more.
        dataUrl = (await prepareImage(file, which === 'pfp' ? 1000 : 1500)).dataUrl;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not use that image.');
        return;
      }
      if (which === 'pfp') {
        setPfp(file);
        setPfpPreview(dataUrl);
      } else {
        setBanner(file);
        setBannerPreview(dataUrl);
      }
    },
    [],
  );

  const feeBps = Math.round(Number(feePct) * 100);
  const openFeeBps = Math.round(Number(openFeePct) * 100);

  const devShare = useMemo(() => {
    const cut = settings?.protocolFeeCutPercent ?? 20;
    return (Number(feePct) * (100 - cut)) / 100;
  }, [feePct, settings]);

  const solUsd = settings?.solUsd ?? null;
  const customPrice = launchType === 'custom-price';
  // Prices in dollars need today's SOL price; without it the Custom price tab works in SOL.
  const unit: PriceUnit = priceUnit === 'usd' && solUsd ? 'usd' : 'sol';
  /** Token price (in the tab's unit) ↔ market cap in SOL, which is what the curve is set in. */
  const priceToMc = (price: number) => Number(((price * TOTAL_SUPPLY) / (unit === 'usd' ? solUsd! : 1)).toPrecision(10));
  const mcToPrice = (mc: number, u: PriceUnit = unit) => (mc * (u === 'usd' ? solUsd! : 1)) / TOTAL_SUPPLY;
  const showPrice = (price: number, u: PriceUnit = unit) => (Number.isFinite(price) && price > 0 ? (u === 'usd' ? `$${plainNumber(price)}` : `${plainNumber(price)} SOL`) : '—');
  const startPriceNum = Number(startPrice);
  const gradPriceNum = Number(gradPrice);
  const startMcNum = customPrice ? priceToMc(startPriceNum) : Number(startMc);
  const gradMcNum = customPrice ? priceToMc(gradPriceNum) : Number(gradMc);
  const startMcOk = Number.isFinite(startMcNum) && startMcNum >= 5;
  const gradOk = Number.isFinite(gradMcNum) && gradMcNum > startMcNum * 2;
  const migrationTax = launchType === 'migration-tax';
  const timedTax = launchType === 'timed-tax';
  const timedStartNum = Number(timedStartPct);
  const timerNum = Math.round(Number(timerSeconds));
  const timedStartOk = Number.isFinite(timedStartNum) && timedStartNum <= 99 && timedStartNum > Number(feePct);
  const timerOk = Number.isFinite(timerNum) && timerNum >= 10 && timerNum <= 64_800;
  /** Percentage points the timed tax loses every second. */
  const dropPerSecond = timedStartOk && timerOk ? (timedStartNum - Number(feePct)) / timerNum : 0;
  const postFeeNum = Number(postFeePct);
  const postFeeOk = !migrationTax || (Number.isFinite(postFeeNum) && postFeeNum >= 0.1 && postFeeNum <= 10);
  const devBuyNum = devBuy.trim() === '' ? 0 : Number(devBuy);
  const devBuyOk = Number.isFinite(devBuyNum) && devBuyNum >= 0 && devBuyNum <= 100 && (devBuyNum === 0 || devBuyNum >= 0.001);

  // The creator's own metadata link (the token's `uri` on Solscan); empty = MetPad's /m/<id> link.
  const metaLinkUri = useMemo(() => {
    const raw = metaLink.trim();
    if (!raw) return null;
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw.replace(/^https:\/\//i, 'https://') : `https://${raw}`;
  }, [metaLink]);
  // Every character of the link is a byte of the one launch transaction (Solana caps it at 1232).
  // Measured 2026-10-18 with a 32-character name and 10-character ticker: a link of up to 100
  // characters fits, 49 with a dev buy, and each name or ticker character left unused frees one
  // more. Range tax puts the coin in a transaction of its own: Metaplex's 200-character maximum.
  const linkRoom = launchType === 'range-tax'
    ? 200
    : Math.min(200, (devBuyNum > 0 ? 49 : 100) + (32 - new TextEncoder().encode(name.trim()).length) + (10 - symbol.trim().length));
  const metaLinkFormatError = !metaLinkUri
    ? null
    : !/^https:\/\/[^/?#\s]+\.[^/?#\s]+/.test(metaLinkUri)
      ? 'The link has to be an https:// web address.'
      : !/^[\x21-\x7e]+$/.test(metaLinkUri)
        ? 'Use a plain web link, with no spaces.'
        : null;
  const metaLinkError =
    metaLinkFormatError ??
    (metaLinkUri && metaLinkUri.length > linkRoom
      ? `${metaLinkUri.length - linkRoom} characters too long to fit in the launch transaction${devBuyNum > 0 ? ' with a dev buy' : ''}. A shorter name or ticker frees room too.`
      : null);
  const rangeTax = launchType === 'range-tax';
  const rangeStartNum = Number(rangeStartPct);
  const rangeStartOk = Number.isFinite(rangeStartNum) && rangeStartNum <= 99 && rangeStartNum > Number(feePct);
  const targetUsdNum = Number(targetUsd);
  const targetUsdOk = Number.isFinite(targetUsdNum) && targetUsdNum >= 1000 && targetUsdNum <= 1e9;
  const targetSol = solUsd && targetUsdOk ? targetUsdNum / solUsd : null;
  // Without a live SOL price the form can't check this; the server does either way.
  const targetAboveStart = targetSol == null || !startMcOk || targetSol >= startMcNum * (settings?.minRangeMultiple ?? 1.1);
  const rangeOk = !rangeTax || (rangeStartOk && targetUsdOk && targetAboveStart);
  /** The schedule the pool will get (the server re-derives it at launch with that moment's SOL price). */
  const preview = useMemo(
    () => (rangeTax && rangeStartOk && targetSol && startMcOk && targetAboveStart && Number(feePct) >= 0.25 ? rangeSchedule(Math.round(rangeStartNum * 100), Math.round(Number(feePct) * 100), targetSol / startMcNum) : null),
    [rangeTax, rangeStartOk, rangeStartNum, feePct, targetSol, startMcOk, startMcNum, targetAboveStart],
  );
  const launchFee = settings?.launchFeeSol ?? 0.025;

  // Live curve numbers (SOL needed to graduate), debounced.
  useEffect(() => {
    if (!startMcOk || !gradOk || rangeTax) {
      setCurve(null);
      setCurveError(null);
      return;
    }
    const t = setTimeout(() => {
      api<CurvePreview>('/api/curve-preview', {
        feeBps: feeBps >= 25 ? feeBps : 100,
        startMarketCapSol: startMcNum,
        migrationMarketCapSol: gradMcNum,
        graduatedPoolFeeBps: Number(gradFeeBps),
      })
        .then((c) => {
          setCurve(c);
          setCurveError(null);
        })
        .catch((e) => {
          setCurve(null);
          // The server's own refusal (e.g. too little SOL to graduate) is shown under the form.
          setCurveError(e instanceof Error && !/failed with|non-JSON/.test(e.message) ? e.message : null);
        });
    }, 350);
    return () => clearTimeout(t);
  }, [feeBps, startMcNum, gradMcNum, gradFeeBps, startMcOk, gradOk, rangeTax]);

  // Does the creator's own metadata link serve token metadata? Debounced; a warning, never a block.
  useEffect(() => {
    setLinkCheck(null);
    if (!metaLinkUri || metaLinkFormatError) return;
    let stale = false;
    const t = setTimeout(() => {
      api<LinkCheck>(`/api/check-link?url=${encodeURIComponent(metaLinkUri)}`)
        .then((c) => !stale && setLinkCheck(c))
        .catch(() => !stale && setLinkCheck({ kind: 'unreachable' }));
    }, 600);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [metaLinkUri, metaLinkFormatError]);

  const ready =
    Boolean(wallet.address) &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    Boolean(pfp) &&
    Number.isFinite(feeBps) &&
    !metaLinkError &&
    !busy;

  const launch = useCallback(async () => {
    if (!wallet.address) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setStepIndex(0);
      const uploaded = await api<Uploaded>('/api/upload', {
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: bio.trim(),
        twitter: xLink.trim() || null,
        website: website.trim() || null,
        pfp: pfpPreview,
        banner: bannerPreview,
      });

      const payload = {
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        uri: metaLinkUri ?? uploaded.uri,
        metaId: uploaded.id,
        feeBps,
        startFeeBps: rangeTax ? Math.round(rangeStartNum * 100) : timedTax ? Math.round(timedStartNum * 100) : decayOn ? openFeeBps : null,
        decaySeconds: rangeTax ? null : timedTax ? timerNum : decayOn ? Math.round(Number(decayMinutes) * 60) : null,
        timedTax,
        rangeTax,
        targetMarketCapUsd: rangeTax ? targetUsdNum : null,
        startMarketCapSol: startMcNum,
        migrationMarketCapSol: gradMcNum,
        graduatedPoolFeeBps: Number(gradFeeBps),
        postGradFeeBps: migrationTax ? Math.round(postFeeNum * 100) : null,
        devBuySol: devBuyNum,
      };

      setStepIndex(1);
      if (rangeTax) {
        await rangeLaunch(payload, null, uploaded);
        return;
      }
      if (devBuyNum > 0) {
        // The very first dev buy on MetPad also creates the shared lookup table that lets
        // launch + dev buy fit in one transaction. One extra approval, once for the whole site.
        const status = await api<{ ready: boolean }>('/api/setup-lookup-table');
        if (!status.ready) {
          setStepNote('one-time setup for dev buys (~0.006 SOL, never asked again)');
          const setup = await api<{ address?: string; transaction?: string; lastValidBlockHeight?: number; ready?: boolean }>('/api/setup-lookup-table', { wallet: wallet.address });
          if (!setup.ready) {
            const signedSetup = await wallet.signTransaction(decodeTransaction(setup.transaction!));
            await sendAndConfirm(signedSetup, setup.lastValidBlockHeight!, setStepNote);
            setStepNote('activating dev buys…');
            let adopted = false;
            for (let i = 0; i < 15 && !adopted; i++) {
              await new Promise((r) => setTimeout(r, 1500)); // a lookup table is usable from the next slot
              adopted = await api('/api/setup-lookup-table', { confirm: setup.address }).then(() => true, () => false);
            }
            if (!adopted) throw new Error('The dev-buy setup landed but is not active yet. Press Create again in a few seconds.');
          }
          setStepNote('');
        }
      }
      const built = await api<BuiltLaunch>('/api/build-launch', { ...payload, creator: wallet.address });
      // The wallet signs first (Phantom warns about transactions someone else already signed),
      // then the server adds the signatures of the two new accounts the launch creates.
      const unsigned = built.versioned ? decodeVersioned(built.transactions[0]) : decodeTransaction(built.transactions[0]);
      const walletSigned = await wallet.signTransaction(unsigned);
      const cosigned = await api<{ transaction: string }>('/api/cosign', { launchId: built.launchId, transaction: encodePartial(walletSigned) });
      const signed = built.versioned ? decodeVersioned(cosigned.transaction) : decodeTransaction(cosigned.transaction);

      setStepIndex(2);
      const signature = await sendAndConfirm(signed, built.lastValidBlockHeight, setStepNote);

      setStepIndex(3);
      setStepNote('');
      const listing = {
        ...payload,
        creator: wallet.address,
        mint: built.mint,
        pool: built.pool,
        config: built.config,
        description: bio.trim(),
        image: uploaded.image,
        banner: uploaded.banner,
        twitter: xLink.trim() || null,
        website: website.trim() || null,
        signature,
      };
      // RPC nodes can lag a few seconds behind a fresh confirmation; keep asking before giving up.
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await api('/api/record', listing);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }

      setStepIndex(STEPS.length);
      setDone({ mint: built.mint, pool: built.pool, signature, network: built.network, creator: wallet.address, symbol: payload.symbol, rangeTax: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The launch failed.';
      setError(/reject|denied|cancel/i.test(message) ? 'You cancelled in your wallet. Nothing was spent.' : message);
      setStepIndex(-1);
    } finally {
      setBusy(false);
      setStepNote('');
    }
  }, [wallet, name, symbol, bio, xLink, website, metaLinkUri, pfpPreview, bannerPreview, decayOn, openFeeBps, feeBps, decayMinutes, startMcNum, gradMcNum, gradFeeBps, devBuyNum, migrationTax, postFeeNum, timedTax, timedStartNum, timerNum, rangeTax, rangeStartNum, targetUsdNum]);

  /**
   * Range tax: the wallet approves both transactions at once (coin, then pool), then they land in
   * order. With `finishMint`, only the pool, for a coin whose first transaction landed alone.
   */
  async function rangeLaunch(payload: Record<string, unknown>, finishMint: string | null, uploaded: Uploaded | null) {
    if (!wallet.address) return;
    const built = await api<BuiltLaunch>('/api/build-launch', { ...payload, creator: wallet.address, ...(finishMint ? { resumeMint: finishMint } : {}) });
    const unsigned = built.transactions.map(decodeTransaction);
    const walletSigned = unsigned.length > 1 ? await wallet.signAllTransactions(unsigned) : [await wallet.signTransaction(unsigned[0])];
    const cosigned = await api<{ transactions: string[] }>('/api/cosign', { launchId: built.launchId, transactions: walletSigned.map(encodePartial) });

    setStepIndex(2);
    let signature = '';
    let coinLanded = Boolean(finishMint);
    try {
      for (let i = 0; i < cosigned.transactions.length; i++) {
        const part = cosigned.transactions.length > 1 ? (i === 0 ? 'the coin (1 of 2): ' : 'its pool (2 of 2): ') : 'its pool: ';
        signature = await sendAndConfirm(decodeTransaction(cosigned.transactions[i]), built.lastValidBlockHeight, (m) => setStepNote(part + m));
        if (i === 0) coinLanded = true;
      }
    } catch (err) {
      if (coinLanded) {
        setUnfinished({ mint: built.mint, symbol: String(payload.symbol), payload });
        const why = err instanceof Error ? err.message : 'it did not land';
        throw new Error(`$${String(payload.symbol)} was created, but its pool transaction didn't land (${why}). Press “Finish launch” to open the pool. The coin step won't run, or cost anything, again.`);
      }
      throw err;
    }
    setUnfinished(null);

    setStepIndex(3);
    setStepNote('');
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await api('/api/record', { mint: built.mint, creator: wallet.address, signature, image: uploaded?.image });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
    }
    setStepIndex(STEPS.length);
    setDone({ mint: built.mint, pool: built.pool, signature, network: built.network, creator: wallet.address, symbol: String(payload.symbol), rangeTax: true });
  }

  const finishLaunch = async () => {
    if (!unfinished || !wallet.address) return;
    setBusy(true);
    setError(null);
    try {
      setStepIndex(1);
      await rangeLaunch(unfinished.payload, unfinished.mint, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Finishing the launch failed.';
      setError(/reject|denied|cancel/i.test(message) ? 'You cancelled in your wallet. Nothing was spent.' : message);
      setStepIndex(-1);
    } finally {
      setBusy(false);
      setStepNote('');
    }
  };

  if (done) {
    return (
      <>
        <div className="hero">
          <h1>
            <em>${done.symbol}</em> is live.
          </h1>
          <p>
            {done.rangeTax
              ? 'The coin is trading in its Meteora DAMM v2 pool, and your tax builds up from the first trade, following its market cap.'
              : 'The coin is trading on its Meteora bonding curve, and your tax builds up from the first trade.'}
          </p>
        </div>
        <div className="notice ok">
          <b>Launched on {done.network}.</b> It trades on Meteora right away; Jupiter and other aggregators can take a few minutes to index a brand-new pool.
        </div>
        <div className="card">
          <h2>Addresses</h2>
          <dl className="kv">
            <dt>Mint</dt>
            <dd>
              <a href={explorer.token(done.mint, done.network)} target="_blank" rel="noreferrer">
                {done.mint}
              </a>
            </dd>
            <dt>Pool</dt>
            <dd>
              <a href={explorer.account(done.pool, done.network)} target="_blank" rel="noreferrer">
                {done.pool}
              </a>
            </dd>
            <dt>Tax goes to</dt>
            <dd>{done.creator}</dd>
            <dt>Transaction</dt>
            <dd>
              <a href={explorer.tx(done.signature, done.network)} target="_blank" rel="noreferrer">
                {shortAddress(done.signature, 12)}
              </a>
            </dd>
          </dl>
        </div>
        <div className="row">
          <Link href="/coins" className="picker">
            <button type="button" className="btn-ghost" style={{ width: '100%' }}>
              See the board
            </button>
          </Link>
          <Link href="/fees" className="picker">
            <button type="button" className="btn-ghost" style={{ width: '100%' }}>
              Claim fees
            </button>
          </Link>
          <div className="picker">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setDone(null);
                setName('');
                setSymbol('');
                setBio('');
                setXLink('');
                setWebsite('');
                setMetaLink('');
                setPfp(null);
                setPfpPreview(null);
                setBanner(null);
                setBannerPreview(null);
                setStepIndex(-1);
              }}
            >
              Create another
            </button>
          </div>
        </div>
      </>
    );
  }

  const taxNum = Number(feePct);
  const taxOk = Number.isFinite(taxNum) && taxNum >= 0.25 && taxNum <= 99;
  const cut = settings?.protocolFeeCutPercent ?? 20;
  const hasPreview = Boolean(name || symbol || bio || pfpPreview);

  return (
    <div className="create">
      <div className="create-main">
        <div className="lbl-row">
          <h1 className="ttl">Create new coin</h1>
          <WalletButton wallet={wallet} />
        </div>

        {wallet.error ? <div className="notice err">{wallet.error}</div> : null}
        {error ? <div className="notice err">{error}</div> : null}
        {unfinished ? (
          <div className="notice" id="finish-launch">
            <b>${unfinished.symbol} is waiting for its pool.</b> The coin exists and holds its whole supply in your wallet; one more approval opens its
            Meteora pool, locks it and lists it.{' '}
            <button type="button" className="btn-primary btn-sm" disabled={busy || !wallet.address} onClick={finishLaunch}>
              Finish launch
            </button>
          </div>
        ) : null}
        <h3>Coin details</h3>
        <p className="sub">Choose carefully, these can&rsquo;t be changed once the coin is created</p>

        <div className="box" id="card-coin">
          <div className="row">
            <div className="field">
              <label htmlFor="name">Coin name</label>
              <input id="name" type="text" value={name} maxLength={32} placeholder="Name your coin" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="symbol">Ticker</label>
              <input
                id="symbol"
                type="text"
                value={symbol}
                maxLength={10}
                placeholder="Add a coin ticker (e.g. DOGE)"
                onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="bio">
              Description <span className="opt">(Optional)</span>
            </label>
            <textarea id="bio" value={bio} maxLength={1000} placeholder="Write a short description" onChange={(e) => setBio(e.target.value)} />
          </div>

          <button type="button" className="toggle-line" aria-expanded={socialsOpen} onClick={() => setSocialsOpen((o) => !o)}>
            🔗 Add social links <span className="opt">(Optional)</span> <span className="chev">⌄</span>
          </button>
          {socialsOpen ? (
            <div className="row" style={{ marginTop: 10 }}>
              <div className="field">
                <label htmlFor="x">X link</label>
                <input id="x" type="text" value={xLink} placeholder="x.com/yourcoin" onChange={(e) => setXLink(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="web">Website</label>
                <input id="web" type="text" value={website} placeholder="yourcoin.fun" onChange={(e) => setWebsite(e.target.value)} />
              </div>
            </div>
          ) : null}

          <button type="button" className="toggle-line" style={{ display: 'flex', marginTop: 6 }} aria-expanded={metaLinkOpen} onClick={() => setMetaLinkOpen((o) => !o)}>
            ⛓ Custom metadata link <span className="opt">(Optional)</span> <span className="chev">⌄</span>
          </button>
          {/* Stays open while the link has a problem: it's what keeps Create disabled. */}
          {metaLinkOpen || metaLinkError ? (
            <div className="field" style={{ marginTop: 10 }} id="card-metalink">
              <label htmlFor="metalink">
                Metadata link <span className="opt">(the coin&rsquo;s uri on Solscan)</span>
              </label>
              <input
                id="metalink"
                type="text"
                value={metaLink}
                placeholder="https://yourcoin.fun/token.json"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setMetaLink(e.target.value)}
              />
              {metaLinkUri ? (
                <div className="chars">
                  {metaLinkUri.length}/{linkRoom}
                </div>
              ) : null}
              <p className="hint" style={{ margin: 0, ...(metaLinkError ? { color: 'var(--bad)' } : {}) }} id="metalink-note">
                {!metaLinkUri ? (
                  <>
                    Leave it empty and it points at MetPad (mettpad.com/m/&hellip;). Wallets and explorers load the coin&rsquo;s picture from this link, so it should
                    serve token metadata (JSON with an <code>image</code>). It can&rsquo;t be changed after launch.
                  </>
                ) : metaLinkError ? (
                  metaLinkError
                ) : !linkCheck ? (
                  <>Checking the link&hellip;</>
                ) : linkCheck.kind === 'metadata' ? (
                  <span style={{ color: 'var(--good)' }}>✓ Serves token metadata with a picture: wallets and explorers will show it.</span>
                ) : (
                  <>
                    ⚠{' '}
                    {linkCheck.kind === 'no-image'
                      ? 'This is metadata without an image, so'
                      : linkCheck.kind === 'page'
                        ? 'This is a web page, not token metadata. Solscan will show the link, but'
                        : `Couldn’t open this link${linkCheck.status ? ` (HTTP ${linkCheck.status})` : ''}. Unless it serves token metadata by launch,`}{' '}
                    wallets and explorers won&rsquo;t show your coin&rsquo;s picture. MetPad still shows the one you upload here.
                  </>
                )}
              </p>
            </div>
          ) : null}

          <div className="field" style={{ marginTop: 18 }}>
            <label>Pool liquidity pair</label>
            <div className="pairs" role="radiogroup" aria-label="Pool liquidity pair">
              <button type="button" className="pair on" role="radio" aria-checked="true" id="pair-sol">
                <SolMark /> SOL
              </button>
            </div>
            <p className="pair-note">ⓘ Every MetPad coin is paired with SOL. That&rsquo;s the only pair.</p>
          </div>

          {rangeTax ? (
            <div className="readout" id="card-liquidity" style={{ marginTop: 14 }}>
              <b>No bonding curve: straight into a Meteora DAMM v2 pool.</b> Your coin opens at a {startMcOk ? startMcNum.toLocaleString() : '—'} SOL
              {startMcOk && solUsd ? ` (≈${money(startMcNum, solUsd)})` : ''} market cap with all 1,000,000,000 tokens in the pool, so people can buy
              and sell from the first second and nobody has to deposit SOL. The pool&rsquo;s liquidity is <b>locked forever</b>, and it never
              graduates: this pool is the coin&rsquo;s permanent home.
            </div>
          ) : (
            <div className="readout" id="card-liquidity" style={{ marginTop: 14 }}>
              <b>Starts with liquidity, like pump.fun.</b> Your coin opens on Meteora&rsquo;s bonding curve at a{' '}
              {startMcOk ? startMcNum.toLocaleString() : '—'} SOL market cap with virtual liquidity, so people can buy and sell from the
              first second and nobody has to deposit SOL. When {curve ? <b>{curve.graduationSol.toFixed(1)} SOL</b> : 'enough SOL'} has
              been bought in, it graduates into a Meteora DAMM v2 pool whose liquidity is <b>locked forever</b>.
            </div>
          )}

          <div className="tax" id="card-tax">
            <div className="seg" role="tablist" aria-label="Launch type" style={{ marginTop: 0, marginBottom: 14 }}>
              {/* Standard = migration tax: one tax on the curve, its own tax after graduation. */}
              <button type="button" role="tab" id="type-standard" aria-selected={migrationTax} className={`segbtn${migrationTax ? ' on' : ''}`} onClick={() => setLaunchType('migration-tax')}>
                Standard
              </button>
              <button
                type="button"
                role="tab"
                id="type-timed"
                aria-selected={timedTax}
                className={`segbtn${timedTax ? ' on' : ''}`}
                onClick={() => {
                  setLaunchType('timed-tax');
                  // Start from the classic shape (90% → 3%, 0.5% a second) unless the dev already picked a lower tax.
                  if (feePct === '1' || !(Number(feePct) < Number(timedStartPct))) setFeePct('3');
                }}
              >
                Timed tax
              </button>
              <button
                type="button"
                role="tab"
                id="type-range"
                aria-selected={rangeTax}
                className={`segbtn${rangeTax ? ' on' : ''}`}
                onClick={() => {
                  setLaunchType('range-tax');
                  // Start from the classic shape (50% → 1% at $15k) unless the floor is already below the opening tax.
                  if (!(Number(feePct) < Number(rangeStartPct))) setFeePct('1');
                }}
              >
                Range tax
              </button>
              <button
                type="button"
                role="tab"
                id="type-price"
                aria-selected={customPrice}
                className={`segbtn${customPrice ? ' on' : ''}`}
                onClick={() => {
                  setLaunchType('custom-price');
                  // Open on the prices the curve already had (30 → 400 SOL market cap by default).
                  if (!startPrice || !gradPrice) {
                    const u: PriceUnit = solUsd ? priceUnit : 'sol';
                    setStartPrice(plainNumber(mcToPrice(Number(startMc) || 30, u)));
                    setGradPrice(plainNumber(mcToPrice(Number(gradMc) || 400, u)));
                  }
                }}
              >
                Custom price
              </button>
            </div>
            {customPrice ? (
              <div style={{ marginBottom: 16 }} id="card-price">
                <div className="tax-head">
                  <label htmlFor="startprice">Starting price (per token)</label>
                  <span className="tax-val">{showPrice(startPriceNum)}</span>
                </div>
                <div className="tax-inputs wrap">
                  <div className="num" style={{ width: 200 }}>
                    <input id="startprice" type="number" min="0" step="any" placeholder="0.000005" value={startPrice} onChange={(e) => setStartPrice(e.target.value)} />
                    <span>{unit === 'usd' ? 'USD' : 'SOL'}</span>
                  </div>
                  <div className="presets" style={{ margin: 0 }} role="radiogroup" aria-label="Price unit">
                    {(['usd', 'sol'] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        role="radio"
                        aria-checked={unit === u}
                        id={`unit-${u}`}
                        className={unit === u ? 'on' : ''}
                        disabled={u === 'usd' && !solUsd}
                        onClick={() => {
                          if (u === unit) return;
                          // Keep the same market caps, just say them in the other unit.
                          if (startPriceNum > 0) setStartPrice(plainNumber(mcToPrice(startMcNum, u)));
                          if (gradPriceNum > 0) setGradPrice(plainNumber(mcToPrice(gradMcNum, u)));
                          setPriceUnit(u);
                        }}
                      >
                        {u === 'usd' ? '$ USD' : 'SOL'}
                      </button>
                    ))}
                  </div>
                </div>
                {startMcOk ? (
                  <p className="hint" style={{ margin: 0 }}>
                    The first buy pays <b>{showPrice(startPriceNum)}</b> a token: a <b>{Number(startMcNum.toPrecision(4)).toLocaleString('en-US')} SOL</b> market cap
                    {solUsd ? <> (≈{money(startMcNum, solUsd)})</> : null} for all 1,000,000,000 tokens.
                  </p>
                ) : (
                  <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>
                    The starting price must be at least {showPrice(mcToPrice(5))} (a 5 SOL market cap).
                  </p>
                )}
                <div className="tax-head" style={{ marginTop: 16 }}>
                  <label htmlFor="gradprice">Migrates at price (per token)</label>
                  <span className="tax-val">{showPrice(gradPriceNum)}</span>
                </div>
                <div className="tax-inputs wrap">
                  <div className="num" style={{ width: 200 }}>
                    <input id="gradprice" type="number" min="0" step="any" placeholder="0.00006" value={gradPrice} onChange={(e) => setGradPrice(e.target.value)} />
                    <span>{unit === 'usd' ? 'USD' : 'SOL'}</span>
                  </div>
                  <div className="presets" style={{ margin: 0 }}>
                    {MULTIPLE_PRESETS.map((m) => {
                      const v = startPriceNum > 0 ? plainNumber(startPriceNum * m) : '';
                      return (
                        <button key={m} type="button" className={v && gradPrice === v ? 'on' : ''} disabled={!v} onClick={() => setGradPrice(v)}>
                          {m}×
                        </button>
                      );
                    })}
                  </div>
                </div>
                {!startMcOk ? null : !gradOk ? (
                  <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>The migration price must be more than double the starting price.</p>
                ) : curveError ? (
                  <p className="hint" style={{ margin: 0, color: 'var(--bad)' }} id="price-error">
                    {curveError}
                  </p>
                ) : (
                  <p className="hint" style={{ margin: 0 }} id="price-explain">
                    It migrates to a locked Meteora DAMM v2 pool when the price reaches <b>{showPrice(gradPriceNum)}</b> ({Number(gradMcNum.toPrecision(4)).toLocaleString('en-US')} SOL
                    market cap{solUsd ? <>, ≈{money(gradMcNum, solUsd)}</> : null}), <b>{Number((gradMcNum / startMcNum).toPrecision(3))}×</b> the starting price. That takes{' '}
                    {curve ? <b>{curve.graduationSol.toFixed(1)} SOL</b> : 'some SOL'} of buys. Both prices are set on chain at launch, in SOL, so nobody can change them later.
                  </p>
                )}
              </div>
            ) : null}
            {rangeTax ? (
              <div style={{ marginBottom: 16 }}>
                <div className="tax-head">
                  <label htmlFor="rangestart">Opening tax (%)</label>
                  <span className="tax-val">{rangeStartOk ? `${rangeStartNum}%` : '—'}</span>
                </div>
                <div className="tax-inputs">
                  <div className="num">
                    <input id="rangestart" type="number" min="0.5" max="99" step="0.5" placeholder="up to 99" value={rangeStartPct} onChange={(e) => setRangeStartPct(e.target.value)} />
                    <span>%</span>
                  </div>
                  <div className="presets" style={{ margin: 0 }}>
                    {START_TAX_PRESETS.map((p) => (
                      <button key={p} type="button" className={rangeStartPct === p ? 'on' : ''} onClick={() => setRangeStartPct(p)}>
                        {p}%
                      </button>
                    ))}
                  </div>
                </div>
                {!rangeStartOk ? (
                  <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>The opening tax must be higher than the floor tax, and 99% at most.</p>
                ) : (
                  <p className="hint" style={{ margin: 0 }}>What every buy and sell pays at the launch price.</p>
                )}
              </div>
            ) : null}
            {timedTax ? (
              <div style={{ marginBottom: 16 }}>
                <div className="tax-head">
                  <label htmlFor="starttax">Starting tax (%)</label>
                  <span className="tax-val">{timedStartOk ? `${timedStartNum}%` : '—'}</span>
                </div>
                <div className="tax-inputs">
                  <div className="num">
                    <input id="starttax" type="number" min="0.5" max="99" step="0.5" placeholder="up to 99" value={timedStartPct} onChange={(e) => setTimedStartPct(e.target.value)} />
                    <span>%</span>
                  </div>
                  <div className="presets" style={{ margin: 0 }}>
                    {START_TAX_PRESETS.map((p) => (
                      <button key={p} type="button" className={timedStartPct === p ? 'on' : ''} onClick={() => setTimedStartPct(p)}>
                        {p}%
                      </button>
                    ))}
                  </div>
                </div>
                {!timedStartOk ? (
                  <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>The starting tax must be higher than the tax it drops to, and 99% at most.</p>
                ) : null}
              </div>
            ) : null}
            <div className="tax-head">
              <label htmlFor="tax">{migrationTax ? 'Tax before graduation (%)' : timedTax ? 'Drops to (%)' : rangeTax ? 'Floor tax (%)' : 'Tax (%)'}</label>
              <span className="tax-val">{taxOk ? `${taxNum}%` : '—'}</span>
            </div>
            <div className="tax-inputs">
              <input aria-label="Tax slider" type="range" min="0.25" max={migrationTax ? 99 : 20} step="0.25" value={taxOk ? Math.min(taxNum, migrationTax ? 99 : 20) : 1} onChange={(e) => setFeePct(e.target.value)} />
              <div className="num">
                <input id="tax" type="number" min="0.25" max="99" step="0.25" placeholder="0.25–99" value={feePct} onChange={(e) => setFeePct(e.target.value)} />
                <span>%</span>
              </div>
            </div>
            <div className="presets">
              {(migrationTax ? PRE_TAX_PRESETS : TAX_PRESETS).map((p) => (
                <button key={p} type="button" className={feePct === p ? 'on' : ''} onClick={() => setFeePct(p)}>
                  {p}%
                </button>
              ))}
            </div>
            {taxOk ? (
              <p className="hint" style={{ margin: 0 }}>
                {migrationTax ? (
                  <>While the coin is on its bonding curve, every buy and sell pays <b>{taxNum}%</b>, in SOL.</>
                ) : timedTax ? (
                  <>Once the timer runs out, every buy and sell pays <b>{taxNum}%</b> for good, taken in SOL.</>
                ) : rangeTax ? (
                  <>At and above the target market cap, every buy and sell pays <b>{taxNum}%</b>, taken in SOL.</>
                ) : (
                  <>Every buy and every sell pays <b>{taxNum}%</b>, taken in SOL.</>
                )}
              </p>
            ) : (
              <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>
                Tax must be between 0.25% and 99%.
              </p>
            )}
            {timedTax ? (
              <div style={{ marginTop: 16 }} id="card-timer">
                <div className="tax-head">
                  <label htmlFor="timer">Timer (seconds)</label>
                  <span className="tax-val">{timerOk ? formatSeconds(timerNum) : '—'}</span>
                </div>
                <div className="tax-inputs">
                  <div className="num">
                    <input id="timer" type="number" min="10" max="64800" step="1" placeholder="10–64800" value={timerSeconds} onChange={(e) => setTimerSeconds(e.target.value)} />
                    <span>s</span>
                  </div>
                  <div className="presets" style={{ margin: 0 }}>
                    {TIMER_PRESETS.map(([v, label]) => (
                      <button key={v} type="button" className={timerSeconds === v ? 'on' : ''} onClick={() => setTimerSeconds(v)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {!timerOk ? (
                  <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>The timer must run between 10 seconds and 18 hours (64,800 s).</p>
                ) : timedStartOk && taxOk ? (
                  <p className="hint" style={{ margin: 0 }}>
                    The coin opens at <b>{timedStartNum}%</b>. Every second the tax drops <b>{formatPct(dropPerSecond)}%</b>
                    {' '}({timedStartNum}% → {formatPct(timedStartNum - dropPerSecond)}% → {formatPct(timedStartNum - 2 * dropPerSecond)}% …), so it reaches{' '}
                    <b>{taxNum}%</b> after <b>{formatSeconds(timerNum)}</b> and stays there. The clock starts when the coin goes live, and
                    it&rsquo;s set on chain, so nobody can change it later.
                  </p>
                ) : null}
              </div>
            ) : null}
            {rangeTax ? (
              <div style={{ marginTop: 16 }} id="card-target">
                <div className="tax-head">
                  <label htmlFor="targetusd">Target market cap ($)</label>
                  <span className="tax-val">{targetUsdOk ? `$${targetUsdNum.toLocaleString('en-US')}` : '—'}</span>
                </div>
                <div className="tax-inputs">
                  <div className="num" style={{ width: 170 }}>
                    <input id="targetusd" type="number" min="1000" step="1000" placeholder="15000" value={targetUsd} onChange={(e) => setTargetUsd(e.target.value)} />
                    <span>USD</span>
                  </div>
                  <div className="presets" style={{ margin: 0 }}>
                    {TARGET_PRESETS.map(([v, label]) => (
                      <button key={v} type="button" className={targetUsd === v ? 'on' : ''} onClick={() => setTargetUsd(v)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {!targetUsdOk ? (
                  <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>The target must be between $1,000 and $1,000,000,000.</p>
                ) : !targetAboveStart ? (
                  <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>
                    The target has to be at least 10% above the starting market cap ({startMcNum.toLocaleString()} SOL ≈ {money(startMcNum, solUsd)}). Raise the target, or lower the
                    starting market cap under Advanced.
                  </p>
                ) : preview && targetSol ? (
                  <>
                    <RangeChart schedule={preview} startMcSol={startMcNum} solUsd={solUsd} />
                    <p className="hint" style={{ margin: 0 }} id="range-explain">
                      ${targetUsdNum.toLocaleString('en-US')} ≈ <b>{Number(targetSol.toPrecision(4)).toLocaleString('en-US')} SOL</b> at today&rsquo;s ${solUsd!.toFixed(2)}/SOL, locked in
                      when you launch (the pool counts in SOL). At launch ({money(startMcNum, solUsd)}) the tax is <b>{rangeStartNum}%</b>. It falls in tiny steps as the
                      market cap climbs: about {formatPct(rangeTaxBps(preview, startMcNum, startMcNum + (targetSol - startMcNum) / 3) / 100)}% at{' '}
                      {money(startMcNum + (targetSol - startMcNum) / 3, solUsd)}, {formatPct(rangeTaxBps(preview, startMcNum, startMcNum + ((targetSol - startMcNum) * 2) / 3) / 100)}% at{' '}
                      {money(startMcNum + ((targetSol - startMcNum) * 2) / 3, solUsd)}, and from <b>${targetUsdNum.toLocaleString('en-US')}</b> up it&rsquo;s <b>{taxNum}%</b>. If the market cap
                      drops back below ${targetUsdNum.toLocaleString('en-US')}, the tax climbs again the same way. It&rsquo;s Meteora&rsquo;s own fee setting, fixed in the pool at launch:
                      nobody can change it later.
                    </p>
                  </>
                ) : (
                  <p className="hint" style={{ margin: 0 }}>
                    The tax falls from {rangeStartOk ? rangeStartNum : '—'}% at launch to {taxNum}% at ${targetUsdNum.toLocaleString('en-US')}, and climbs back if the market cap drops below it.
                    {solUsd ? '' : ' (The live SOL price is unavailable right now; it’s converted when you launch.)'}
                  </p>
                )}
              </div>
            ) : null}
            {migrationTax ? (
              <div style={{ marginTop: 16 }}>
                <div className="tax-head">
                  <label htmlFor="posttax">Tax after graduation (%)</label>
                  <span className="tax-val">{postFeeOk ? `${postFeeNum}%` : '—'}</span>
                </div>
                <div className="tax-inputs">
                  <div className="num">
                    <input id="posttax" type="number" min="0.1" max="10" step="0.1" placeholder="0.1–10" value={postFeePct} onChange={(e) => setPostFeePct(e.target.value)} />
                    <span>%</span>
                  </div>
                  <div className="presets" style={{ margin: 0 }}>
                    {POST_TAX_PRESETS.map((p) => (
                      <button key={p} type="button" className={postFeePct === p ? 'on' : ''} onClick={() => setPostFeePct(p)}>
                        {p}%
                      </button>
                    ))}
                  </div>
                </div>
                {postFeeOk ? (
                  <p className="hint" style={{ margin: 0 }}>
                    Once it graduates into its Meteora DAMM v2 pool, the tax {postFeeNum < taxNum ? 'drops to' : postFeeNum > taxNum ? 'rises to' : 'stays at'} <b>{postFeeNum}%</b> for good. That&rsquo;s set on
                    chain at launch, so nobody can change it later. Meteora allows 0.1–10% after graduation.
                  </p>
                ) : (
                  <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>Tax after graduation must be between 0.1% and 10%.</p>
                )}
              </div>
            ) : null}
            <div className="split">
              <div>
                {migrationTax ? 'Tax on the curve' : timedTax ? 'Tax after the timer' : rangeTax ? 'Floor tax' : 'Tax per trade'}<b>{taxOk ? taxNum : '—'}%</b>
              </div>
              <div className="you">
                To creator<b>{taxOk ? devShare.toFixed(2) : '—'}%</b>
              </div>
              <div>
                Meteora protocol<b>{taxOk ? ((taxNum * cut) / 100).toFixed(2) : '—'}%</b>
              </div>
            </div>
          </div>

          <div className="tax" id="card-devbuy">
            <div className="tax-head">
              <label htmlFor="devbuy">Dev buy <span className="opt">(Optional)</span></label>
              <span className="tax-val">{devBuyOk && devBuyNum > 0 ? `${devBuyNum} SOL` : 'None'}</span>
            </div>
            <div className="tax-inputs">
              <div className="num" style={{ width: 160 }}>
                <input id="devbuy" type="number" min="0" step="0.1" placeholder="0" value={devBuy} onChange={(e) => setDevBuy(e.target.value)} />
                <span>SOL</span>
              </div>
              <div className="presets" style={{ margin: 0 }}>
                {DEV_BUY_PRESETS.map((p) => (
                  <button key={p} type="button" className={devBuy === p ? 'on' : ''} onClick={() => setDevBuy(p)}>
                    {p === '0' ? 'None' : `${p} SOL`}
                  </button>
                ))}
              </div>
            </div>
            {rangeTax && devBuyOk && devBuyNum > 0 ? (
              <p className="hint" style={{ margin: 0 }}>
                You buy <b>{devBuyNum} SOL</b> first, as the pool&rsquo;s very first trade, in the same transaction that creates it, so nobody can buy before
                you. It pays the <b>{rangeStartOk ? rangeStartNum : '—'}%</b> opening tax; {100 - cut}% of that tax comes back to you as creator fees (≈
                {rangeStartOk ? ` ${formatPct((devBuyNum * rangeStartNum * (100 - cut)) / 10000)} SOL` : ' —'}), Meteora keeps the rest.
              </p>
            ) : settings && !settings.devBuyReady && devBuyNum > 0 ? (
              <p className="hint" style={{ margin: 0 }}>
                You buy <b>{devBuyNum} SOL</b> first, in the same transaction as the launch. This is MetPad&rsquo;s first dev buy, so
                Phantom will ask for one extra approval first (~0.006 SOL, a one-time setup for the whole site).
              </p>
            ) : devBuyOk ? (
              <p className="hint" style={{ margin: 0 }}>
                {devBuyNum > 0 ? (
                  <>
                    You buy <b>{devBuyNum} SOL</b> of your coin in the same transaction that creates it, so nobody can buy
                    before you. It pays the minimum tax, even with anti-sniper or timed tax on.
                  </>
                ) : (
                  'Buy some of your own coin at launch, in the same transaction, before anyone else can.'
                )}
              </p>
            ) : (
              <p className="hint" style={{ margin: 0, color: 'var(--bad)' }}>Dev buy must be between 0.001 and 100 SOL, or 0.</p>
            )}
          </div>

          <div className="field" style={{ marginTop: 18 }}>
            <label>Send tax to:</label>
            <div className="seg">
              <span className="on">♔ Creator</span>
              <span>{wallet.address ? shortAddress(wallet.address, 4) : 'connect a wallet'}</span>
            </div>
            <p className="hint" style={{ margin: 0 }}>
              {rangeTax
                ? 'Your wallet owns the pool’s locked LP position, so every bit of its tax is yours.'
                : 'Your wallet is the coin’s fee claimer: the tax from the curve, and the fees of its locked pool after graduation, are yours.'} Claim them in SOL any time from the <Link href="/fees">Claim tax</Link> page. Meteora&rsquo;s program keeps {cut}% of it; nothing can change that.
            </p>
          </div>

          <button type="button" className="toggle-line" style={{ marginTop: 14 }} aria-expanded={advOpen} onClick={() => setAdvOpen((o) => !o)}>
            Advanced <span className="chev">⌄</span>
          </button>
          {advOpen ? (
            <div style={{ marginTop: 10 }}>
              <label className="check" style={{ marginTop: 0, ...(timedTax || rangeTax ? { display: 'none' } : {}) }}>
                <input type="checkbox" checked={decayOn} onChange={(e) => setDecayOn(e.target.checked)} />
                <span>Anti-sniper: open at a higher tax and decay down to {feePct}%.</span>
              </label>
              {decayOn && !timedTax && !rangeTax ? (
                <div className="row" style={{ marginTop: 12 }}>
                  <div className="field">
                    <label htmlFor="openfee">Opening tax %</label>
                    <input id="openfee" type="number" min={Number(feePct)} max="99" step="1" value={openFeePct} onChange={(e) => setOpenFeePct(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="decaymin">Decays over (minutes)</label>
                    <input id="decaymin" type="number" min="1" max="1440" step="1" value={decayMinutes} onChange={(e) => setDecayMinutes(e.target.value)} />
                  </div>
                </div>
              ) : null}
              <div className="row" style={{ marginTop: 12, ...(customPrice ? { display: 'none' } : {}) }}>
                <div className="field">
                  <label htmlFor="smc">Starting market cap (SOL)</label>
                  <input id="smc" type="number" min="5" step="1" value={startMc} onChange={(e) => setStartMc(e.target.value)} />
                </div>
                <div className="field" style={rangeTax ? { display: 'none' } : undefined}>
                  <label htmlFor="gmc">Graduates at market cap (SOL)</label>
                  <input id="gmc" type="number" min="20" step="10" value={gradMc} onChange={(e) => setGradMc(e.target.value)} />
                </div>
              </div>
              <div className="field" style={migrationTax || rangeTax ? { display: 'none' } : undefined}>
                <label htmlFor="gfee">Fee on the graduated DAMM v2 pool</label>
                <select id="gfee" value={gradFeeBps} onChange={(e) => setGradFeeBps(e.target.value)}>
                  <option value="25">0.25%</option>
                  <option value="30">0.3%</option>
                  <option value="100">1%</option>
                  <option value="200">2%</option>
                  <option value="400">4%</option>
                  <option value="600">6%</option>
                </select>
              </div>
              <div className="readout" id="card-curve">
                {rangeTax ? (
                  startMcOk ? (
                    <>
                      Opens at <b>{startMcNum.toLocaleString()} SOL</b> market cap{solUsd ? <> (≈{money(startMcNum, solUsd)})</> : null}: the price where the tax is at its
                      opening rate. No graduation: it trades in its DAMM v2 pool for good.
                    </>
                  ) : (
                    <span style={{ color: 'var(--bad)' }}>Starting market cap must be at least 5 SOL.</span>
                  )
                ) : !startMcOk ? (
                  <span style={{ color: 'var(--bad)' }}>Starting market cap must be at least 5 SOL.</span>
                ) : !gradOk ? (
                  <span style={{ color: 'var(--bad)' }}>Graduation market cap must be more than double the starting one.</span>
                ) : curveError ? (
                  <span style={{ color: 'var(--bad)' }}>{curveError}</span>
                ) : curve ? (
                  <>
                    Opens at <b>{curve.startMarketCapSol.toFixed(1)} SOL</b> market cap and graduates once{' '}
                    <b>{curve.graduationSol.toFixed(1)} SOL</b> has been bought in. The graduated pool charges {migrationTax ? postFeeNum : Number(gradFeeBps) / 100}% per trade,
                    and its fees go to you too.
                  </>
                ) : (
                  <>Working out the curve…</>
                )}
              </div>
            </div>
          ) : null}
        </div>

        <div className="box">
          <label
            className={`upload${dragOver ? ' over' : ''}`}
            htmlFor="pfp"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              readImage(e.dataTransfer.files?.[0], (f) => pickImage(f, 'pfp'));
            }}
          >
            {pfpPreview ? (
              <img className="picked" src={pfpPreview} alt="" />
            ) : (
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#9a9fac" strokeWidth="1.6" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="15.5" cy="8.5" r="1.8" />
                <path d="M3 17l5-5 4 4 3-3 6 6" />
              </svg>
            )}
            <span className="big">{pfpPreview ? pfp?.name : 'Select image to upload'}</span>
            <span className="small">{pfpPreview ? 'Click or drop to replace' : 'or drag and drop it here'}</span>
            {!pfpPreview ? <span className="pill">Choose file</span> : null}
            <input id="pfp" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => pickImage(e.target.files?.[0] ?? null, 'pfp')} />
          </label>
          <div className="specs">
            <div>
              <h4>File size and type</h4>
              <ul>
                <li>Image - max 15mb (resized for you). &apos;.png&apos;, &apos;.jpg&apos;, &apos;.webp&apos; or &apos;.gif&apos; (GIF up to 1.9mb)</li>
              </ul>
            </div>
            <div>
              <h4>Resolution and aspect ratio</h4>
              <ul>
                <li>Image - min. 1000x1000px, 1:1 square recommended</li>
              </ul>
            </div>
          </div>
          <div style={{ padding: '6px 10px 0' }}>
            <label className="toggle-line" htmlFor="banner" style={{ cursor: 'pointer' }}>
              🖼 Add banner <span className="opt">(Optional)</span>
            </label>
            <div className="banner-drop">
              {bannerPreview ? (
                <label className="drop" htmlFor="banner">
                  <img src={bannerPreview} alt="" />
                  <span className="ph">Click to replace</span>
                </label>
              ) : null}
              <input id="banner" type="file" style={{ display: 'none' }} accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => pickImage(e.target.files?.[0] ?? null, 'banner')} />
            </div>
          </div>
        </div>

        <div className="fineprint">
          ⓘ Coin data (social links, banner, tax, etc) can only be added now, and can&rsquo;t be changed or edited after creation
        </div>

      {busy || stepIndex >= 0 ? (
        <div className="card">
          <h2>Progress</h2>
          <ul className="steps">
            {STEPS.map((label, i) => (
              <li key={label} className={i < stepIndex ? 'done' : i === stepIndex ? 'active' : ''}>
                <span className="m">{i < stepIndex ? '✓' : i === stepIndex ? '▸' : '·'}</span>
                <span>
                  {label}
                  {i === stepIndex && stepNote ? ` — ${stepNote}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <button type="button" className="btn-primary btn-create" id="create-btn" disabled={!ready || !taxOk || !startMcOk || !gradOk || !devBuyOk || !postFeeOk || !rangeOk || (!rangeTax && Boolean(curveError))} onClick={launch}>
        {busy ? (
          <>
            <span className="spin" /> Creating…
          </>
        ) : wallet.address ? (
          `Create coin · ${launchFee} SOL${devBuyOk && devBuyNum > 0 ? ` + ${devBuyNum} SOL dev buy` : ''}`
        ) : (
          'Connect a wallet to create'
        )}
      </button>
      </div>

      <aside className="create-side">
        <h3 style={{ marginBottom: 12 }}>Preview</h3>
        <div className="pv" id="preview">
          {hasPreview ? (
            <>
              <div className="pv-banner" style={bannerPreview ? { backgroundImage: `url(${bannerPreview})` } : undefined} />
              <div className="pv-body">
                <div className="pv-head">
                  {pfpPreview ? <img className="pv-img" src={pfpPreview} alt="" /> : <div className="pv-img" />}
                  <div style={{ minWidth: 0 }}>
                    <div className="pv-name">{name || 'Coin name'}</div>
                    <div className="pv-tick">${symbol || 'TICKER'} · SOL pair</div>
                  </div>
                </div>
                {bio ? <p className="pv-desc">{bio}</p> : null}
                <div className="pv-stats">
                  <div>
                    Tax
                    <b>
                      {!taxOk
                        ? '—'
                        : migrationTax
                          ? `${taxNum}% → ${postFeeOk ? postFeeNum : '—'}%`
                          : timedTax
                            ? `${timedStartOk ? timedStartNum : '—'}% → ${taxNum}% in ${timerOk ? formatSeconds(timerNum) : '—'}`
                            : rangeTax
                              ? `${rangeStartOk ? rangeStartNum : '—'}% → ${taxNum}% at ${targetUsdOk ? `$${Number((targetUsdNum / 1000).toPrecision(3))}k` : '—'}`
                              : `${taxNum}%`}
                    </b>
                  </div>
                  <div>
                    {customPrice ? (
                      <>
                        Starts at<b>{startMcOk ? showPrice(startPriceNum) : '—'}</b>
                      </>
                    ) : (
                      <>
                        Market cap<b>{startMcOk ? `${startMcNum.toLocaleString()} SOL` : '—'}</b>
                      </>
                    )}
                  </div>
                  <div>
                    {rangeTax ? (
                      <>
                        Pool<b>DAMM v2, no curve</b>
                      </>
                    ) : customPrice ? (
                      <>
                        Migrates at<b>{gradOk ? showPrice(gradPriceNum) : '—'}</b>
                      </>
                    ) : (
                      <>
                        Graduates at<b>{gradOk ? `${gradMcNum.toLocaleString()} SOL` : '—'}</b>
                      </>
                    )}
                  </div>
                  <div>
                    Dev buy<b>{devBuyOk && devBuyNum > 0 ? `${devBuyNum} SOL` : 'None'}</b>
                  </div>
                </div>
                {xLink || website ? (
                  <div className="pv-links">
                    {xLink ? <span className="tag">X</span> : null}
                    {website ? <span className="tag">web</span> : null}
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="pv-empty">A preview of how the coin will look like</div>
          )}
        </div>
      </aside>
    </div>
  );
}
