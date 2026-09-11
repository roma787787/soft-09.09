import { chains, chainToPlatform, contracts } from "@wormhole-foundation/sdk-base";
import { COSMOS_CHAINS, getCosmosChain, resolveCosmosChain } from "./cosmosChains";

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

/** A chain's name without the qualifier that keeps its key unique. */
function bareName(value: string): string {
  return value.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
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
    //
    // On the label first, with any qualifier in brackets dropped. Sei is one
    // brand with two execution environments, so the CosmWasm side is filed
    // under "seicosmos" and labelled "Sei (Cosmos)" to keep the EVM chain's
    // key and explorer to itself - and matching on the key alone then lost
    // the chain entirely, which is the silent kind of loss: a bridge that
    // simply stops being asked reads as a bridge holding nothing.
    const wanted = String(chain);
    const ours =
      COSMOS_CHAINS.find((c) => bareName(c.label) === bareName(wanted)) ??
      resolveCosmosChain(wanted) ??
      getCosmosChain(wanted.toLowerCase());
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
