'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export type Settings = {
  network: string;
  rpcConfigured: boolean;
  devBuyReady: boolean;
  venue: string;
  launchFeeSol: number;
  treasury: string;
  networkCostSol: number;
  costPerLaunchSol: number;
  protocolFeeCutPercent: number;
  totalSupply: number;
  limits: { minFeeBps: number; maxFeeBps: number; maxName: number; maxSymbol: number; minTargetUsd?: number; maxTargetUsd?: number };
  /** Live SOL/USD for the range-tax form's readouts; null when every price feed is down. */
  solUsd?: number | null;
  minRangeMultiple?: number;
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Settings>('/api/settings')
      .then(setSettings)
      .catch((err: Error) => setError(err.message));
  }, []);
  return { settings, error };
}

export const explorer = {
  token: (mint: string, network: string) =>
    `https://solscan.io/token/${mint}${network === 'devnet' ? '?cluster=devnet' : ''}`,
  tx: (sig: string, network: string) =>
    `https://solscan.io/tx/${sig}${network === 'devnet' ? '?cluster=devnet' : ''}`,
  account: (addr: string, network: string) =>
    `https://solscan.io/account/${addr}${network === 'devnet' ? '?cluster=devnet' : ''}`,
  trade: (mint: string) => `https://jup.ag/tokens/${mint}`,
};
