import { COSMOS_CHAINS, getCosmosChain } from "../config/cosmosChains";
import { endpointsWithOverride } from "../config/env";
import { loadHyperlaneRegistry, routeHoldsCollateral } from "./hyperlane";
import type { NonEvmReadResult } from "./types";

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
      if (!routeHoldsCollateral(token.standard)) continue;

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
      if (!routeHoldsCollateral(token.standard)) continue;
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
export async function readBankBalance(chainKey: string, address: string, denom: string): Promise<bigint | undefined> {
  const chain = getCosmosChain(chainKey);
  if (!chain) return undefined;

  for (const base of endpointsWithOverride(chain.rpcEnvVar, chain.restUrls)) {
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

export async function findCosmosBalances(symbol: string): Promise<NonEvmReadResult<CosmosBalanceRow>> {
  const routes = findCosmosRoutes(symbol);
  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  for (const route of routes) attempts[route.chainKey] = (attempts[route.chainKey] ?? 0) + 1;

  if (routes.length === 0) return { rows: [], attempts, failures };

  const results: Array<CosmosBalanceRow | undefined> = await Promise.all(
    routes.map(async (route): Promise<CosmosBalanceRow | undefined> => {
      const amount = await readBankBalance(route.chainKey, route.address, route.denom);
      if (amount === undefined) {
        failures[route.chainKey] = (failures[route.chainKey] ?? 0) + 1;
        return undefined;
      }

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

  return { rows: results.filter((r): r is CosmosBalanceRow => r !== undefined), attempts, failures };
}

/** Chains covered here, for the /sources report. */
export function cosmosChainCount(): number {
  return COSMOS_CHAINS.length;
}


// ---------------------------------------------------------------------------
// Hyperlane's native Cosmos module
// ---------------------------------------------------------------------------

export interface NativeModuleRoute {
  routeId: string;
  chainKey: string;
  /** The hex id the module addresses this route by. */
  routerId: string;
  standard: string;
  decimals: number;
  /** The denom the module escrows for this route. */
  denom?: string;
}

/**
 * Routes held by Hyperlane's own Cosmos module rather than by a contract.
 *
 * These are the ones findCosmosRoutes leaves out: addressed by a hex router
 * id, with the collateral in an account that is not the id. Rather than
 * derive that account, the module's REST API is asked - which path answers
 * is something the chain can state, and stating beats guessing.
 */
export function findNativeModuleRoutes(symbol: string): NativeModuleRoute[] {
  const registry = loadHyperlaneRegistry();
  const wanted = symbol.toUpperCase();
  const found: NativeModuleRoute[] = [];

  for (const [routeId, config] of Object.entries(registry)) {
    const routeSymbol = routeId.split("/")[0]?.toUpperCase();
    for (const token of (config as any).tokens ?? []) {
      const chain = getCosmosChain(token.chainName);
      if (!chain) continue;

      const tokenSymbol = (token.symbol ?? routeSymbol ?? "").toUpperCase();
      if (tokenSymbol !== wanted && routeSymbol !== wanted) continue;
      if (!routeHoldsCollateral(token.standard)) continue;

      const id = token.addressOrDenom;
      if (typeof id !== "string" || isBech32(id)) continue;

      found.push({
        routeId,
        chainKey: chain.key,
        routerId: id,
        standard: token.standard,
        decimals: Number(token.decimals ?? chain.nativeDecimals ?? 6),
        denom: token.collateralAddressOrDenom ?? chain.nativeDenom,
      });
    }
  }
  return found;
}

export interface ModuleProbe {
  path: string;
  outcome: string;
  ok: boolean;
}

/**
 * Asks the module every way it might answer, and reports each reply.
 *
 * The paths are candidates, not knowledge: a wrong one returns a 404, which
 * costs a request and tells us so. What must not happen is inventing an
 * account address, reading someone else's balance from it and printing that
 * as this token's liquidity.
 */
export async function probeNativeModule(chainKey: string, routerId: string): Promise<ModuleProbe[]> {
  const chain = getCosmosChain(chainKey);
  if (!chain) return [];

  const paths = [
    // A control: every Cosmos REST endpoint serves this. If it fails too,
    // the endpoint is the problem and no path would have worked - which is
    // a different fix from finding the right path, and the two are
    // indistinguishable without asking.
    `/cosmos/base/tendermint/v1beta1/node_info`,
    // The module's own queries, kept so a chain that starts serving them is
    // noticed. Three independent Celestia hosts answered 501 to all of
    // these, which is a gateway not serving the module rather than a wrong
    // path - and no further guessing at paths would have helped.
    `/hyperlane/warp/v1/tokens`,
  ];

  const out: ModuleProbe[] = [];
  // Every endpoint the registry lists, not just the first: a public node
  // that serves only the standard modules answers 501 to everything else,
  // and another host on the same chain may not.
  for (const rawBase of endpointsWithOverride(chain.rpcEnvVar, chain.restUrls)) {
    const base = rawBase.replace(/\/$/, "");
    for (const path of paths) {
      try {
        const response = await fetch(`${base}${path}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          out.push({ path: `${shortHost(base)}${shorten(path, routerId)}`, outcome: `HTTP ${response.status}`, ok: false });
          continue;
        }
        const text = (await response.text()).replace(/\s+/g, " ");
        out.push({ path: `${shortHost(base)}${shorten(path, routerId)}`, outcome: text.slice(0, 200), ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
        out.push({
          path: `${shortHost(base)}${shorten(path, routerId)}`,
          outcome: `ошибка: ${message.slice(0, 60)}`,
          ok: false,
        });
      }
    }
  }
  return out;
}

/** Keeps the report readable: the host, not the whole URL. */
function shortHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** The router id is 66 characters and the same on every line. */
function shorten(path: string, routerId: string): string {
  return path.replace(routerId, "<id>");
}


/**
 * The account Hyperlane's Cosmos module escrows collateral in.
 *
 * Not derived: Cosmos lists its module accounts by name through the standard
 * auth module, so the chain states which address belongs to Hyperlane and
 * this only has to read it. Deriving an address instead would risk landing
 * on an account that exists and belongs to something else, whose balance
 * would then be printed under this token's name.
 */
export interface ModuleAccount {
  name: string;
  address: string;
  host: string;
}

export async function findHyperlaneModuleAccount(chainKey: string): Promise<ModuleAccount | undefined> {
  const chain = getCosmosChain(chainKey);
  if (!chain) return undefined;

  for (const rawBase of endpointsWithOverride(chain.rpcEnvVar, chain.restUrls)) {
    try {
      const response = await fetch(`${rawBase.replace(/\/$/, "")}/cosmos/auth/v1beta1/module_accounts`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;

      const body = (await response.json()) as any;
      const accounts = Array.isArray(body?.accounts) ? body.accounts : [];

      const matches: ModuleAccount[] = [];
      for (const account of accounts) {
        const name: unknown = account?.name ?? account?.base_account?.name;
        const address: unknown = account?.base_account?.address ?? account?.address;
        if (typeof name === "string" && /hyperlane|warp/i.test(name) && typeof address === "string") {
          // The name comes back with the address, so the report can say
          // whose balance it is showing rather than only that it found one.
          matches.push({ name, address, host: new URL(rawBase).host });
        }
      }
      if (matches.length === 0) continue;

      // Order matters once there is more than one. Taking whichever the node
      // happened to list first would make the answer depend on the node, and
      // a sub-account like "hyperlane_fee" holds a different balance than
      // the escrow while matching just as well. Celestia names its escrow
      // exactly "hyperlane"; the shortest name is the fallback, since a
      // sub-account's name is the module's name with something appended.
      matches.sort((a, b) => {
        const rank = (n: string) => (n.toLowerCase() === "hyperlane" ? 0 : n.toLowerCase() === "warp" ? 1 : 2);
        return rank(a.name) - rank(b.name) || a.name.length - b.name.length;
      });
      return matches[0];
    } catch {
      // Next host.
    }
  }
  return undefined;
}

/**
 * Balances held by Hyperlane's Cosmos module.
 *
 * One row per chain and denom rather than per route: the module escrows
 * every route's collateral in one account, so the routes cannot be told
 * apart from the outside. Reporting the same balance once per route would
 * multiply it, which for a report about whether a withdrawal will go through
 * is the worst possible error.
 */
export async function findNativeModuleBalances(symbol: string): Promise<NonEvmReadResult<CosmosBalanceRow>> {
  const routes = findNativeModuleRoutes(symbol);
  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  if (routes.length === 0) return { rows: [], attempts, failures };

  const byChainDenom = new Map<string, { chainKey: string; denom: string; decimals: number }>();
  for (const route of routes) {
    if (!route.denom) continue;
    const key = `${route.chainKey}:${route.denom}`;
    if (!byChainDenom.has(key)) {
      byChainDenom.set(key, { chainKey: route.chainKey, denom: route.denom, decimals: route.decimals });
    }
  }

  const rows = await Promise.all(
    [...byChainDenom.values()].map(async (entry): Promise<CosmosBalanceRow | undefined> => {
      attempts[entry.chainKey] = (attempts[entry.chainKey] ?? 0) + 1;

      const account = await findHyperlaneModuleAccount(entry.chainKey);
      if (!account) {
        failures[entry.chainKey] = (failures[entry.chainKey] ?? 0) + 1;
        return undefined;
      }

      const amount = await readBankBalance(entry.chainKey, account.address, entry.denom);
      if (amount === undefined) {
        failures[entry.chainKey] = (failures[entry.chainKey] ?? 0) + 1;
        return undefined;
      }

      return {
        protocol: "hyperlane" as const,
        chainKey: entry.chainKey,
        custodyAddress: account.address,
        tokenAddress: entry.denom,
        note: `модуль ${account.name}, общий залог сети`,
        amount,
        decimals: entry.decimals,
      };
    })
  );

  return { rows: rows.filter((r): r is CosmosBalanceRow => r !== undefined), attempts, failures };
}
