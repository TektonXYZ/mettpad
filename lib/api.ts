'use client';

import { Connection, Transaction, VersionedTransaction } from '@solana/web3.js';

/** Every chain read and write goes through the site's own proxy. */
export function rpc(): Connection {
  return new Connection(`${window.location.origin}/rpc`, { commitment: 'confirmed' });
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned a non-JSON response (${res.status}).`);
  }
  if (!res.ok) {
    const message = (parsed as { error?: string } | null)?.error;
    throw new Error(message || `${path} failed with ${res.status}.`);
  }
  return parsed as T;
}

export function decodeTransaction(base64: string): Transaction {
  return Transaction.from(Buffer.from(base64, 'base64'));
}

export function decodeVersioned(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
}

/** Base64 of a transaction that may still be missing signatures (the server adds the rest). */
export function encodePartial(tx: Transaction | VersionedTransaction): string {
  const bytes = tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return Buffer.from(bytes).toString('base64');
}

/**
 * Sends a signed transaction and polls for confirmation. web3.js would open a
 * websocket to confirm, which the proxy does not serve, so this polls instead.
 */
export async function sendAndConfirm(
  signed: Transaction | VersionedTransaction,
  lastValidBlockHeight: number,
  onStep?: (message: string) => void,
): Promise<string> {
  const conn = rpc();
  const raw = signed.serialize();
  onStep?.('Sending to the network…');
  const signature = await conn.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 5,
  });

  onStep?.('Waiting for confirmation…');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const statuses = await conn.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status?.err) throw new Error(`The transaction failed on chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;

    if (!status) {
      const height = await conn.getBlockHeight('confirmed');
      if (height > lastValidBlockHeight) {
        throw new Error('The transaction expired before it landed. Nothing was spent — try launching again.');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`Still unconfirmed after 90 seconds. Signature ${signature} — check Solscan before retrying.`);
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
