/**
 * Cosmos chains carrying Hyperlane warp routes.
 *
 * GENERATED FILE. Do not edit by hand: run \`npm run sync:cosmos\`, which
 * reads Hyperlane's registry.
 */
export interface GeneratedCosmosChain {
  key: string;
  label: string;
  /** "cosmos" for CosmWasm routes, "cosmosnative" for the Hyperlane module. */
  protocol: string;
  restUrls: string[];
  explorer?: string;
  nativeDenom?: string;
  nativeDecimals?: number;
}

export const GENERATED_COSMOS_CHAINS: GeneratedCosmosChain[] = [
  {
    key: "celestia",
    label: "Celestia",
    protocol: "cosmosnative",
    restUrls: ["https://celestia-rest.publicnode.com"],
    explorer: "https://celenium.io",
    nativeDenom: "utia",
    nativeDecimals: 6,
  },
  {
    key: "cosmoshub",
    label: "Cosmos Hub",
    protocol: "cosmos",
    restUrls: ["https://cosmos-lcd.quickapi.com:443", "https://rest.cosmoshub.goldenratiostaking.net"],
    explorer: "https://www.mintscan.io/cosmos",
    nativeDenom: "uatom",
    nativeDecimals: 6,
  },
  {
    key: "dymension",
    label: "Dymension",
    protocol: "cosmosnative",
    restUrls: ["https://api-dymension.mzonder.com:443"],
    explorer: undefined,
    nativeDenom: "adym",
    nativeDecimals: 18,
  },
  {
    key: "injective",
    label: "Injective",
    protocol: "cosmos",
    restUrls: ["https://sentry.lcd.injective.network:443"],
    explorer: "https://www.mintscan.io/injective",
    nativeDenom: "inj",
    nativeDecimals: 18,
  },
  {
    key: "kyve",
    label: "KYVE",
    protocol: "cosmosnative",
    restUrls: ["https://api.kyve.network"],
    explorer: "https://explorer.kyve.network/kyve",
    nativeDenom: "ukyve",
    nativeDecimals: 6,
  },
  {
    key: "milkyway",
    label: "MilkyWay",
    protocol: "cosmosnative",
    restUrls: ["https://lcd.mainnet.milkyway.zone/"],
    explorer: undefined,
    nativeDenom: "umilk",
    nativeDecimals: 6,
  },
  {
    key: "neutron",
    label: "Neutron",
    protocol: "cosmos",
    restUrls: ["https://rest-lb.neutron.org"],
    explorer: "https://www.mintscan.io/neutron",
    nativeDenom: "untrn",
    nativeDecimals: 6,
  },
  {
    key: "noble",
    label: "Noble",
    protocol: "cosmosnative",
    restUrls: ["https://noble-api.polkachu.com:443", "https://api.noble.xyz:443"],
    explorer: "https://www.mintscan.io/noble",
    nativeDenom: "uusdn",
    nativeDecimals: 6,
  },
  {
    key: "osmosis",
    label: "Osmosis",
    protocol: "cosmos",
    restUrls: ["https://osmosis-rest.publicnode.com"],
    explorer: "https://www.mintscan.io/osmosis",
    nativeDenom: "uosmo",
    nativeDecimals: 6,
  },
  {
    key: "sei",
    label: "Sei",
    protocol: "cosmos",
    restUrls: ["https://rest.sei-apis.com", "https://rest.lavenderfive.com:443/sei", "https://sei-api.polkachu.com", "https://api-sei.stingray.plus", "https://lcd-sei.whispernode.com:443", "https://sei.api.kjnodes.com", "https://sei-rest.publicnode.com", "https://sei.api.pocket.network"],
    explorer: "https://seitrace.com",
    nativeDenom: "usei",
    nativeDecimals: 6,
  },
  {
    key: "stride",
    label: "Stride",
    protocol: "cosmos",
    restUrls: ["https://stride-api.polkachu.com"],
    explorer: "https://www.mintscan.io/stride",
    nativeDenom: "ustrd",
    nativeDecimals: 6,
  },
  {
    key: "terraclassic",
    label: "Terra Classic",
    protocol: "cosmos",
    restUrls: ["https://terra-classic-lcd.publicnode.com", "https://lcd.terraclassic.community", "https://terra-classic-lcd.polkachu.com"],
    explorer: "https://finder.terraclassic.community",
    nativeDenom: "uluna",
    nativeDecimals: 6,
  },
];
