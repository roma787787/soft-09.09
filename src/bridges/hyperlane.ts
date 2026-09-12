import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { isAddress } from "viem";
import type { Custodian } from "./types";
import { getChain } from "../config/chains";

interface WarpToken {
  addressOrDenom?: string;
  chainName?: string;
  collateralAddressOrDenom?: string;
  symbol?: string;
  standard?: string;
}

interface WarpRouteConfig {
  tokens?: WarpToken[];
}

let cache: Record<string, WarpRouteConfig> | undefined;
let loadFailed = false;

/**
 * Loads Hyperlane's public warp-route registry.
 *
 * The registry ships as a generated data module inside
 * @hyperlane-xyz/registry. We read that file rather than importing the
 * package: it is ESM-only and its entry point pulls in the wider Hyperlane
 * SDK, while the data file itself is a self-contained JSON literal. Failing
 * to load it must never take the bot down, so this degrades to "no
 * Hyperlane routes known".
 */
export function loadHyperlaneRegistry(): Record<string, WarpRouteConfig> {
  return loadRegistry();
}

/** How many the last load left out, so /sources can say so. */
let skippedRoutes = 0;

/**
 * Whether a route id names a real deployment rather than a test one.
 *
 * Judged on the deployment half of the id, never the ticker. The registry
 * files a route as "<TICKER>/<deployment>", and a token can legitimately be
 * called REZSTAGING - dropping it because its own name contains "staging"
 * would hide the very route someone asking for that ticker wants.
 */
export function isProductionRoute(routeId: string): boolean {
  const slash = routeId.indexOf("/");
  const deployment = slash === -1 ? routeId : routeId.slice(slash + 1);
  return !/testnet|staging|sandbox|sepolia|holesky|goerli|devnet/i.test(deployment);
}

/**
 * Whether a warp route's standard means it escrows what it carries.
 *
 * "Collateral or Native" was the test, and on the Cosmos family it is not
 * enough: their standards are named CosmosNativeHypCollateral and
 * CosmosNativeHypSynthetic, so the synthetic one matches on the "Native" in
 * the middle of its own name. USDC's Celestia route is exactly that - a
 * synthetic that mints its own supply and holds nothing - and it was read as
 * collateral. With no collateral denom of its own the reader then fell back
 * to the chain's coin and printed the Hyperlane module's TIA balance under
 * the ticker USDC: 92.6785 of somebody else's asset, in a report whose whole
 * job is to say how much of yours is there.
 *
 * So synthetic is refused by name, ahead of everything else. It is the one
 * word that means "holds nothing" on every VM the registry covers.
 */
export function routeHoldsCollateral(standard: string | undefined): boolean {
  const name = standard ?? "";
  if (/synthetic/i.test(name)) return false;
  return /Collateral|Native/i.test(name);
}

/** Routes left out as test deployments, for the coverage report. */
export function hyperlaneSkippedRoutes(): number {
  loadRegistry();
  return skippedRoutes;
}

function loadRegistry(): Record<string, WarpRouteConfig> {
  if (cache) return cache;
  if (loadFailed) return {};

  try {
    const file = path.join(
      process.cwd(),
      "node_modules",
      "@hyperlane-xyz",
      "registry",
      "dist",
      "warpRouteConfigs.js"
    );
    const raw = fs.readFileSync(file, "utf8");
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const all = JSON.parse(json) as Record<string, WarpRouteConfig>;

    // Dropped once, here, rather than at each of the six places routes are
    // walked. The registry ships the team's test deployments beside the real
    // ones and does not flag them, so "USDT/moonpay-staging: 1 USDT" was
    // printed on Katana as liquidity - real tokens on a route nobody bridges
    // through, which is the same lie a testnet in the chain table tells, one
    // level down.
    cache = Object.fromEntries(Object.entries(all).filter(([routeId]) => isProductionRoute(routeId)));
    skippedRoutes = Object.keys(all).length - Object.keys(cache).length;
    console.log(
      `[hyperlane] загружено маршрутов: ${Object.keys(cache).length}` +
        `${skippedRoutes > 0 ? ` (пропущено тестовых и staging: ${skippedRoutes})` : ""}`
    );
    return cache;
  } catch (err) {
    loadFailed = true;
    console.error("[hyperlane] не удалось прочитать реестр warp-маршрутов:", err);
    return {};
  }
}

/**
 * Finds the collateral routers holding this token. Only routes that lock a
 * real ERC-20 are useful here: a synthetic route mints its own supply on the
 * far side and holds nothing, so it says nothing about withdrawable liquidity.
 */
/**
 * Of the names one contract is filed under, the one that answers the
 * question asked.
 *
 * A route id's prefix is usually the asset - "USDT/moonpay" - but not
 * always: "CROSS/moonpay" is named after the kind of router, and tells
 * someone asking about USDT0 nothing at all. So an exact ticker wins, then
 * a ticker that is a variant of it (USDT holds the collateral behind USDT0,
 * and each is a prefix of the other), then alphabetical order, so that the
 * same contract is named the same way twice running.
 *
 * Three characters at least before two names count as variants; shorter
 * than that and unrelated tickers start matching each other.
 */
const MIN_VARIANT_PREFIX = 3;

export function preferredRouteId(routeIds: string[], wanted: string): string {
  const score = (routeId: string): number => {
    const prefix = (routeId.split("/")[0] ?? "").toUpperCase();
    if (!prefix) return 0;
    if (prefix === wanted) return 3;
    const shorter = Math.min(prefix.length, wanted.length);
    if (shorter >= MIN_VARIANT_PREFIX && (wanted.startsWith(prefix) || prefix.startsWith(wanted))) return 2;
    return 1;
  };
  return [...new Set(routeIds)].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

export function findHyperlaneCustodians(symbol: string): Custodian[] {
  const registry = loadRegistry();
  const wanted = symbol.toUpperCase();

  // Grouped by the contract, not by the name the registry filed it under.
  // The same deployment is listed more than once - Polygon's MoonPay router
  // 0x766A…1270 appears as both "USDT/moonpay" and "CROSS/moonpay" - and
  // whichever name sorted first was the one shown, so asking about USDT0
  // produced "CROSS/moonpay", a name with no visible connection to the
  // question. The balance was never wrong and never doubled; only the
  // provenance was, and provenance is what this bot is for.
  const byContract = new Map<string, { custodian: Custodian; routeIds: string[] }>();

  for (const [routeId, config] of Object.entries(registry)) {
    const routeSymbol = routeId.split("/")[0]?.toUpperCase();
    for (const token of config.tokens ?? []) {
      const tokenSymbol = (token.symbol ?? routeSymbol ?? "").toUpperCase();
      if (tokenSymbol !== wanted && routeSymbol !== wanted) continue;

      const custody = token.addressOrDenom;
      const collateral = token.collateralAddressOrDenom;
      if (!custody || !collateral) continue;
      if (!isAddress(custody, { strict: false }) || !isAddress(collateral, { strict: false })) continue;

      const chainKey = token.chainName && getChain(token.chainName) ? token.chainName : undefined;
      if (!chainKey) continue;

      const key = `${chainKey}:${custody.toLowerCase()}:${collateral.toLowerCase()}`;
      const existing = byContract.get(key);
      if (existing) {
        existing.routeIds.push(routeId);
        continue;
      }
      byContract.set(key, {
        routeIds: [routeId],
        custodian: {
          protocol: "hyperlane",
          chainKey,
          custodyAddress: custody as Address,
          tokenAddress: collateral as Address,
          note: routeId,
        },
      });
    }
  }

  return [...byContract.values()].map(({ custodian, routeIds }) => ({
    ...custodian,
    note: preferredRouteId(routeIds, wanted),
  }));
}

/**
 * Chains where a warp route exists for this ticker but mints its own supply
 * instead of locking collateral. Nothing is held there by design, so the
 * route is real even though no balance can be read - reporting the token as
 * "not bridged" would be wrong.
 */
export function findSyntheticHyperlaneChains(symbol: string): string[] {
  const registry = loadRegistry();
  const wanted = symbol.toUpperCase();
  const chains = new Set<string>();

  for (const [routeId, config] of Object.entries(registry)) {
    const routeSymbol = routeId.split("/")[0]?.toUpperCase();
    for (const token of config.tokens ?? []) {
      const tokenSymbol = (token.symbol ?? routeSymbol ?? "").toUpperCase();
      if (tokenSymbol !== wanted && routeSymbol !== wanted) continue;
      if (token.collateralAddressOrDenom) continue;
      if (token.chainName && getChain(token.chainName)) chains.add(token.chainName);
    }
  }
  return [...chains];
}

/** How many routes the registry holds, for the /sources report. */
export function hyperlaneRouteCount(): number {
  return Object.keys(loadRegistry()).length;
}
