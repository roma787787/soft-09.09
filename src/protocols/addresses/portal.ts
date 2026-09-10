import type { Address } from "viem";
import { chainToChainId, contracts, nativeChainIds } from "@wormhole-foundation/sdk-base";
import { CHAINS } from "../../config/chains";

/**
 * Portal = Wormhole's Token Bridge ("Wormhole: Token Bridge" on explorers),
 * a different address on every chain.
 *
 * The table is not written by hand. It is derived from Wormhole's own
 * published registry (`@wormhole-foundation/sdk-base`), matched to our
 * chains by EVM chain id rather than by name - a chain id is a number the
 * two sides already agree on, while names ("bsc" vs "Bsc" vs "BNB Chain")
 * are exactly where a mapping silently goes wrong.
 *
 * This started as a hand-copied list, and hand-copying cost three addresses
 * a character each. Deriving it removes that whole class of mistake and
 * means a chain added to chains.ts gets its Token Bridge for free.
 *
 * Wormhole is not everywhere: Linea, Mode and Blast have no Token Bridge, so
 * they contribute rows from the other bridges only.
 */
function buildTokenBridgeMap(): Partial<Record<string, Address>> {
  const map: Partial<Record<string, Address>> = {};

  for (const chain of CHAINS) {
    let wormholeChain: string | undefined;
    try {
      const [network, name] = nativeChainIds.platformNativeChainIdToNetworkChain(
        "Evm",
        BigInt(chain.viemChain.id)
      );
      if (network !== "Mainnet") continue;
      wormholeChain = name;
    } catch {
      // Wormhole does not know this chain at all.
      continue;
    }

    try {
      const address = contracts.tokenBridge("Mainnet", wormholeChain as never);
      if (address) map[chain.key] = address as Address;
    } catch {
      // Known chain, no Token Bridge deployed on it.
    }
  }

  return map;
}

export const PORTAL_TOKEN_BRIDGE_BY_CHAIN: Partial<Record<string, Address>> = buildTokenBridgeMap();

/**
 * Wormhole chain IDs, from the same registry. Used to label peers on chains
 * the bot has no RPC connection to.
 */
function buildWormholeChainIdMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const chain of CHAINS) {
    try {
      const [network, name] = nativeChainIds.platformNativeChainIdToNetworkChain(
        "Evm",
        BigInt(chain.viemChain.id)
      );
      if (network !== "Mainnet") continue;
      map[chain.key] = chainToChainId(name);
    } catch {
      // Not a Wormhole chain.
    }
  }
  return map;
}

export const WORMHOLE_CHAIN_ID_BY_CHAIN: Record<string, number> = buildWormholeChainIdMap();
