import { Connection } from '@solana/web3.js';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';

/**
 * Meteora DAMM v2. MetPad's first launches (e.g. $NUBI) were direct DAMM v2 pools, and every
 * bonding-curve coin graduates into one, so the claim and pool readers still need it.
 */
export function cpAmm(conn: Connection) {
  return new CpAmm(conn);
}
