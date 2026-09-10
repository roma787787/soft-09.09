/**
 * Starknet, Radix and Aleo chains carrying Hyperlane warp routes.
 *
 * GENERATED FILE. Do not edit by hand: run \`npm run sync:other\`.
 */
export interface GeneratedOtherChain {
  key: string;
  label: string;
  protocol: string;
  rpcUrls: string[];
  explorer?: string;
}

export const GENERATED_OTHER_CHAINS: GeneratedOtherChain[] = [
  {
    key: "aleo",
    label: "Aleo",
    protocol: "aleo",
    rpcUrls: ["https://edge.provable.com/api/v2", "https://api.explorer.provable.com/v2"],
    explorer: "https://explorer.provable.com",
  },
  {
    key: "paradex",
    label: "Paradex",
    protocol: "starknet",
    rpcUrls: ["https://rpc.api.prod.paradex.trade/rpc/v0_9"],
    explorer: "https://voyager.prod.paradex.trade",
  },
  {
    key: "radix",
    label: "Radix",
    protocol: "radix",
    rpcUrls: ["https://radix.rpc.grove.city/v1/326002fc"],
    explorer: "https://dashboard.radixdlt.com",
  },
  {
    key: "starknet",
    label: "Starknet",
    protocol: "starknet",
    rpcUrls: ["https://rpc.starknet.lava.build:443/rpc/v0_9"],
    explorer: "https://voyager.online",
  },
];
