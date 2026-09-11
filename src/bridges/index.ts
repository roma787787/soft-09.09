import type { Address } from "viem";
import type { Custodian } from "./types";
import { PORTAL_TOKEN_BRIDGE_BY_CHAIN } from "../protocols/addresses/portal";
import { findHyperlaneCustodians } from "./hyperlane";
import { findLayerZeroCustodians } from "./layerzero";
import type { TokenPlatform } from "../services/coingecko";

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
 * can name a chain CoinGecko did not list; those are kept, since the
 * question is where liquidity sits, not what CoinGecko happens to know.
 */
export function tokenByChainFrom(platforms: TokenPlatform[]): Map<string, Address> {
  const tokenByChain = new Map<string, Address>();
  for (const p of platforms) {
    if (p.chainKey && !tokenByChain.has(p.chainKey)) tokenByChain.set(p.chainKey, p.tokenAddress);
  }
  return tokenByChain;
}

/**
 * Adds the chains where a bridge has already told us the token's address.
 *
 * The shared vaults - Across, and CCIP's pool lookup - can only be asked
 * about a token they are given an address for, and that address came from
 * the price API alone. For USDT the price API lists five EVM chains, so
 * Across was asked on two of the twenty-seven it is deployed on, and the
 * USDT it holds on Arbitrum, Base, Optimism and Polygon went unreported -
 * on a token whose whole report is about where the liquidity is.
 *
 * The addresses were in hand the entire time. An OFT adapter names the
 * ERC-20 it locks, a Stargate pool names the token it holds, and each was
 * confirmed against the contract before it earned a row - so a custodian
 * already in the report is a chain where the token's address is known
 * better than the price API knows it.
 *
 * The price API still wins where both have an answer: it is the one source
 * tied to the ticker a person typed, and a bridge naming something else on
 * some chain must not redirect the vault lookup there.
 */
export function withCustodianTokens(
  tokenByChain: Map<string, Address>,
  custodians: Array<{ chainKey: string; tokenAddress: Address }>
): Map<string, Address> {
  const enriched = new Map(tokenByChain);
  for (const custodian of custodians) {
    if (!custodian.chainKey || !custodian.tokenAddress) continue;
    if (!enriched.has(custodian.chainKey)) enriched.set(custodian.chainKey, custodian.tokenAddress);
  }
  return enriched;
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
