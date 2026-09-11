import { chains, chainToPlatform, contracts } from "@wormhole-foundation/sdk-base";
import { getCosmosChain, resolveCosmosChain } from "./cosmosChains";

/**
 * The CosmWasm chains Wormhole's Token Bridge is deployed on.
 *
 * Derived the same way the Near and Aptos custody addresses are: from the
 * SDK that ships with the bot, which publishes the contract per chain. Not
 * one address is written down here, so a redeployment arrives with an
 * upgrade instead of going unnoticed.
 *
 * The chains it names that the bot has no endpoint for simply do not appear.
 * That is deliberate - Wormchain is a transit chain with no entry in the
 * Cosmos registry, and an address with nowhere to send the query would be a
 * row the report can never fill.
 */
export interface PortalCosmosChain {
  /** Our key for the chain. */
  chainKey: string;
  /** Wormhole's own name, kept so a mismatch can be read in a diagnostic. */
  wormholeChain: string;
  /** The Token Bridge contract, bech32. */
  tokenBridge: string;
}

function build(): PortalCosmosChain[] {
  const found: PortalCosmosChain[] = [];
  for (const chain of chains) {
    let tokenBridge: string | undefined;
    try {
      if (chainToPlatform(chain as never) !== "Cosmwasm") continue;
      tokenBridge = contracts.tokenBridge.get("Mainnet", chain as never);
    } catch {
      continue;
    }
    if (!tokenBridge) continue;

    // Matched by name, because a Cosmos chain has no chain id to match on.
    // Both sides use the chain's own short name, and where they do not, the
    // alias table already carries the spellings people type.
    const ours = resolveCosmosChain(String(chain)) ?? getCosmosChain(String(chain).toLowerCase());
    if (!ours) continue;

    found.push({ chainKey: ours.key, wormholeChain: String(chain), tokenBridge });
  }
  return found;
}

export const PORTAL_COSMOS_CHAINS: PortalCosmosChain[] = build();

export function portalCosmosChain(chainKey: string): PortalCosmosChain | undefined {
  return PORTAL_COSMOS_CHAINS.find((c) => c.chainKey === chainKey);
}

/**
 * The chains Wormhole names and the bot cannot reach, so a report can say
 * so rather than leave them out of both the covered list and the gaps.
 */
export function portalCosmosUnreachable(): string[] {
  const covered = new Set(PORTAL_COSMOS_CHAINS.map((c) => c.wormholeChain));
  const missing: string[] = [];
  for (const chain of chains) {
    try {
      if (chainToPlatform(chain as never) !== "Cosmwasm") continue;
      if (!contracts.tokenBridge.get("Mainnet", chain as never)) continue;
    } catch {
      continue;
    }
    if (!covered.has(String(chain))) missing.push(String(chain));
  }
  return missing;
}
