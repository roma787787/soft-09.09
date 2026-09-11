import { getCosmosChain } from "../config/cosmosChains";
import { PORTAL_COSMOS_CHAINS, portalCosmosChain } from "../config/portalCosmosChains";
import { endpointsWithOverride } from "../config/env";
import { readBankBalance } from "./cosmos";
import type { BalanceRow } from "../services/balances";
import type { NonEvmReadResult } from "./types";

/**
 * Wormhole's Token Bridge on the CosmWasm chains.
 *
 * The bot read Wormhole everywhere it exists except here, and the gap was
 * structural rather than a decision: the Cosmos chain table was generated
 * from Hyperlane's registry alone, so a chain only Wormhole is on had no
 * endpoint to query and the bridge there could not be read at all.
 *
 * What the bridge holds on a Cosmos chain is whatever that chain's own
 * assets it has carried away - a wrapped foreign asset is minted here and
 * held nowhere, exactly as on every other chain. So the question is the
 * same as on Near and Aptos: which asset to ask it about, answered by the
 * price API's listing for that chain.
 *
 * Cosmos answers the balance two different ways depending on what the asset
 * is, and the address says which. A CW20 is a contract with its own ledger
 * and has to be asked; everything else - a factory denom, an IBC voucher,
 * the chain's own coin - is an ordinary bank balance.
 */
export interface PortalCosmosRow extends BalanceRow {
  protocol: "wormhole";
}

/** Bech32, which on these chains means a contract rather than a denom. */
function isBech32(value: string): boolean {
  return /^[a-z]+1[02-9ac-hj-np-z]{6,}$/.test(value);
}

async function getJson(chainKey: string, path: string): Promise<any | undefined> {
  const chain = getCosmosChain(chainKey);
  if (!chain) return undefined;

  for (const base of endpointsWithOverride(chain.rpcEnvVar, chain.restUrls)) {
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      return await response.json();
    } catch {
      // Next host. A chain dropped here would read as "the bridge holds
      // nothing", which is the opposite of what an unreachable node means.
    }
  }
  return undefined;
}

/** A CosmWasm smart query: the message goes in the path, base64-encoded. */
function smartPath(contract: string, query: unknown): string {
  const encoded = Buffer.from(JSON.stringify(query), "utf8").toString("base64");
  return `/cosmwasm/wasm/v1/contract/${encodeURIComponent(contract)}/smart/${encodeURIComponent(encoded)}`;
}

export interface Cw20Read {
  amount: bigint;
  decimals: number;
}

/**
 * Pure half of the CW20 read, so the response shape is covered by a test.
 *
 * Both halves have to be there. An amount without decimals cannot be
 * printed - a balance shown at the wrong scale is off by orders of
 * magnitude and reads as a real number, which is worse than no row at all.
 */
export function parseCw20(balanceBody: unknown, infoBody: unknown): Cw20Read | undefined {
  const amount = (balanceBody as any)?.data?.balance;
  const decimals = (infoBody as any)?.data?.decimals;
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return undefined;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return undefined;
  return { amount: BigInt(amount), decimals };
}

/**
 * How many of a bank denom's smallest units make one whole one.
 *
 * Cosmos publishes this per denom rather than per contract, and the entry
 * is the exponent of the unit the chain displays. Falling back to the
 * chain's own coin is correct only when the denom IS the chain's own coin;
 * anything else with no metadata is left unread rather than guessed, for
 * the reason above.
 */
export function parseDenomDecimals(body: unknown): number | undefined {
  const metadata = (body as any)?.metadata;
  const units = Array.isArray(metadata?.denom_units) ? metadata.denom_units : [];
  const display = units.find((u: any) => u?.denom === metadata?.display);
  if (Number.isInteger(display?.exponent)) return display.exponent;

  // Some chains publish the units without naming a display unit. The largest
  // exponent is the whole-coin unit by construction: the base unit is zero.
  const exponents = units
    .map((u: any) => u?.exponent)
    .filter((e: unknown): e is number => Number.isInteger(e));
  if (exponents.length > 0) return Math.max(...exponents);

  return undefined;
}

async function decimalsForDenom(chainKey: string, denom: string): Promise<number | undefined> {
  const chain = getCosmosChain(chainKey);
  if (chain?.nativeDenom === denom && Number.isInteger(chain.nativeDecimals)) return chain.nativeDecimals;

  const body = await getJson(chainKey, `/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`);
  return parseDenomDecimals(body);
}

/**
 * What the Token Bridge holds on each Cosmos chain the price API listed the
 * token on.
 */
export async function findPortalCosmosBalances(
  tokens: Array<{ chainKey: string; tokenAddress: string }>
): Promise<NonEvmReadResult<PortalCosmosRow>> {
  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const reasons: Record<string, string> = {};

  const wanted = tokens.filter((t) => !!portalCosmosChain(t.chainKey));
  if (wanted.length === 0) return { rows: [], attempts, failures };

  const rows = await Promise.all(
    wanted.map(async (token): Promise<PortalCosmosRow | undefined> => {
      const chain = portalCosmosChain(token.chainKey)!;
      attempts[token.chainKey] = (attempts[token.chainKey] ?? 0) + 1;

      const fail = (reason: string) => {
        failures[token.chainKey] = (failures[token.chainKey] ?? 0) + 1;
        reasons[token.chainKey] = reason;
        return undefined;
      };

      if (isBech32(token.tokenAddress)) {
        const [balance, info] = await Promise.all([
          getJson(token.chainKey, smartPath(token.tokenAddress, { balance: { address: chain.tokenBridge } })),
          getJson(token.chainKey, smartPath(token.tokenAddress, { token_info: {} })),
        ]);
        const read = parseCw20(balance, info);
        if (!read) return fail("CW20 не ответил балансом и десятичными");

        return {
          protocol: "wormhole",
          chainKey: token.chainKey,
          custodyAddress: chain.tokenBridge,
          tokenAddress: token.tokenAddress,
          note: "Token Bridge",
          amount: read.amount,
          decimals: read.decimals,
        };
      }

      const [amount, decimals] = await Promise.all([
        readBankBalance(token.chainKey, chain.tokenBridge, token.tokenAddress),
        decimalsForDenom(token.chainKey, token.tokenAddress),
      ]);
      if (amount === undefined) return fail("узел не ответил на запрос баланса");
      if (decimals === undefined) return fail("сеть не публикует десятичные для этого деноминала");

      return {
        protocol: "wormhole",
        chainKey: token.chainKey,
        custodyAddress: chain.tokenBridge,
        tokenAddress: token.tokenAddress,
        note: "Token Bridge",
        amount,
        decimals,
      };
    })
  );

  return {
    rows: rows.filter((r): r is PortalCosmosRow => r !== undefined),
    attempts,
    failures,
    reasons: Object.keys(reasons).length > 0 ? reasons : undefined,
  };
}

/** Chains covered here, for the /sources report. */
export function portalCosmosChainCount(): number {
  return PORTAL_COSMOS_CHAINS.length;
}
