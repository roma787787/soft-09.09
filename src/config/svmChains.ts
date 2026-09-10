import { GENERATED_SVM_CHAINS } from "./svmChains.generated";

/**
 * Chains that are not EVM and so cannot be read through viem.
 *
 * The spec asked for liquidity across every chain, not across every EVM
 * chain - that narrowing came from the choice of viem, not from the task.
 * Arbitrage in particular happens on the small chains, which is exactly
 * where a bridge running dry is most likely and least visible.
 *
 * Kept separate from CHAINS on purpose: every EVM path leans on
 * `viemChain`, and widening that type would put an optional field in
 * forty-two places to serve chains that have no chain id at all. Code that
 * means "an EVM chain" keeps asking getChain() and keeps getting nothing
 * here, which is the right answer for it.
 */
export interface SvmChainDef {
  /** Hyperlane's own chainName, so warp routes need no translation. */
  key: string;
  label: string;
  rpcEnvVar: string;
  defaultRpcUrls: string[];
  explorerAddressUrl: (address: string) => string;
  aliases: string[];
  cmcPlatformNames?: string[];
}

/**
 * What the registry does not carry: the names a person might type, and the
 * spellings CoinMarketCap uses. Everything else - the chain list, its
 * endpoints and its explorer - is generated from Hyperlane's registry.
 */
const EXTRAS: Record<string, { aliases?: string[]; cmc?: string[]; rpcUrls?: string[]; env?: string }> = {
  solanamainnet: {
    aliases: ["solana", "sol"],
    cmc: ["Solana"],
    // SOLANA_RPC_URL rather than the derived SOLANAMAINNET_RPC_URL: this is
    // the variable a person would think to set.
    env: "SOLANA_RPC_URL",
    // The public endpoint refuses datacenter IPs often enough that a
    // fallback is not a luxury: a chain that drops out of a report reads as
    // "no liquidity here", which is the opposite of what it means.
    rpcUrls: ["https://solana-rpc.publicnode.com", "https://rpc.ankr.com/solana"],
  },
  eclipsemainnet: { aliases: ["eclipse"], cmc: ["Eclipse"] },
  sonicsvm: { aliases: ["sonicsvm", "sonicsolana"], cmc: ["Sonic SVM"] },
  soon: { aliases: ["soon"] },
  svmbnb: { aliases: ["svmbnb"] },
  solaxy: { aliases: ["solaxy"] },
  nara: { aliases: ["nara"] },
};

/**
 * Explorers differ in what they will accept appended to them. A base that
 * already carries a query string cannot take a path, so those link to the
 * explorer itself rather than to a deep link that resolves to nothing.
 */
function explorerBuilder(explorer: string | undefined): (address: string) => string {
  if (!explorer) return (a) => a;
  if (explorer.includes("?")) return () => explorer;
  return (a) => `${explorer.replace(/\/$/, "")}/account/${a}`;
}

export const SVM_CHAINS: SvmChainDef[] = GENERATED_SVM_CHAINS.map((chain) => {
  const extra = EXTRAS[chain.key] ?? {};
  return {
    key: chain.key,
    label: chain.label,
    rpcEnvVar: extra.env ?? `${chain.key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_RPC_URL`,
    defaultRpcUrls: [...chain.rpcUrls, ...(extra.rpcUrls ?? [])],
    explorerAddressUrl: explorerBuilder(chain.explorer),
    aliases: [...new Set([chain.key.toLowerCase(), ...(extra.aliases ?? [])])],
    cmcPlatformNames: extra.cmc,
  };
});

export function getSvmChain(key: string): SvmChainDef | undefined {
  return SVM_CHAINS.find((c) => c.key === key);
}

export function resolveSvmChain(name: string): SvmChainDef | undefined {
  const wanted = name.trim().toLowerCase();
  return SVM_CHAINS.find((c) => c.key.toLowerCase() === wanted || c.aliases.includes(wanted));
}
