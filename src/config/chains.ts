import {
  arbitrum,
  avalanche,
  base,
  berachain,
  blast,
  bsc,
  celo,
  ink,
  linea,
  mainnet,
  mode,
  optimism,
  polygon,
  unichain,
  worldchain,
} from "viem/chains";
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
  /**
   * Public endpoints tried in order when no custom RPC is configured.
   * More than one because a single free endpoint routinely refuses
   * requests coming from a datacenter IP, which is exactly where this bot
   * runs; viem's fallback transport moves on to the next one.
   */
  defaultRpcUrls: string[];
  explorerTxUrl: (hash: string) => string;
  explorerAddressUrl: (address: string) => string;
  /** Alternate names users may type after /info or /track. */
  aliases: string[];
  /** How CoinMarketCap spells this network in its platform field. */
  cmcPlatformNames?: string[];
}

export const CHAINS: ChainDef[] = [
  {
    key: "ethereum",
    label: "Ethereum",
    viemChain: mainnet,
    rpcEnvVar: "ETHEREUM_RPC_URL",
    defaultRpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com",
      "https://rpc.ankr.com/eth",
      "https://cloudflare-eth.com",
    ],
    explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://etherscan.io/address/${a}`,
    aliases: ["eth", "mainnet", "ethereum"],
    cmcPlatformNames: ["Ethereum", "ERC20"],
  },
  {
    key: "arbitrum",
    label: "Arbitrum One",
    viemChain: arbitrum,
    rpcEnvVar: "ARBITRUM_RPC_URL",
    defaultRpcUrls: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
      "https://rpc.ankr.com/arbitrum",
    ],
    explorerTxUrl: (h) => `https://arbiscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://arbiscan.io/address/${a}`,
    aliases: ["arb", "arbitrum", "arbitrum-one"],
    cmcPlatformNames: ["Arbitrum", "Arbitrum One"],
  },
  {
    key: "optimism",
    label: "Optimism",
    viemChain: optimism,
    rpcEnvVar: "OPTIMISM_RPC_URL",
    defaultRpcUrls: [
      "https://mainnet.optimism.io",
      "https://optimism-rpc.publicnode.com",
      "https://rpc.ankr.com/optimism",
    ],
    explorerTxUrl: (h) => `https://optimistic.etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://optimistic.etherscan.io/address/${a}`,
    aliases: ["op", "optimism"],
    cmcPlatformNames: ["Optimism", "OP Mainnet"],
  },
  {
    key: "base",
    label: "Base",
    viemChain: base,
    rpcEnvVar: "BASE_RPC_URL",
    defaultRpcUrls: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
    ],
    explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://basescan.org/address/${a}`,
    aliases: ["base"],
    cmcPlatformNames: ["Base"],
  },
  {
    key: "polygon",
    label: "Polygon",
    viemChain: polygon,
    rpcEnvVar: "POLYGON_RPC_URL",
    defaultRpcUrls: [
      "https://polygon-rpc.com",
      "https://polygon-bor-rpc.publicnode.com",
      "https://rpc.ankr.com/polygon",
    ],
    explorerTxUrl: (h) => `https://polygonscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://polygonscan.com/address/${a}`,
    aliases: ["polygon", "matic", "pol"],
    cmcPlatformNames: ["Polygon", "Polygon PoS", "Polygon Ecosystem"],
  },
  {
    key: "bsc",
    label: "BNB Chain",
    viemChain: bsc,
    rpcEnvVar: "BSC_RPC_URL",
    defaultRpcUrls: [
      "https://bsc-dataseed.binance.org",
      "https://bsc-rpc.publicnode.com",
      "https://rpc.ankr.com/bsc",
    ],
    explorerTxUrl: (h) => `https://bscscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://bscscan.com/address/${a}`,
    aliases: ["bsc", "bnb", "binance"],
    cmcPlatformNames: ["BNB Smart Chain (BEP20)", "BNB Smart Chain", "Binance Smart Chain", "BNB"],
  },
  {
    key: "avalanche",
    label: "Avalanche C-Chain",
    viemChain: avalanche,
    rpcEnvVar: "AVALANCHE_RPC_URL",
    defaultRpcUrls: [
      "https://api.avax.network/ext/bc/C/rpc",
      "https://avalanche-c-chain-rpc.publicnode.com",
    ],
    explorerTxUrl: (h) => `https://snowtrace.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://snowtrace.io/address/${a}`,
    aliases: ["avax", "avalanche"],
    cmcPlatformNames: ["Avalanche C-Chain", "Avalanche"],
  },
  // --- added later; RPC and explorer come from viem's own chain metadata
  // rather than being retyped here, and the `key` must match the chain name
  // Hyperlane's warp-route registry uses, since that is what matches routes.
  {
    key: "unichain",
    label: "Unichain",
    viemChain: unichain,
    rpcEnvVar: "UNICHAIN_RPC_URL",
    defaultRpcUrls: ["https://mainnet.unichain.org"],
    explorerTxUrl: (h) => `https://uniscan.xyz/tx/${h}`,
    explorerAddressUrl: (a) => `https://uniscan.xyz/address/${a}`,
    aliases: ["unichain", "uni"],
    cmcPlatformNames: ["Unichain"],
  },
  {
    key: "ink",
    label: "Ink",
    viemChain: ink,
    rpcEnvVar: "INK_RPC_URL",
    defaultRpcUrls: ["https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com"],
    explorerTxUrl: (h) => `https://explorer.inkonchain.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.inkonchain.com/address/${a}`,
    aliases: ["ink"],
    cmcPlatformNames: ["Ink"],
  },
  {
    key: "linea",
    label: "Linea",
    viemChain: linea,
    rpcEnvVar: "LINEA_RPC_URL",
    defaultRpcUrls: ["https://rpc.linea.build"],
    explorerTxUrl: (h) => `https://lineascan.build/tx/${h}`,
    explorerAddressUrl: (a) => `https://lineascan.build/address/${a}`,
    aliases: ["linea"],
    cmcPlatformNames: ["Linea"],
  },
  {
    key: "worldchain",
    label: "World Chain",
    viemChain: worldchain,
    rpcEnvVar: "WORLDCHAIN_RPC_URL",
    defaultRpcUrls: ["https://worldchain-mainnet.g.alchemy.com/public"],
    explorerTxUrl: (h) => `https://worldscan.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://worldscan.org/address/${a}`,
    aliases: ["worldchain", "world"],
    cmcPlatformNames: ["World Chain", "Worldchain"],
  },
  {
    key: "mode",
    label: "Mode",
    viemChain: mode,
    rpcEnvVar: "MODE_RPC_URL",
    defaultRpcUrls: ["https://mainnet.mode.network"],
    explorerTxUrl: (h) => `https://modescan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://modescan.io/address/${a}`,
    aliases: ["mode"],
    cmcPlatformNames: ["Mode"],
  },
  {
    key: "berachain",
    label: "Berachain",
    viemChain: berachain,
    rpcEnvVar: "BERACHAIN_RPC_URL",
    defaultRpcUrls: ["https://rpc.berachain.com"],
    explorerTxUrl: (h) => `https://berascan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://berascan.com/address/${a}`,
    aliases: ["berachain", "bera"],
    cmcPlatformNames: ["Berachain"],
  },
  {
    key: "blast",
    label: "Blast",
    viemChain: blast,
    rpcEnvVar: "BLAST_RPC_URL",
    defaultRpcUrls: ["https://rpc.blast.io"],
    explorerTxUrl: (h) => `https://blastscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://blastscan.io/address/${a}`,
    aliases: ["blast"],
    cmcPlatformNames: ["Blast"],
  },
  {
    key: "celo",
    label: "Celo",
    viemChain: celo,
    rpcEnvVar: "CELO_RPC_URL",
    defaultRpcUrls: ["https://forno.celo.org"],
    explorerTxUrl: (h) => `https://celoscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://celoscan.io/address/${a}`,
    aliases: ["celo"],
    cmcPlatformNames: ["Celo"],
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
