import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from "viem/chains";
import type { Chain } from "viem";

/**
 * Every EVM chain the bot knows how to talk to.
 * `key` is the identifier used everywhere in commands, the DB, and config
 * (env var names, aliases, etc). Add a new chain by adding an entry here
 * plus its RPC env var default in env.ts, and (optionally) known bridge
 * addresses in protocols/addresses/*.
 */
export interface ChainDef {
  key: string;
  label: string;
  viemChain: Chain;
  rpcEnvVar: string;
  defaultRpcUrl: string;
  explorerTxUrl: (hash: string) => string;
  explorerAddressUrl: (address: string) => string;
  /** Alternate names users may type after /info or /track. */
  aliases: string[];
}

export const CHAINS: ChainDef[] = [
  {
    key: "ethereum",
    label: "Ethereum",
    viemChain: mainnet,
    rpcEnvVar: "ETHEREUM_RPC_URL",
    defaultRpcUrl: "https://eth.llamarpc.com",
    explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://etherscan.io/address/${a}`,
    aliases: ["eth", "mainnet", "ethereum"],
  },
  {
    key: "arbitrum",
    label: "Arbitrum One",
    viemChain: arbitrum,
    rpcEnvVar: "ARBITRUM_RPC_URL",
    defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerTxUrl: (h) => `https://arbiscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://arbiscan.io/address/${a}`,
    aliases: ["arb", "arbitrum", "arbitrum-one"],
  },
  {
    key: "optimism",
    label: "Optimism",
    viemChain: optimism,
    rpcEnvVar: "OPTIMISM_RPC_URL",
    defaultRpcUrl: "https://mainnet.optimism.io",
    explorerTxUrl: (h) => `https://optimistic.etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://optimistic.etherscan.io/address/${a}`,
    aliases: ["op", "optimism"],
  },
  {
    key: "base",
    label: "Base",
    viemChain: base,
    rpcEnvVar: "BASE_RPC_URL",
    defaultRpcUrl: "https://mainnet.base.org",
    explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://basescan.org/address/${a}`,
    aliases: ["base"],
  },
  {
    key: "polygon",
    label: "Polygon",
    viemChain: polygon,
    rpcEnvVar: "POLYGON_RPC_URL",
    defaultRpcUrl: "https://polygon-rpc.com",
    explorerTxUrl: (h) => `https://polygonscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://polygonscan.com/address/${a}`,
    aliases: ["polygon", "matic", "pol"],
  },
  {
    key: "bsc",
    label: "BNB Chain",
    viemChain: bsc,
    rpcEnvVar: "BSC_RPC_URL",
    defaultRpcUrl: "https://bsc-dataseed.binance.org",
    explorerTxUrl: (h) => `https://bscscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://bscscan.com/address/${a}`,
    aliases: ["bsc", "bnb", "binance"],
  },
  {
    key: "avalanche",
    label: "Avalanche C-Chain",
    viemChain: avalanche,
    rpcEnvVar: "AVALANCHE_RPC_URL",
    defaultRpcUrl: "https://api.avax.network/ext/bc/C/C",
    explorerTxUrl: (h) => `https://snowtrace.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://snowtrace.io/address/${a}`,
    aliases: ["avax", "avalanche"],
  },
];

export type ChainKey = (typeof CHAINS)[number]["key"];

const byKey = new Map(CHAINS.map((c) => [c.key, c]));
const byAlias = new Map<string, ChainDef>();
for (const c of CHAINS) {
  for (const alias of c.aliases) byAlias.set(alias.toLowerCase(), c);
}

export function getChain(key: string): ChainDef | undefined {
  return byKey.get(key);
}

export function resolveChain(input: string): ChainDef | undefined {
  return byAlias.get(input.trim().toLowerCase());
}

export function allChainKeys(): string[] {
  return CHAINS.map((c) => c.key);
}
