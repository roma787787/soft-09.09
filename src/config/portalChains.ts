const { contracts } = require("@wormhole-foundation/sdk-base");

/**
 * Chains whose only readable custody is Wormhole's Token Bridge.
 *
 * Everything else the bot reads has a warp route, a pool or a shared vault
 * behind it. These have none: no Hyperlane route, no Stargate pool, no
 * Across spoke. What they do have is a Token Bridge, named by Wormhole's own
 * registry - the same registry the EVM side already reads - so the custody
 * address is derived, not typed, exactly as everywhere else.
 *
 * What is typed here is how to reach the chain and how to read a balance on
 * it, because no registry the bot carries describes these chains at all.
 * Each of them speaks its own protocol: Near answers a view call over JSON-
 * RPC, Aptos serves one over REST, and neither resembles eth_call.
 */
export interface PortalChainDef {
  key: string;
  label: string;
  /** Decides which reader is used; there is one per family. */
  protocol: "near" | "aptos";
  /** Wormhole's name for the chain, so the address comes from its registry. */
  wormholeChain: string;
  rpcEnvVar: string;
  rpcUrls: string[];
  explorerAddressUrl: (address: string) => string;
  aliases: string[];
  platformNames?: string[];
}

function tokenBridgeAddress(wormholeChain: string): string | undefined {
  try {
    return contracts.tokenBridge.get("Mainnet", wormholeChain) as string | undefined;
  } catch {
    // A chain Wormhole stops listing loses its custody address and drops out
    // of the table rather than being read at an address nobody vouches for.
    return undefined;
  }
}

const DEFINITIONS: PortalChainDef[] = [
  {
    key: "near",
    label: "Near Protocol",
    protocol: "near",
    wormholeChain: "Near",
    rpcEnvVar: "NEAR_RPC_URL",
    rpcUrls: ["https://rpc.mainnet.near.org", "https://near.lava.build", "https://1rpc.io/near"],
    explorerAddressUrl: (a) => `https://nearblocks.io/address/${a}`,
    aliases: ["near", "nearprotocol"],
    platformNames: ["Near Protocol", "NEAR"],
  },
  {
    key: "aptos",
    label: "Aptos",
    protocol: "aptos",
    wormholeChain: "Aptos",
    rpcEnvVar: "APTOS_RPC_URL",
    rpcUrls: ["https://fullnode.mainnet.aptoslabs.com/v1", "https://aptos-mainnet.public.blastapi.io/v1"],
    explorerAddressUrl: (a) => `https://explorer.aptoslabs.com/account/${a}?network=mainnet`,
    aliases: ["aptos", "apt"],
    platformNames: ["Aptos"],
  },
];

/** Only the chains Wormhole still names a Token Bridge for. */
export const PORTAL_CHAINS: PortalChainDef[] = DEFINITIONS.filter((c) =>
  tokenBridgeAddress(c.wormholeChain)
);

export function portalCustodyAddress(chainKey: string): string | undefined {
  const chain = PORTAL_CHAINS.find((c) => c.key === chainKey);
  return chain ? tokenBridgeAddress(chain.wormholeChain) : undefined;
}

export function getPortalChain(key: string): PortalChainDef | undefined {
  return PORTAL_CHAINS.find((c) => c.key === key);
}

export function resolvePortalChain(input: string): PortalChainDef | undefined {
  const wanted = input.trim().toLowerCase();
  return PORTAL_CHAINS.find(
    (c) => c.key === wanted || c.aliases.includes(wanted) || c.label.toLowerCase() === wanted
  );
}
