import { COSMOS_CHAINS, getCosmosChain } from "../config/cosmosChains";
import { loadHyperlaneRegistry } from "./hyperlane";

/**
 * Hyperlane warp routes on Cosmos chains.
 *
 * Simpler than Sealevel and simpler than EVM: a CosmWasm warp route is a
 * contract with an ordinary address, and the collateral it holds is an
 * ordinary bank balance. Nothing is derived, so nothing can be derived
 * wrongly - one HTTP GET answers the whole question.
 *
 * The exception is Hyperlane's native Cosmos module, whose routes are
 * identified by a hex router id rather than an address. Those hold their
 * collateral in a module account that would have to be derived, so they are
 * left out here rather than guessed at, and counted where the report can say
 * so.
 */
export interface CosmosRoute {
  routeId: string;
  chainKey: string;
  /** The contract holding the collateral. */
  address: string;
  /** The denom it holds: the route's own, or the chain's native one. */
  denom: string;
  decimals: number;
  standard: string;
}

function isBech32(value: string): boolean {
  return /^[a-z]+1[02-9ac-hj-np-z]{6,}$/.test(value);
}

export function findCosmosRoutes(symbol: string): CosmosRoute[] {
  const registry = loadHyperlaneRegistry();
  const wanted = symbol.toUpperCase();
  const found: CosmosRoute[] = [];

  for (const [routeId, config] of Object.entries(registry)) {
    const routeSymbol = routeId.split("/")[0]?.toUpperCase();
    for (const token of (config as any).tokens ?? []) {
      const chain = getCosmosChain(token.chainName);
      if (!chain) continue;

      const tokenSymbol = (token.symbol ?? routeSymbol ?? "").toUpperCase();
      if (tokenSymbol !== wanted && routeSymbol !== wanted) continue;
      if (!/Collateral|Native/i.test(token.standard ?? "")) continue;

      // A route addressed by a hex router id belongs to the native module,
      // whose collateral sits in an account this code cannot yet derive.
      const address = token.addressOrDenom;
      if (typeof address !== "string" || !isBech32(address)) continue;

      // A collateral route names the denom it locks; a native one locks the
      // chain's own coin and names nothing.
      const denom = token.collateralAddressOrDenom ?? chain.nativeDenom;
      if (!denom) continue;

      found.push({
        routeId,
        chainKey: chain.key,
        address,
        denom,
        decimals: Number(token.decimals ?? chain.nativeDecimals ?? 6),
        standard: token.standard,
      });
    }
  }
  return found;
}

/** How many routes were skipped for needing a derivation we do not have. */
export function countCosmosNativeRoutes(symbol: string): number {
  const registry = loadHyperlaneRegistry();
  const wanted = symbol.toUpperCase();
  let n = 0;

  for (const [routeId, config] of Object.entries(registry)) {
    const routeSymbol = routeId.split("/")[0]?.toUpperCase();
    for (const token of (config as any).tokens ?? []) {
      if (!getCosmosChain(token.chainName)) continue;
      const tokenSymbol = (token.symbol ?? routeSymbol ?? "").toUpperCase();
      if (tokenSymbol !== wanted && routeSymbol !== wanted) continue;
      if (!/Collateral|Native/i.test(token.standard ?? "")) continue;
      if (typeof token.addressOrDenom === "string" && !isBech32(token.addressOrDenom)) n++;
    }
  }
  return n;
}

export interface CosmosBalanceRow {
  protocol: "hyperlane";
  chainKey: string;
  custodyAddress: string;
  tokenAddress: string;
  note?: string;
  amount: bigint;
  decimals: number;
}

/** Reads one address's balance of one denom over the chain's REST API. */
async function readBankBalance(chainKey: string, address: string, denom: string): Promise<bigint | undefined> {
  const chain = getCosmosChain(chainKey);
  if (!chain) return undefined;

  for (const base of chain.restUrls) {
    try {
      const url = `${base.replace(/\/$/, "")}/cosmos/bank/v1beta1/balances/${encodeURIComponent(
        address
      )}/by_denom?denom=${encodeURIComponent(denom)}`;
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;

      const body = (await response.json()) as any;
      const amount = body?.balance?.amount;
      if (typeof amount === "string") return BigInt(amount);
    } catch {
      // Try the next endpoint rather than dropping the chain: a missing row
      // reads as "no liquidity here", which is the opposite of what it means.
    }
  }
  return undefined;
}

export async function findCosmosBalances(symbol: string): Promise<CosmosBalanceRow[]> {
  const routes = findCosmosRoutes(symbol);
  if (routes.length === 0) return [];

  const results: Array<CosmosBalanceRow | undefined> = await Promise.all(
    routes.map(async (route): Promise<CosmosBalanceRow | undefined> => {
      const amount = await readBankBalance(route.chainKey, route.address, route.denom);
      if (amount === undefined) return undefined;

      return {
        protocol: "hyperlane" as const,
        chainKey: route.chainKey,
        custodyAddress: route.address,
        tokenAddress: route.denom,
        note: route.routeId,
        amount,
        decimals: route.decimals,
      };
    })
  );

  return results.filter((r): r is CosmosBalanceRow => r !== undefined);
}

/** Chains covered here, for the /sources report. */
export function cosmosChainCount(): number {
  return COSMOS_CHAINS.length;
}
