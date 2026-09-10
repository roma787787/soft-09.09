import type { Address } from "viem";
import type { Custodian } from "./types";
import { PORTAL_TOKEN_BRIDGE_BY_CHAIN } from "../protocols/addresses/portal";
import { findHyperlaneCustodians } from "./hyperlane";
import { findLayerZeroCustodians } from "./layerzero";
import type { TokenPlatform } from "../services/cmc";

/**
 * Wormhole's Token Bridge is one fixed contract per chain that holds every
 * token it has ever locked, so the custodian is known without any per-token
 * lookup - only the balance differs.
 */
function findWormholeCustodians(tokenByChain: Map<string, Address>): Custodian[] {
  const found: Custodian[] = [];
  for (const [chainKey, tokenAddress] of tokenByChain) {
    const bridge = PORTAL_TOKEN_BRIDGE_BY_CHAIN[chainKey];
    if (!bridge) continue;
    found.push({ protocol: "wormhole", chainKey, custodyAddress: bridge, tokenAddress });
  }
  return found;
}

/**
 * Collects every known custody contract for a token across the supported
 * bridges. Hyperlane routes are matched by ticker in its registry, so they
 * can name a chain CoinMarketCap did not list; those are kept, since the
 * question is where liquidity sits, not what CMC happens to know.
 */
export function tokenByChainFrom(platforms: TokenPlatform[]): Map<string, Address> {
  const tokenByChain = new Map<string, Address>();
  for (const p of platforms) {
    if (p.chainKey && !tokenByChain.has(p.chainKey)) tokenByChain.set(p.chainKey, p.tokenAddress);
  }
  return tokenByChain;
}

export function resolveCustodians(symbol: string, platforms: TokenPlatform[]): Custodian[] {
  const tokenByChain = tokenByChainFrom(platforms);

  const custodians = [
    ...findLayerZeroCustodians(symbol, tokenByChain),
    ...findHyperlaneCustodians(symbol),
    ...findWormholeCustodians(tokenByChain),
  ];

  return dedupeCustodians(custodians);
}

/**
 * Collapses custodians that name the same contract on the same chain. One
 * contract legitimately arrives twice - two warp routes sharing a router, or
 * the registry and a contract probe agreeing - and a duplicated row would
 * read as twice the liquidity that actually exists.
 */
export function dedupeCustodians(custodians: Custodian[]): Custodian[] {
  const seen = new Set<string>();
  return custodians.filter((c) => {
    const key = `${c.protocol}:${c.chainKey}:${c.custodyAddress.toLowerCase()}:${c.tokenAddress.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
