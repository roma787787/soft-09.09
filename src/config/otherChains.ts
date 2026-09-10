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
  cmcPlatformNames?: string[];
}

const EXTRAS: Record<string, { aliases?: string[]; cmc?: string[]; path?: string }> = {
  starknet: { aliases: ["strk"], cmc: ["Starknet"], path: "contract" },
  paradex: { aliases: ["paradex"], path: "contract" },
  radix: { aliases: ["xrd"], cmc: ["Radix"], path: "address" },
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
    rpcUrls: chain.rpcUrls,
    explorerAddressUrl: chain.explorer
      ? (a) => `${chain.explorer!.replace(/\/$/, "")}/${segment}/${a}`
      : (a) => a,
    aliases: [...new Set([chain.key.toLowerCase(), ...(extra.aliases ?? [])])],
    cmcPlatformNames: extra.cmc,
  };
});

export function getOtherChain(key: string): OtherChainDef | undefined {
  return OTHER_CHAINS.find((c) => c.key === key);
}

export function resolveOtherChain(name: string): OtherChainDef | undefined {
  const wanted = name.trim().toLowerCase();
  return OTHER_CHAINS.find((c) => c.key.toLowerCase() === wanted || c.aliases.includes(wanted));
}
