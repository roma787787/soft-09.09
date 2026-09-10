import { GENERATED_OTHER_CHAINS } from "./otherChains.generated";

/**
 * The last non-EVM families: Starknet, Radix and Aleo.
 *
 * Eleven warp routes between them, and three unrelated ways of asking for a
 * balance. Small in volume, but a bridge running dry on a chain nobody
 * checks is exactly the case this bot exists for.
 */
export interface OtherChainDef {
  key: string;
  label: string;
  protocol: string;
  rpcEnvVar: string;
  rpcUrls: string[];
  explorerAddressUrl: (address: string) => string;
  aliases: string[];
  platformNames?: string[];
}

const EXTRAS: Record<string, { aliases?: string[]; cmc?: string[]; path?: string; rpcUrls?: string[] }> = {
  // The registry's Starknet endpoint answers 410, discontinued. Its Radix one
  // does not resolve at all. Both are listed first there and would otherwise
  // be the only ones tried - so alternates go in front, and the registry's
  // stay behind them in case they come back.
  starknet: {
    aliases: ["strk"],
    cmc: ["Starknet"],
    path: "contract",
    rpcUrls: [
      // Four endpoints failed four different ways: Blast discontinued,
      // Nethermind unreachable, dRPC serves Starknet without starknet_call,
      // Lava discontinued. These are further candidates - a wrong one costs
      // one request that /other names, so the list is cheap to extend and
      // the reader tries them in order.
      "https://api.cartridge.gg/x/starknet/mainnet",
      "https://starknet.blockpi.network/v1/rpc/public",
      "https://starknet-mainnet.public.blastapi.io/rpc/v0_8",
      "https://free-rpc.nethermind.io/mainnet-juno/",
    ],
  },
  paradex: { aliases: ["paradex"], path: "contract" },
  radix: {
    aliases: ["xrd"],
    cmc: ["Radix"],
    path: "address",
    // The official gateway answered 500 saying its database is nine days
    // behind the ledger - it is working and refusing to serve stale data,
    // which is the honest failure. It stays first in case it catches up.
    rpcUrls: ["https://mainnet.radixdlt.com", "https://gateway.radix.live"],
  },
  aleo: { aliases: ["aleo"], cmc: ["Aleo"], path: "address" },
};

export const OTHER_CHAINS: OtherChainDef[] = GENERATED_OTHER_CHAINS.map((chain) => {
  const extra = EXTRAS[chain.key] ?? {};
  const segment = extra.path ?? "address";
  return {
    key: chain.key,
    label: chain.label,
    protocol: chain.protocol,
    rpcEnvVar: `${chain.key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_RPC_URL`,
    rpcUrls: [...(extra.rpcUrls ?? []), ...chain.rpcUrls],
    explorerAddressUrl: chain.explorer
      ? (a) => `${chain.explorer!.replace(/\/$/, "")}/${segment}/${a}`
      : (a) => a,
    aliases: [...new Set([chain.key.toLowerCase(), ...(extra.aliases ?? [])])],
    platformNames: extra.cmc,
  };
});

export function getOtherChain(key: string): OtherChainDef | undefined {
  return OTHER_CHAINS.find((c) => c.key === key);
}

export function resolveOtherChain(name: string): OtherChainDef | undefined {
  const wanted = name.trim().toLowerCase();
  return OTHER_CHAINS.find((c) => c.key.toLowerCase() === wanted || c.aliases.includes(wanted));
}
