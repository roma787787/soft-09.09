import { GENERATED_COSMOS_CHAINS } from "./cosmosChains.generated";

/**
 * Cosmos chains the bot can read balances on.
 *
 * These need no address derivation at all, unlike Sealevel: a warp route on
 * a CosmWasm chain is a contract with a bech32 address, and what it holds is
 * an ordinary bank balance. One HTTP GET answers it.
 */
export interface CosmosChainDef {
  key: string;
  label: string;
  protocol: string;
  rpcEnvVar: string;
  restUrls: string[];
  explorerAddressUrl: (address: string) => string;
  aliases: string[];
  cmcPlatformNames?: string[];
  nativeDenom?: string;
  nativeDecimals?: number;
}

/** Names a person might type, and CoinMarketCap's spellings. */
const EXTRAS: Record<string, { aliases?: string[]; cmc?: string[] }> = {
  celestia: { aliases: ["tia"], cmc: ["Celestia"] },
  injective: { aliases: ["inj"], cmc: ["Injective"] },
  neutron: { aliases: ["ntrn"], cmc: ["Neutron"] },
  osmosis: { aliases: ["osmo"], cmc: ["Osmosis"] },
  stride: { aliases: ["strd"] },
  terraclassic: { aliases: ["lunc", "terra"], cmc: ["Terra Classic"] },
  cosmoshub: { aliases: ["cosmos", "atom"], cmc: ["Cosmos"] },
  noble: { aliases: ["noble"] },
  dymension: { aliases: ["dym"], cmc: ["Dymension"] },
  kyve: { aliases: ["kyve"] },
  milkyway: { aliases: ["milk"] },
};

function explorerBuilder(explorer: string | undefined): (address: string) => string {
  if (!explorer) return (a) => a;
  if (explorer.includes("?")) return () => explorer;
  return (a) => `${explorer.replace(/\/$/, "")}/account/${a}`;
}

export const COSMOS_CHAINS: CosmosChainDef[] = GENERATED_COSMOS_CHAINS.map((chain) => {
  const extra = EXTRAS[chain.key] ?? {};
  return {
    key: chain.key,
    label: chain.label,
    protocol: chain.protocol,
    rpcEnvVar: `${chain.key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_REST_URL`,
    restUrls: chain.restUrls,
    explorerAddressUrl: explorerBuilder(chain.explorer),
    aliases: [...new Set([chain.key.toLowerCase(), ...(extra.aliases ?? [])])],
    cmcPlatformNames: extra.cmc,
    nativeDenom: chain.nativeDenom,
    nativeDecimals: chain.nativeDecimals,
  };
});

export function getCosmosChain(key: string): CosmosChainDef | undefined {
  return COSMOS_CHAINS.find((c) => c.key === key);
}

export function resolveCosmosChain(name: string): CosmosChainDef | undefined {
  const wanted = name.trim().toLowerCase();
  return COSMOS_CHAINS.find((c) => c.key.toLowerCase() === wanted || c.aliases.includes(wanted));
}
