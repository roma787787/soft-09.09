/**
 * Chains that are not EVM and so cannot be read through viem.
 *
 * The spec asked for liquidity across every chain, not across every EVM
 * chain - that narrowing came from the choice of viem, not from the task.
 * Solana alone carries 74 Hyperlane routes that lock collateral, plus
 * Wormhole's largest custody, none of which any amount of work on the EVM
 * side would ever reach.
 *
 * Kept separate from CHAINS on purpose: every EVM path leans on
 * `viemChain`, and widening that type would put an optional field in
 * forty-two places to serve one chain. Code that means "an EVM chain" keeps
 * asking getChain() and keeps getting nothing for Solana, which is the right
 * answer for it.
 */
export interface SvmChainDef {
  /** Matches Hyperlane's own chainName, so warp routes need no translation. */
  key: string;
  label: string;
  rpcEnvVar: string;
  defaultRpcUrls: string[];
  explorerAddressUrl: (address: string) => string;
  aliases: string[];
  cmcPlatformNames?: string[];
}

export const SVM_CHAINS: SvmChainDef[] = [
  {
    key: "solanamainnet",
    label: "Solana",
    rpcEnvVar: "SOLANA_RPC_URL",
    defaultRpcUrls: [
      "https://api.mainnet-beta.solana.com",
      "https://solana-rpc.publicnode.com",
      "https://rpc.ankr.com/solana",
    ],
    explorerAddressUrl: (a) => `https://solscan.io/account/${a}`,
    aliases: ["solana", "sol", "solanamainnet"],
    cmcPlatformNames: ["Solana"],
  },
];

export function getSvmChain(key: string): SvmChainDef | undefined {
  return SVM_CHAINS.find((c) => c.key === key);
}

export function resolveSvmChain(name: string): SvmChainDef | undefined {
  const wanted = name.trim().toLowerCase();
  return SVM_CHAINS.find((c) => c.key.toLowerCase() === wanted || c.aliases.includes(wanted));
}
