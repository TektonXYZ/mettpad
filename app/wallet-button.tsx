'use client';

import { shortAddress, useWallet } from '../lib/wallet';

export default function WalletButton({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  if (wallet.address) {
    return (
      <div className="wallet-pill">
        <i className="dot" />
        <code>{shortAddress(wallet.address)}</code>
        <button type="button" className="btn-ghost btn-sm" onClick={wallet.disconnect}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <button type="button" className="btn-ghost btn-sm" onClick={wallet.connect} disabled={wallet.connecting}>
      {wallet.connecting ? <><span className="spin" /> Connecting…</> : wallet.available ? `Connect ${wallet.walletName}` : 'Connect wallet'}
    </button>
  );
}
