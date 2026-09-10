/**
 * Sealevel chains - Solana and the rollups that run its VM.
 *
 * GENERATED FILE. Do not edit by hand: run \`npm run sync:svm\`, which reads
 * Hyperlane's registry. Keyed by the registry's own chain names, so a warp
 * route naming a chain always finds it here.
 */
export interface GeneratedSvmChain {
  key: string;
  label: string;
  rpcUrls: string[];
  explorer?: string;
}

export const GENERATED_SVM_CHAINS: GeneratedSvmChain[] = [
  {
    key: "eclipsemainnet",
    label: "Eclipse",
    rpcUrls: ["https://mainnetbeta-rpc.eclipse.xyz"],
    explorer: "https://eclipsescan.xyz",
  },
  {
    key: "nara",
    label: "Nara",
    rpcUrls: ["https://mainnet-api.nara.build/"],
    explorer: "https://explorer.nara.build",
  },
  {
    key: "solanamainnet",
    label: "Solana",
    rpcUrls: ["https://api.mainnet-beta.solana.com"],
    explorer: "https://solscan.io",
  },
  {
    key: "solaxy",
    label: "Solaxy",
    rpcUrls: ["https://mainnet.rpc.solaxy.io"],
    explorer: "https://explorer.solaxy.io",
  },
  {
    key: "sonicsvm",
    label: "Sonic SVM",
    rpcUrls: ["https://api.mainnet-alpha.sonic.game"],
    explorer: "https://explorer.sonic.game/?cluster=custom&customUrl=https%3A%2F%2Fapi.mainnet-alpha.sonic.game",
  },
  {
    key: "soon",
    label: "SOON",
    rpcUrls: ["https://rpc.mainnet.soo.network/rpc"],
    explorer: "https://explorer.soo.network",
  },
  {
    key: "svmbnb",
    label: "svmBNB",
    rpcUrls: ["https://rpc.svmbnbmainnet.soo.network/rpc"],
    explorer: "https://explorer.svmbnbmainnet.soo.network",
  },
];
