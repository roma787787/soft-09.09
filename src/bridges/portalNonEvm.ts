import { PORTAL_CHAINS, getPortalChain, portalCustodyAddress } from "../config/portalChains";
import { endpointsWithOverride } from "../config/env";
import type { NonEvmReadResult } from "./types";

/**
 * What Wormhole's Token Bridge holds on Near and Aptos.
 *
 * Neither chain answers eth_call, and neither keeps a balance where an EVM
 * chain would. Near asks the token contract a view function and hands back
 * the digits as a string; Aptos serves a view call over REST and has two
 * token standards, only one of which resembles an ERC-20.
 *
 * Every reading is verified before it is reported: an amount with no
 * decimals behind it is not a number anyone can act on, so a chain that
 * cannot say how many decimals a token has is reported as unread rather
 * than shown with a guess.
 */

const TIMEOUT_MS = 12_000;

export interface PortalBalanceRow {
  protocol: "wormhole";
  chainKey: string;
  custodyAddress: string;
  tokenAddress: string;
  note?: string;
  amount: bigint;
  decimals: number;
}

async function postJson(url: string, body: unknown): Promise<unknown | undefined> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/* ------------------------------- Near ------------------------------- */

/**
 * Near returns a view function's result as a byte array, not as a value: the
 * digits of the balance arrive as the character codes of a JSON string.
 */
function decodeNearResult(result: unknown): string | undefined {
  if (!Array.isArray(result)) return undefined;
  try {
    return JSON.parse(String.fromCharCode(...(result as number[])));
  } catch {
    return undefined;
  }
}

async function nearView(
  urls: string[],
  contract: string,
  method: string,
  args: Record<string, unknown>
): Promise<unknown | undefined> {
  const argsBase64 = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  for (const url of urls) {
    const body = await postJson(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: argsBase64,
      },
    });
    const decoded = decodeNearResult((body as { result?: { result?: unknown } })?.result?.result);
    if (decoded !== undefined) return decoded;
  }
  return undefined;
}

async function readNear(
  chainKey: string,
  token: string,
  custody: string
): Promise<{ amount: bigint; decimals: number } | undefined> {
  const chain = getPortalChain(chainKey);
  if (!chain) return undefined;
  const urls = endpointsWithOverride(chain.rpcEnvVar, chain.rpcUrls);

  const [balance, metadata] = await Promise.all([
    nearView(urls, token, "ft_balance_of", { account_id: custody }),
    nearView(urls, token, "ft_metadata", {}),
  ]);

  const decimals = (metadata as { decimals?: unknown })?.decimals;
  if (typeof balance !== "string" || typeof decimals !== "number") return undefined;
  try {
    return { amount: BigInt(balance), decimals };
  } catch {
    return undefined;
  }
}

/* ------------------------------- Aptos ------------------------------ */

async function aptosView(urls: string[], payload: unknown): Promise<unknown[] | undefined> {
  for (const url of urls) {
    const body = await postJson(`${url.replace(/\/+$/, "")}/view`, payload);
    if (Array.isArray(body)) return body;
  }
  return undefined;
}

/**
 * The two shapes an Aptos balance can be asked for.
 *
 * A coin type is written `0xaddr::module::Name`; a fungible asset is a bare
 * object address with no `::` in it. Both shapes are built, and the one the
 * address looks like is tried first - but if it fails the other is tried
 * too, because the guess is the only thing standing between a real balance
 * and a row reported as unreadable. Aptos also pairs many coins with a
 * fungible asset, so the two are not always alternatives.
 *
 * A wrong shape costs one request and returns nothing; it cannot return a
 * wrong number, which is the only outcome that would matter.
 */
export function aptosCalls(token: string, custody: string): Array<{ balance: unknown; decimals: unknown }> {
  const asCoin = {
    balance: { function: "0x1::coin::balance", type_arguments: [token], arguments: [custody] },
    decimals: { function: "0x1::coin::decimals", type_arguments: [token], arguments: [] },
  };
  const asFungible = {
    balance: {
      function: "0x1::primary_fungible_store::balance",
      type_arguments: ["0x1::object::ObjectCore"],
      arguments: [custody, token],
    },
    decimals: {
      function: "0x1::fungible_asset::decimals",
      type_arguments: ["0x1::object::ObjectCore"],
      arguments: [token],
    },
  };
  return token.includes("::") ? [asCoin, asFungible] : [asFungible, asCoin];
}

async function getJson(url: string): Promise<unknown | undefined> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

export interface AptosResource {
  type: string;
  /** Top-level field names, and any address-shaped value among them. */
  fields: string[];
  addresses: string[];
}

/**
 * What is actually stored at an address on Aptos.
 *
 * Both balance calls against LayerZero's adapters answered, and answered
 * zero: the adapter's own store holds nothing, so the collateral is in a
 * store it owns rather than in itself. A secondary fungible store cannot be
 * derived from the owner and the asset the way a primary one can, and the
 * registry publishes no escrow for Aptos the way it does for Solana - so the
 * object is asked what it is made of, and the answer names the account to
 * read.
 */
export async function aptosResources(chainKey: string, address: string): Promise<AptosResource[]> {
  const chain = getPortalChain(chainKey);
  if (!chain) return [];

  for (const url of endpointsWithOverride(chain.rpcEnvVar, chain.rpcUrls)) {
    const body = await getJson(`${url.replace(/\/+$/, "")}/accounts/${address}/resources`);
    if (!Array.isArray(body)) continue;

    return body.slice(0, 12).map((raw) => {
      const data = (raw as { data?: unknown })?.data;
      const fields = data && typeof data === "object" ? Object.keys(data as object) : [];
      return {
        type: String((raw as { type?: unknown })?.type ?? "?"),
        fields,
        addresses: addressesIn(data),
      };
    });
  }
  return [];
}

/**
 * Address-shaped values anywhere in a resource, at any depth. An object
 * reference is written `{ inner: "0x…" }`, so the address that matters is
 * never a top-level field - which is exactly the one worth surfacing.
 */
function addressesIn(value: unknown, depth = 0): string[] {
  if (depth > 3 || !value || typeof value !== "object") return [];
  const found: string[] = [];
  for (const inner of Object.values(value as Record<string, unknown>)) {
    if (typeof inner === "string" && /^0x[0-9a-fA-F]{60,64}$/.test(inner)) found.push(inner);
    else found.push(...addressesIn(inner, depth + 1));
  }
  return [...new Set(found)];
}

export interface AptosReadStep {
  /** Which of the two token standards was asked. */
  how: string;
  balance: string;
  decimals: string;
}

/**
 * Every call the balance read would make, with what the chain answered.
 *
 * A zero is the one answer that cannot be acted on: "this adapter holds
 * nothing" and "the balance is somewhere this call does not look" are the
 * same number. Solana's escrow was found by looking at the raw shape rather
 * than reasoning about it, and two Aptos adapters answering zero is the same
 * question in the same place.
 */
export async function describeAptosReads(
  chainKey: string,
  token: string,
  custody: string
): Promise<AptosReadStep[]> {
  const chain = getPortalChain(chainKey);
  if (!chain) return [];
  const urls = endpointsWithOverride(chain.rpcEnvVar, chain.rpcUrls);

  const steps: AptosReadStep[] = [];
  for (const call of aptosCalls(token, custody)) {
    const fn = String((call.balance as { function?: unknown })?.function ?? "?");
    const [balance, decimals] = await Promise.all([
      aptosView(urls, call.balance),
      aptosView(urls, call.decimals),
    ]);
    steps.push({
      how: fn,
      balance: balance === undefined ? "отказ" : JSON.stringify(balance).slice(0, 60),
      decimals: decimals === undefined ? "отказ" : JSON.stringify(decimals).slice(0, 30),
    });
  }
  return steps;
}

export async function readAptos(
  chainKey: string,
  token: string,
  custody: string
): Promise<{ amount: bigint; decimals: number } | undefined> {
  const chain = getPortalChain(chainKey);
  if (!chain) return undefined;
  const urls = endpointsWithOverride(chain.rpcEnvVar, chain.rpcUrls);

  for (const call of aptosCalls(token, custody)) {
    const [balance, decimals] = await Promise.all([
      aptosView(urls, call.balance),
      aptosView(urls, call.decimals),
    ]);
    const rawAmount = balance?.[0];
    const rawDecimals = decimals?.[0];
    if (rawAmount === undefined || rawDecimals === undefined) continue;
    try {
      return { amount: BigInt(String(rawAmount)), decimals: Number(rawDecimals) };
    } catch {
      // A number the chain answered with but nobody can parse is not a
      // balance; the other shape may still give one.
      continue;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------- */

/**
 * Reads the Token Bridge's holdings on every chain here that the token
 * exists on.
 *
 * The token address comes from the price API rather than from a bridge
 * registry, because on these chains the Token Bridge is one contract holding
 * everything it ever carried - the same shape as Across on EVM - so the
 * question is which token to ask it about, not which contract to ask.
 */
export async function findPortalNonEvmBalances(
  tokens: Array<{ chainKey: string; tokenAddress: string }>
): Promise<NonEvmReadResult<PortalBalanceRow>> {
  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};

  const wanted = tokens.filter((t) => getPortalChain(t.chainKey));
  for (const t of wanted) attempts[t.chainKey] = (attempts[t.chainKey] ?? 0) + 1;
  if (wanted.length === 0) return { rows: [], attempts, failures };

  const rows = await Promise.all(
    wanted.map(async ({ chainKey, tokenAddress }): Promise<PortalBalanceRow | undefined> => {
      const custody = portalCustodyAddress(chainKey);
      if (!custody) return undefined;

      const chain = getPortalChain(chainKey)!;
      const read =
        chain.protocol === "near"
          ? await readNear(chainKey, tokenAddress, custody)
          : await readAptos(chainKey, tokenAddress, custody);

      // Unread, not empty. A chain that would not answer holds an unknown
      // amount, and reporting it as zero would say "nothing here" about a
      // bridge nobody managed to ask.
      if (!read) {
        failures[chainKey] = (failures[chainKey] ?? 0) + 1;
        return undefined;
      }

      return {
        protocol: "wormhole" as const,
        chainKey,
        custodyAddress: custody,
        tokenAddress,
        amount: read.amount,
        decimals: read.decimals,
      };
    })
  );

  return { rows: rows.filter((r): r is PortalBalanceRow => r !== undefined), attempts, failures };
}

export function portalNonEvmChainCount(): number {
  return PORTAL_CHAINS.length;
}
