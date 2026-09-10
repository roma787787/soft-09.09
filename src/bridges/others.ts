import { keccak256, stringToBytes } from "viem";
import { getOtherChain, OTHER_CHAINS } from "../config/otherChains";
import { loadHyperlaneRegistry } from "./hyperlane";

/**
 * Starknet, Radix and Aleo: three chains, three unrelated ways to ask what a
 * contract holds, and eleven warp routes between them.
 *
 * Each reader speaks the chain's own protocol directly over HTTP. Nothing
 * here is derived - every address comes from the registry - so the only way
 * to be wrong is to be told nothing, and being told nothing produces no row.
 */
export interface OtherRoute {
  routeId: string;
  chainKey: string;
  protocol: string;
  /** The warp route contract holding the collateral. */
  address: string;
  /** The token it holds; absent when the collateral is the chain's own coin. */
  collateral?: string;
  decimals: number;
  standard: string;
}

export function findOtherRoutes(symbol: string): OtherRoute[] {
  const registry = loadHyperlaneRegistry();
  const wanted = symbol.toUpperCase();
  const found: OtherRoute[] = [];

  for (const [routeId, config] of Object.entries(registry)) {
    const routeSymbol = routeId.split("/")[0]?.toUpperCase();
    for (const token of (config as any).tokens ?? []) {
      const chain = getOtherChain(token.chainName);
      if (!chain) continue;

      const tokenSymbol = (token.symbol ?? routeSymbol ?? "").toUpperCase();
      if (tokenSymbol !== wanted && routeSymbol !== wanted) continue;
      if (!/Collateral|Native/i.test(token.standard ?? "")) continue;
      if (typeof token.addressOrDenom !== "string") continue;

      found.push({
        routeId,
        chainKey: chain.key,
        protocol: chain.protocol,
        address: token.addressOrDenom,
        collateral: token.collateralAddressOrDenom,
        decimals: Number(token.decimals ?? 18),
        standard: token.standard,
      });
    }
  }
  return found;
}

/**
 * Starknet addresses functions by a selector rather than a name: the keccak
 * of the name, cut to 250 bits. Computed here rather than copied from
 * anywhere, so it cannot be copied wrongly.
 */
function starknetSelector(name: string): string {
  const masked = BigInt(keccak256(stringToBytes(name))) & ((1n << 250n) - 1n);
  return `0x${masked.toString(16)}`;
}

async function rpc(chainKey: string, body: unknown): Promise<any | undefined> {
  const chain = getOtherChain(chainKey);
  if (!chain) return undefined;

  for (const url of chain.rpcUrls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      const json = (await response.json()) as any;
      if (json?.error) continue;
      return json;
    } catch {
      // Next endpoint.
    }
  }
  return undefined;
}

/**
 * Starknet returns a u256 as two felts, low then high. Reading only the low
 * half would silently divide any large balance by 2^128.
 */
async function readStarknetBalance(route: OtherRoute): Promise<bigint | undefined> {
  if (!route.collateral) return undefined;

  // Cairo 1 renamed the entry point; older tokens keep the camelCase one.
  for (const name of ["balanceOf", "balance_of"]) {
    const json = await rpc(route.chainKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_call",
      params: [
        {
          contract_address: route.collateral,
          entry_point_selector: starknetSelector(name),
          calldata: [route.address],
        },
        "latest",
      ],
    });

    const result = json?.result;
    if (!Array.isArray(result) || result.length === 0) continue;
    const low = BigInt(result[0]);
    const high = result.length > 1 ? BigInt(result[1]) : 0n;
    return low + (high << 128n);
  }
  return undefined;
}

/**
 * Radix answers over its Gateway API: one POST returns everything an entity
 * holds, and the route's collateral is the resource matching its address.
 */
async function readRadixBalance(route: OtherRoute): Promise<bigint | undefined> {
  const chain = getOtherChain(route.chainKey);
  if (!chain || !route.collateral) return undefined;

  for (const base of chain.rpcUrls) {
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}/state/entity/details`, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ addresses: [route.address] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;

      const json = (await response.json()) as any;
      const items = json?.items?.[0]?.fungible_resources?.items ?? [];
      for (const item of items) {
        if (item?.resource_address !== route.collateral) continue;
        const amount = item?.amount ?? item?.vaults?.items?.[0]?.amount;
        if (typeof amount !== "string") continue;
        // Radix reports a decimal string, not base units.
        return decimalToBaseUnits(amount, route.decimals);
      }
    } catch {
      // Next endpoint.
    }
  }
  return undefined;
}

/**
 * Aleo keeps account balances in the credits program's `account` mapping,
 * read straight off the explorer API by address.
 */
async function readAleoBalance(route: OtherRoute): Promise<bigint | undefined> {
  const chain = getOtherChain(route.chainKey);
  if (!chain) return undefined;

  // The registry writes an Aleo route as "program/address"; the balance
  // belongs to the address half.
  const address = route.address.includes("/") ? route.address.split("/")[1] : route.address;
  if (!address) return undefined;

  for (const base of chain.rpcUrls) {
    try {
      const url = `${base.replace(/\/$/, "")}/mainnet/program/credits.aleo/mapping/account/${address}`;
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;

      const text = (await response.text()).trim().replace(/^"|"$/g, "");
      const digits = text.replace(/u\d+$/, "");
      if (!/^\d+$/.test(digits)) continue;
      return BigInt(digits);
    } catch {
      // Next endpoint.
    }
  }
  return undefined;
}

/** "12.34" with 6 decimals becomes 12340000, without floating point. */
export function decimalToBaseUnits(value: string, decimals: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export interface OtherBalanceRow {
  protocol: "hyperlane";
  chainKey: string;
  custodyAddress: string;
  tokenAddress: string;
  note?: string;
  amount: bigint;
  decimals: number;
}

export async function findOtherBalances(symbol: string): Promise<OtherBalanceRow[]> {
  const routes = findOtherRoutes(symbol);
  if (routes.length === 0) return [];

  const rows = await Promise.all(
    routes.map(async (route): Promise<OtherBalanceRow | undefined> => {
      const amount =
        route.protocol === "starknet"
          ? await readStarknetBalance(route)
          : route.protocol === "radix"
            ? await readRadixBalance(route)
            : route.protocol === "aleo"
              ? await readAleoBalance(route)
              : undefined;

      if (amount === undefined) return undefined;

      return {
        protocol: "hyperlane" as const,
        chainKey: route.chainKey,
        custodyAddress: route.address,
        tokenAddress: route.collateral ?? route.address,
        note: route.routeId,
        amount,
        decimals: route.decimals,
      };
    })
  );

  return rows.filter((r): r is OtherBalanceRow => r !== undefined);
}

export function otherChainCount(): number {
  return OTHER_CHAINS.length;
}


// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface OtherProbe {
  step: string;
  outcome: string;
  ok: boolean;
}

/**
 * Shows the exact request each reader makes and what came back.
 *
 * Three of these four chains produced no rows on their first live run, and
 * "no rows" is the same output whether the endpoint refused, the entry point
 * is named differently, or the contract genuinely holds nothing. Only the
 * raw reply separates them.
 */
export async function probeOtherRoute(route: OtherRoute): Promise<OtherProbe[]> {
  const chain = getOtherChain(route.chainKey);
  if (!chain) return [];

  const out: OtherProbe[] = [];
  const say = (step: string, ok: boolean, outcome: string) =>
    out.push({ step, ok, outcome: outcome.replace(/\s+/g, " ").slice(0, 180) });

  if (route.protocol === "starknet") {
    if (!route.collateral) {
      say("залог", false, "маршрут не называет токен, который держит");
      return out;
    }
    for (const name of ["balanceOf", "balance_of"]) {
      const selector = starknetSelector(name);
      try {
        const response = await fetch(chain.rpcUrls[0], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "starknet_call",
            params: [
              { contract_address: route.collateral, entry_point_selector: selector, calldata: [route.address] },
              "latest",
            ],
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await response.text();
        say(`${name} (${selector.slice(0, 12)}…)`, response.ok && !text.includes('"error"'), `HTTP ${response.status} ${text}`);
      } catch (err) {
        say(name, false, err instanceof Error ? err.message : String(err));
      }
    }
    return out;
  }

  if (route.protocol === "radix") {
    try {
      const response = await fetch(`${chain.rpcUrls[0].replace(/\/$/, "")}/state/entity/details`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addresses: [route.address] }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      say("state/entity/details", response.ok, `HTTP ${response.status} ${text}`);
    } catch (err) {
      say("state/entity/details", false, err instanceof Error ? err.message : String(err));
    }
    return out;
  }

  if (route.protocol === "aleo") {
    const address = route.address.includes("/") ? route.address.split("/")[1] : route.address;
    try {
      const url = `${chain.rpcUrls[0].replace(/\/$/, "")}/mainnet/program/credits.aleo/mapping/account/${address}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      say("credits.aleo/account", response.ok, `HTTP ${response.status} ${await response.text()}`);
    } catch (err) {
      say("credits.aleo/account", false, err instanceof Error ? err.message : String(err));
    }
  }

  return out;
}
