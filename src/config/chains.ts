import {
  arbitrum,
  aurora,
  avalanche,
  base,
  berachain,
  blast,
  bob,
  boba,
  bsc,
  celo,
  cronoszkEVM,
  fraxtal,
  gnosis,
  hyperEvm,
  ink,
  katana,
  linea,
  lisk,
  mainnet,
  mantle,
  metalL2,
  mode,
  monad,
  moonbeam,
  optimism,
  plasma,
  plumeMainnet,
  polygon,
  ronin,
  scroll,
  sei,
  soneium,
  sonic,
  superseed,
  swellchain,
  taiko,
  unichain,
  worldchain,
  xLayer,
  zeroGMainnet,
  zircuit,
  zkSync,
} from "viem/chains";
import type { Chain } from "viem";
import { SVM_CHAINS, resolveSvmChain } from "./svmChains";
import { COSMOS_CHAINS, resolveCosmosChain } from "./cosmosChains";

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
  {
    key: "katana",
    label: "Katana",
    viemChain: katana,
    rpcEnvVar: "KATANA_RPC_URL",
    defaultRpcUrls: ["https://rpc.katana.network"],
    explorerTxUrl: (h) => `https://katanascan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://katanascan.com/address/${a}`,
    aliases: ["katana"],
  },
  {
    key: "hyperevm",
    label: "HyperEVM",
    viemChain: hyperEvm,
    rpcEnvVar: "HYPEREVM_RPC_URL",
    defaultRpcUrls: ["https://rpc.hyperliquid.xyz/evm"],
    explorerTxUrl: (h) => `https://hyperevmscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://hyperevmscan.io/address/${a}`,
    aliases: ["hyperevm", "hyperliquid", "hype"],
    cmcPlatformNames: ["HyperEVM", "Hyperliquid"],
  },
  {
    key: "monad",
    label: "Monad",
    viemChain: monad,
    rpcEnvVar: "MONAD_RPC_URL",
    defaultRpcUrls: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz"],
    explorerTxUrl: (h) => `https://monadscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://monadscan.com/address/${a}`,
    aliases: ["monad"],
    cmcPlatformNames: ["Monad"],
  },
  {
    key: "plasma",
    label: "Plasma",
    viemChain: plasma,
    rpcEnvVar: "PLASMA_RPC_URL",
    defaultRpcUrls: ["https://rpc.plasma.to"],
    explorerTxUrl: (h) => `https://plasmascan.to/tx/${h}`,
    explorerAddressUrl: (a) => `https://plasmascan.to/address/${a}`,
    aliases: ["plasma"],
  },
  {
    key: "sei",
    label: "Sei Network",
    viemChain: sei,
    rpcEnvVar: "SEI_RPC_URL",
    defaultRpcUrls: ["https://evm-rpc.sei-apis.com/"],
    explorerTxUrl: (h) => `https://seiscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://seiscan.io/address/${a}`,
    aliases: ["sei"],
    cmcPlatformNames: ["Sei v2", "Sei"],
  },
  {
    key: "swell",
    label: "Swellchain",
    viemChain: swellchain,
    rpcEnvVar: "SWELL_RPC_URL",
    defaultRpcUrls: [
      "https://swell-mainnet.alt.technology",
      "https://swell.drpc.org",
      "https://rpc.ankr.com/swell",
    ],
    explorerTxUrl: (h) => `https://explorer.swellnetwork.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.swellnetwork.io/address/${a}`,
    aliases: ["swell"],
  },
  {
    key: "superseed",
    label: "Superseed",
    viemChain: superseed,
    rpcEnvVar: "SUPERSEED_RPC_URL",
    defaultRpcUrls: ["https://mainnet.superseed.xyz"],
    explorerTxUrl: (h) => `https://explorer.superseed.xyz/tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.superseed.xyz/address/${a}`,
    aliases: ["superseed"],
  },
  {
    key: "fraxtal",
    label: "Fraxtal",
    viemChain: fraxtal,
    rpcEnvVar: "FRAXTAL_RPC_URL",
    defaultRpcUrls: ["https://rpc.frax.com"],
    explorerTxUrl: (h) => `https://fraxscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://fraxscan.com/address/${a}`,
    aliases: ["fraxtal"],
    cmcPlatformNames: ["Fraxtal"],
  },
  {
    key: "zircuit",
    label: "Zircuit Mainnet",
    viemChain: zircuit,
    rpcEnvVar: "ZIRCUIT_RPC_URL",
    defaultRpcUrls: ["https://mainnet.zircuit.com"],
    explorerTxUrl: (h) => `https://explorer.zircuit.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.zircuit.com/address/${a}`,
    aliases: ["zircuit"],
  },
  {
    key: "soneium",
    label: "Soneium Mainnet",
    viemChain: soneium,
    rpcEnvVar: "SONEIUM_RPC_URL",
    defaultRpcUrls: ["https://rpc.soneium.org"],
    explorerTxUrl: (h) => `https://soneium.blockscout.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://soneium.blockscout.com/address/${a}`,
    aliases: ["soneium"],
    cmcPlatformNames: ["Soneium"],
  },
  {
    key: "mantle",
    label: "Mantle",
    viemChain: mantle,
    rpcEnvVar: "MANTLE_RPC_URL",
    defaultRpcUrls: ["https://rpc.mantle.xyz"],
    explorerTxUrl: (h) => `https://mantlescan.xyz//tx/${h}`,
    explorerAddressUrl: (a) => `https://mantlescan.xyz//address/${a}`,
    aliases: ["mantle"],
    cmcPlatformNames: ["Mantle"],
  },
  {
    key: "taiko",
    label: "Taiko Mainnet",
    viemChain: taiko,
    rpcEnvVar: "TAIKO_RPC_URL",
    defaultRpcUrls: ["https://rpc.mainnet.taiko.xyz"],
    explorerTxUrl: (h) => `https://taikoscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://taikoscan.io/address/${a}`,
    aliases: ["taiko"],
    cmcPlatformNames: ["Taiko"],
  },
  {
    key: "xlayer",
    label: "X Layer Mainnet",
    viemChain: xLayer,
    rpcEnvVar: "XLAYER_RPC_URL",
    defaultRpcUrls: ["https://xlayerrpc.okx.com"],
    explorerTxUrl: (h) => `https://www.oklink.com/xlayer/tx/${h}`,
    explorerAddressUrl: (a) => `https://www.oklink.com/xlayer/address/${a}`,
    aliases: ["xlayer", "okx"],
  },
  {
    key: "plume",
    label: "Plume",
    viemChain: plumeMainnet,
    rpcEnvVar: "PLUME_RPC_URL",
    defaultRpcUrls: ["https://rpc.plume.org"],
    explorerTxUrl: (h) => `https://explorer.plume.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.plume.org/address/${a}`,
    aliases: ["plume"],
    cmcPlatformNames: ["Plume"],
  },
  {
    key: "sonic",
    label: "Sonic",
    viemChain: sonic,
    rpcEnvVar: "SONIC_RPC_URL",
    defaultRpcUrls: ["https://rpc.soniclabs.com"],
    explorerTxUrl: (h) => `https://sonicscan.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://sonicscan.org/address/${a}`,
    aliases: ["sonic"],
    cmcPlatformNames: ["Sonic", "Fantom"],
  },
  {
    key: "scroll",
    label: "Scroll",
    viemChain: scroll,
    rpcEnvVar: "SCROLL_RPC_URL",
    defaultRpcUrls: ["https://rpc.scroll.io"],
    explorerTxUrl: (h) => `https://scrollscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://scrollscan.com/address/${a}`,
    aliases: ["scroll"],
    cmcPlatformNames: ["Scroll"],
  },
  {
    key: "bob",
    label: "BOB",
    viemChain: bob,
    rpcEnvVar: "BOB_RPC_URL",
    defaultRpcUrls: ["https://rpc.gobob.xyz"],
    explorerTxUrl: (h) => `https://explorer.gobob.xyz/tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.gobob.xyz/address/${a}`,
    aliases: ["bob", "buildonbitcoin"],
  },
  {
    key: "lisk",
    label: "Lisk",
    viemChain: lisk,
    rpcEnvVar: "LISK_RPC_URL",
    defaultRpcUrls: ["https://rpc.api.lisk.com"],
    explorerTxUrl: (h) => `https://blockscout.lisk.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://blockscout.lisk.com/address/${a}`,
    aliases: ["lisk"],
    cmcPlatformNames: ["Lisk"],
  },
  {
    key: "metal",
    label: "Metal L2",
    viemChain: metalL2,
    rpcEnvVar: "METAL_RPC_URL",
    defaultRpcUrls: ["https://rpc.metall2.com"],
    explorerTxUrl: (h) => `https://explorer.metall2.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.metall2.com/address/${a}`,
    aliases: ["metal"],
  },
  {
    key: "gnosis",
    label: "Gnosis",
    viemChain: gnosis,
    rpcEnvVar: "GNOSIS_RPC_URL",
    defaultRpcUrls: ["https://rpc.gnosischain.com"],
    explorerTxUrl: (h) => `https://gnosisscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://gnosisscan.io/address/${a}`,
    aliases: ["gnosis", "xdai"],
    cmcPlatformNames: ["Gnosis Chain", "Gnosis", "xDai"],
  },
  {
    key: "zerogravity",
    label: "0G Mainnet",
    viemChain: zeroGMainnet,
    rpcEnvVar: "ZEROGRAVITY_RPC_URL",
    defaultRpcUrls: ["https://evmrpc.0g.ai"],
    explorerTxUrl: (h) => `https://chainscan.0g.ai/tx/${h}`,
    explorerAddressUrl: (a) => `https://chainscan.0g.ai/address/${a}`,
    aliases: ["zerogravity", "0g"],
  },
  {
    key: "zksync",
    label: "ZKsync Era",
    viemChain: zkSync,
    rpcEnvVar: "ZKSYNC_RPC_URL",
    defaultRpcUrls: ["https://mainnet.era.zksync.io"],
    explorerTxUrl: (h) => `https://explorer.zksync.io//tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.zksync.io//address/${a}`,
    aliases: ["zksync", "zksyncera", "era"],
    cmcPlatformNames: ["zkSync Era", "zkSync"],
  },
  {
    key: "cronoszkevm",
    label: "Cronos zkEVM Mainnet",
    viemChain: cronoszkEVM,
    rpcEnvVar: "CRONOSZKEVM_RPC_URL",
    defaultRpcUrls: ["https://mainnet.zkevm.cronos.org"],
    explorerTxUrl: (h) => `https://explorer.zkevm.cronos.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://explorer.zkevm.cronos.org/address/${a}`,
    aliases: ["cronoszkevm"],
  },
  {
    key: "moonbeam",
    label: "Moonbeam",
    viemChain: moonbeam,
    rpcEnvVar: "MOONBEAM_RPC_URL",
    defaultRpcUrls: [
      "https://rpc.api.moonbeam.network",
      "https://moonbeam-rpc.publicnode.com",
      "https://moonbeam.public.blastapi.io",
      "https://moonbeam.drpc.org",
    ],
    explorerTxUrl: (h) => `https://moonscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://moonscan.io/address/${a}`,
    aliases: ["moonbeam"],
    cmcPlatformNames: ["Moonbeam"],
  },
  {
    key: "aurora",
    label: "Aurora",
    viemChain: aurora,
    rpcEnvVar: "AURORA_RPC_URL",
    defaultRpcUrls: ["https://mainnet.aurora.dev"],
    explorerTxUrl: (h) => `https://aurorascan.dev/tx/${h}`,
    explorerAddressUrl: (a) => `https://aurorascan.dev/address/${a}`,
    aliases: ["aurora"],
    cmcPlatformNames: ["Aurora"],
  },
  {
    key: "ronin",
    label: "Ronin",
    viemChain: ronin,
    rpcEnvVar: "RONIN_RPC_URL",
    defaultRpcUrls: ["https://api.roninchain.com/rpc"],
    explorerTxUrl: (h) => `https://app.roninchain.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://app.roninchain.com/address/${a}`,
    aliases: ["ronin"],
    cmcPlatformNames: ["Ronin"],
  },
  {
    key: "boba",
    label: "Boba Network",
    viemChain: boba,
    rpcEnvVar: "BOBA_RPC_URL",
    defaultRpcUrls: ["https://mainnet.boba.network"],
    explorerTxUrl: (h) => `https://bobascan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://bobascan.com/address/${a}`,
    aliases: ["boba"],
    cmcPlatformNames: ["Boba Network"],
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


/**
 * Label and explorer for any chain the bot reads, EVM or not.
 *
 * getChain() deliberately answers only for EVM chains, because everything
 * that calls it needs `viemChain`. The report needs neither - it needs a
 * name and a link - so it asks this instead, and a Solana row renders like
 * any other rather than falling back to a bare chain key.
 */
export function chainMeta(chainKey: string): { label: string; explorerAddressUrl: (a: string) => string } | undefined {
  const evm = CHAINS.find((c) => c.key === chainKey);
  if (evm) return { label: evm.label, explorerAddressUrl: evm.explorerAddressUrl };

  const svm = SVM_CHAINS.find((c) => c.key === chainKey);
  if (svm) return { label: svm.label, explorerAddressUrl: svm.explorerAddressUrl };

  const cosmos = COSMOS_CHAINS.find((c) => c.key === chainKey);
  if (cosmos) return { label: cosmos.label, explorerAddressUrl: cosmos.explorerAddressUrl };

  return undefined;
}


/**
 * Resolves a chain the user typed, EVM or not.
 *
 * resolveChain() answers only for EVM chains because its callers need
 * `viemChain`. But a person typing "solana" after a ticker is naming a chain
 * the bot now reads, and telling them it is not connected - while the report
 * shows Solana rows two lines above - is simply wrong.
 */
export function resolveAnyChain(name: string): { key: string; label: string } | undefined {
  const evm = resolveChain(name);
  if (evm) return { key: evm.key, label: evm.label };

  const svm = resolveSvmChain(name);
  if (svm) return { key: svm.key, label: svm.label };

  const cosmos = resolveCosmosChain(name);
  if (cosmos) return { key: cosmos.key, label: cosmos.label };

  return undefined;
}
