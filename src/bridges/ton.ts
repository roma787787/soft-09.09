import { TON_CHAIN, toTonAddress } from "../config/tonChain";
import { endpointsWithOverride } from "../config/env";
import { findRegistryDeploymentsOnChain } from "./layerzero";
import type { NonEvmReadResult } from "./types";

/**
 * What LayerZero's adapters hold on TON.
 *
 * TON keeps a jetton balance in a wallet contract owned by the holder, not
 * in the holder itself, so there is no balance to read at the adapter's own
 * address. The index knows which wallets an address owns and what is in
 * them, which turns the whole question into one request - the alternative
 * being to encode a get-method call into a cell and then derive the wallet
 * address from the jetton master, a lot of machinery for a number that is
 * already published.
 */

const TIMEOUT_MS = 12_000;

/** Jetton wallets read per adapter. An adapter normally owns one. */
const MAX_WALLETS = 20;

export interface TonBalanceRow {
  protocol: "layerzero";
  chainKey: string;
  custodyAddress: string;
  tokenAddress: string;
  note?: string;
  amount: bigint;
  decimals: number;
}

async function getJson(url: string): Promise<any | undefined> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

interface JettonHolding {
  jetton: string;
  balance: bigint;
  wallet: string;
}

/** Parsed apart from the fetch, so the response shape is covered by a test. */
export function parseJettonWallets(body: unknown): JettonHolding[] {
  const wallets = (body as { jetton_wallets?: unknown })?.jetton_wallets;
  if (!Array.isArray(wallets)) return [];
  const held: JettonHolding[] = [];
  for (const w of wallets as Array<Record<string, unknown>>) {
    const jetton = typeof w.jetton === "string" ? w.jetton : undefined;
    const balance = typeof w.balance === "string" ? w.balance : undefined;
    const wallet = typeof w.address === "string" ? w.address : "";
    if (!jetton || !balance) continue;
    try {
      held.push({ jetton, balance: BigInt(balance), wallet });
    } catch {
      // A balance the index could not express as digits is not a balance.
    }
  }
  return held;
}

/** The same for a jetton's own metadata, which is where decimals live. */
export function parseJettonMaster(body: unknown): { decimals: number; symbol?: string } | undefined {
  const masters = (body as { jetton_masters?: unknown })?.jetton_masters;
  const first = Array.isArray(masters) ? (masters[0] as Record<string, any>) : undefined;
  // No entry means the index does not know this jetton, which is not the
  // same as a jetton that declares no decimals. Defaulting here would put a
  // number on a token nobody confirmed exists.
  if (!first) return undefined;
  const content = first.jetton_content;
  const raw = content?.decimals;
  // TON's metadata standard stores decimals as a string, and some jettons
  // omit it entirely - the standard's default is nine.
  const decimals = raw === undefined || raw === null ? 9 : Number(raw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return undefined;
  return { decimals, symbol: typeof content?.symbol === "string" ? content.symbol : undefined };
}

function bases(): string[] {
  return endpointsWithOverride(TON_CHAIN.rpcEnvVar, [...TON_CHAIN.apiUrls]).map((u) =>
    u.replace(/\/+$/, "")
  );
}

/**
 * Reads every LayerZero adapter on TON that carries this ticker.
 *
 * An adapter that turns out to hold nothing is still reported, as a zero
 * row: an empty vault is the most useful answer a liquidity report can give
 * about a route, and the one most often mistaken for an unchecked one.
 */
export async function findTonBalances(symbol: string): Promise<NonEvmReadResult<TonBalanceRow>> {
  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};

  const deployments = (await findRegistryDeploymentsOnChain(symbol, TON_CHAIN.key)).filter(
    (d) => d.locksCollateral
  );
  if (deployments.length === 0) return { rows: [], attempts, failures };

  attempts[TON_CHAIN.key] = deployments.length;
  const wanted = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const rows: TonBalanceRow[] = [];
  for (const deployment of deployments) {
    const owner = toTonAddress(deployment.address);
    if (!owner) {
      failures[TON_CHAIN.key] = (failures[TON_CHAIN.key] ?? 0) + 1;
      continue;
    }

    let holdings: JettonHolding[] = [];
    for (const base of bases()) {
      const body = await getJson(
        `${base}/jetton/wallets?owner_address=${encodeURIComponent(owner)}&limit=${MAX_WALLETS}`
      );
      holdings = parseJettonWallets(body);
      if (holdings.length > 0) break;
    }

    if (holdings.length === 0) {
      // Unread, not empty: an adapter with no wallets listed is far more
      // likely an index that would not answer than a vault that holds
      // nothing, and the two must not be reported the same way.
      failures[TON_CHAIN.key] = (failures[TON_CHAIN.key] ?? 0) + 1;
      continue;
    }

    // Which jetton is the one asked about. An adapter normally owns exactly
    // one wallet, and then there is nothing to choose; where it owns several,
    // the jetton's own symbol decides, because picking the largest balance
    // would answer a different question than the one asked.
    const described = await Promise.all(
      holdings.map(async (h) => {
        for (const base of bases()) {
          const meta = parseJettonMaster(await getJson(`${base}/jetton/masters?address=${encodeURIComponent(h.jetton)}&limit=1`));
          if (meta) return { ...h, ...meta };
        }
        return undefined;
      })
    );
    const known = described.filter((d): d is JettonHolding & { decimals: number; symbol?: string } => !!d);

    const matching =
      known.length === 1
        ? known
        : known.filter((k) => (k.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").startsWith(wanted));

    if (matching.length === 0) {
      failures[TON_CHAIN.key] = (failures[TON_CHAIN.key] ?? 0) + 1;
      continue;
    }

    for (const held of matching) {
      rows.push({
        protocol: "layerzero" as const,
        chainKey: TON_CHAIN.key,
        custodyAddress: owner,
        tokenAddress: held.jetton,
        note: deployment.viaAlias ?? deployment.rawType,
        amount: held.balance,
        decimals: held.decimals,
      });
    }
  }

  return { rows, attempts, failures };
}
