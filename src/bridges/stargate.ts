import type { Address } from "viem";
import type { Custodian } from "./types";
import { CHAINS, getChain } from "../config/chains";
import { getClient } from "../services/rpcClient";
import {
  STARGATE_POOLS_BY_SYMBOL,
  STARGATE_NATIVE_POOLS_BY_CHAIN_ID,
} from "../protocols/addresses/stargate.generated";

/**
 * Stargate is LayerZero's own liquidity layer, and for the tokens people
 * bridge to arbitrage - USDC, USDT, ETH - its pools hold more than anything
 * else this bot measures. No public registry maps a ticker to them, which is
 * exactly why LayerZero coverage was thin: the largest pools were the ones
 * nothing could find.
 *
 * The pools come from Stargate's published deployments, keyed by token
 * symbol and chain id. What each pool actually holds is not assumed from
 * that symbol - the contract is asked.
 */
const POOL_ABI = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** Aliases for tickers whose Stargate pool is named differently. */
const SYMBOL_ALIASES: Record<string, string> = {
  WETH: "ETH",
  WMETIS: "METIS",
  WMETH: "METH",
};

function poolsFor(symbol: string): Record<number, Address> | undefined {
  const wanted = symbol.toUpperCase();
  return STARGATE_POOLS_BY_SYMBOL[wanted] ?? STARGATE_POOLS_BY_SYMBOL[SYMBOL_ALIASES[wanted] ?? ""];
}

/** Our chain key for an EVM chain id, or undefined when unsupported. */
function chainKeyForId(chainId: number): string | undefined {
  return CHAINS.find((c) => c.viemChain.id === chainId)?.key;
}

/**
 * Every Stargate pool holding this token, on the chains we support.
 *
 * The pool is asked which ERC-20 it holds rather than being paired with
 * whatever CoinGecko listed for that chain: the pool is the authority on
 * its own collateral, and this also works on chains CoinGecko does not
 * list the token for at all.
 */
export async function findStargateCustodians(symbol: string): Promise<Custodian[]> {
  return [...(await findErc20Pools(symbol)), ...findNativePools(symbol)];
}

/**
 * Pools holding the chain's own coin. On an Ethereum L2 that coin is ETH,
 * and these hold far more of it than any wrapped-token pool - leaving them
 * out made the largest ETH liquidity on the report invisible.
 *
 * A pool is only included when the chain's native currency is the token
 * being asked about. That rule is what keeps a Metis pool out of an ETH
 * report: the contract is named the same everywhere, but what it holds
 * follows the chain, not the name.
 */
function findNativePools(symbol: string): Custodian[] {
  const wanted = (SYMBOL_ALIASES[symbol.toUpperCase()] ?? symbol).toUpperCase();

  const found: Custodian[] = [];
  for (const [rawId, pool] of Object.entries(STARGATE_NATIVE_POOLS_BY_CHAIN_ID)) {
    const chain = CHAINS.find((c) => c.viemChain.id === Number(rawId));
    if (!chain) continue;
    if (chain.viemChain.nativeCurrency.symbol.toUpperCase() !== wanted) continue;

    found.push({
      protocol: "stargate",
      chainKey: chain.key,
      custodyAddress: pool,
      // Nothing to read a balance against; the pool holds the coin itself.
      tokenAddress: pool,
      readsNativeCoin: true,
      note: `нативный ${chain.viemChain.nativeCurrency.symbol}`,
    });
  }
  return found;
}

async function findErc20Pools(symbol: string): Promise<Custodian[]> {
  const pools = poolsFor(symbol);
  if (!pools) return [];

  const candidates: Array<{ chainKey: string; pool: Address }> = [];
  for (const [rawId, pool] of Object.entries(pools)) {
    const chainKey = chainKeyForId(Number(rawId));
    if (chainKey && getChain(chainKey)) candidates.push({ chainKey, pool });
  }

  const held = await Promise.all(
    candidates.map(async ({ chainKey, pool }) => {
      try {
        const token = (await getClient(chainKey).readContract({
          address: pool,
          abi: POOL_ABI,
          functionName: "token",
        })) as Address;
        return token && token !== "0x0000000000000000000000000000000000000000" ? token : undefined;
      } catch {
        return undefined;
      }
    })
  );

  return candidates
    .map((c, i) => ({ ...c, token: held[i] }))
    .filter((c): c is { chainKey: string; pool: Address; token: Address } => c.token !== undefined)
    .map((c) => ({
      protocol: "stargate" as const,
      chainKey: c.chainKey,
      custodyAddress: c.pool,
      tokenAddress: c.token,
    }));
}

/** Which tickers Stargate pools cover, for the /sources report. */
export function stargateCoverage(): { assets: string[]; pools: number } {
  const assets = Object.keys(STARGATE_POOLS_BY_SYMBOL);
  const erc20 = assets.reduce(
    (n, a) => n + Object.keys(STARGATE_POOLS_BY_SYMBOL[a]).filter((id) => chainKeyForId(Number(id))).length,
    0
  );
  const native = Object.keys(STARGATE_NATIVE_POOLS_BY_CHAIN_ID).filter((id) => chainKeyForId(Number(id))).length;
  return { assets, pools: erc20 + native };
}
