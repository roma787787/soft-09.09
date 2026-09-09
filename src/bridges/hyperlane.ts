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
    cache = JSON.parse(json) as Record<string, WarpRouteConfig>;
    console.log(`[hyperlane] загружено маршрутов: ${Object.keys(cache).length}`);
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
export function findHyperlaneCustodians(symbol: string): Custodian[] {
  const registry = loadRegistry();
  const wanted = symbol.toUpperCase();
  const found: Custodian[] = [];

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

      found.push({
        protocol: "hyperlane",
        chainKey,
        custodyAddress: custody as Address,
        tokenAddress: collateral as Address,
        note: routeId,
      });
    }
  }

  return found;
}

/** How many routes the registry holds, for the /sources report. */
export function hyperlaneRouteCount(): number {
  return Object.keys(loadRegistry()).length;
}
