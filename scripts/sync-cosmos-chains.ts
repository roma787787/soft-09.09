/**
 * Regenerates the Cosmos chain table from the registries of the bridges that
 * are on Cosmos.
 *
 * Hyperlane's registry is the first source and the reason for the shape: it
 * is where the warp routes come from, so a chain a route names is always a
 * chain this table knows, and it carries each chain's REST endpoint, native
 * denom and decimals - everything needed to read a balance - so none of it
 * is transcribed.
 *
 * Wormhole is the second, and it was missing. Its SDK names a token bridge
 * on Sei that Hyperlane's registry does not describe at all, so that bridge
 * was unreadable for want of a REST endpoint rather than for any reason to
 * do with Wormhole. The endpoints for those chains come from the Cosmos
 * chain registry, which is the same kind of source: published by the chains
 * themselves, not written down here.
 *
 * Run with: npm run sync:cosmos
 */
import fs from "node:fs";
import { chains, chainToPlatform, contracts } from "@wormhole-foundation/sdk-base";

const OUT = "src/config/cosmosChains.generated.ts";

/** Where the Cosmos chains publish their own endpoints. */
const CHAIN_REGISTRY = "https://raw.githubusercontent.com/cosmos/chain-registry/master";

const meta = require("../node_modules/@hyperlane-xyz/registry/dist/chainMetadata.js");
const chainMetadata = meta.chainMetadata ?? meta.default?.chainMetadata ?? meta.default ?? meta;

interface Row {
  key: string;
  label: string;
  protocol: string;
  restUrls: string[];
  explorer?: string;
  nativeDenom?: string;
  nativeDecimals?: number;
}

const rows: Row[] = [];
for (const [key, value] of Object.entries<any>(chainMetadata)) {
  if (value?.protocol !== "cosmos" && value?.protocol !== "cosmosnative") continue;
  if (value?.isTestnet) continue;

  const restUrls = (value.restUrls ?? []).map((r: any) => r?.http).filter((u: unknown): u is string => !!u);
  if (restUrls.length === 0) continue;

  rows.push({
    key,
    label: value.displayName ?? value.name ?? key,
    protocol: value.protocol,
    restUrls,
    explorer: (value.blockExplorers ?? [])[0]?.url,
    nativeDenom: value.nativeToken?.denom,
    nativeDecimals: value.nativeToken?.decimals,
  });
}
/**
 * The CosmWasm chains Wormhole names a token bridge on.
 *
 * Their own names, lowercased, are the registry's directory names for the
 * three that exist - and the one that does not (Wormchain, the transit chain
 * with no registry entry) simply falls out, which is the right outcome: an
 * unreachable chain is not added.
 */
function wormholeCosmosChains(): string[] {
  const found: string[] = [];
  for (const chain of chains) {
    try {
      if (chainToPlatform(chain as never) !== "Cosmwasm") continue;
      if (!contracts.tokenBridge.get("Mainnet", chain as never)) continue;
    } catch {
      continue;
    }
    found.push(String(chain).toLowerCase());
  }
  return found;
}

/** A chain's own published endpoints and coin, from the Cosmos registry. */
async function fromChainRegistry(name: string): Promise<Row | undefined> {
  const [chain, assets] = await Promise.all([
    getJson(`${CHAIN_REGISTRY}/${name}/chain.json`),
    getJson(`${CHAIN_REGISTRY}/${name}/assetlist.json`),
  ]);
  if (!chain || chain.network_type !== "mainnet") return undefined;

  const restUrls: string[] = (chain.apis?.rest ?? [])
    .map((a: any) => a?.address)
    .filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://"));
  if (restUrls.length === 0) return undefined;

  // The fee token is the chain's own coin, and the asset list is where its
  // decimals are: "usei" is six, and guessing eighteen would misreport every
  // balance by twelve orders of magnitude.
  const denom: string | undefined = chain.fees?.fee_tokens?.[0]?.denom ?? chain.staking?.staking_tokens?.[0]?.denom;
  const asset = (assets?.assets ?? []).find((a: any) => a?.base === denom);
  const display = (asset?.denom_units ?? []).find((u: any) => u?.denom === asset?.display);

  return {
    key: name,
    label: chain.pretty_name ?? chain.chain_name ?? name,
    protocol: "cosmos",
    restUrls: [...new Set(restUrls)],
    explorer: (chain.explorers ?? [])[0]?.url,
    nativeDenom: denom,
    nativeDecimals: typeof display?.exponent === "number" ? display.exponent : undefined,
  };
}

async function getJson(url: string): Promise<any> {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const have = new Set(rows.map((r) => r.key));
  const wanted = wormholeCosmosChains().filter((name) => !have.has(name));

  for (const name of wanted) {
    const row = await fromChainRegistry(name);
    if (row) {
      rows.push(row);
      console.log(`[wormhole] ${name}: добавлена из реестра Cosmos, ${row.restUrls.length} узлов`);
    } else {
      // Said out loud rather than skipped in silence: a token bridge the bot
      // cannot reach is a gap in coverage, and the only place it is visible
      // is here.
      console.log(`[wormhole] ${name}: в реестре Cosmos её нет — мост туда останется непрочитанным`);
    }
  }

  write();
}

rows.sort((a, b) => a.key.localeCompare(b.key));

function write(): void {
rows.sort((a, b) => a.key.localeCompare(b.key));

const body = rows
  .map(
    (r) => `  {
    key: ${JSON.stringify(r.key)},
    label: ${JSON.stringify(r.label)},
    protocol: ${JSON.stringify(r.protocol)},
    restUrls: [${r.restUrls.map((u) => JSON.stringify(u)).join(", ")}],
    explorer: ${r.explorer ? JSON.stringify(r.explorer) : "undefined"},
    nativeDenom: ${r.nativeDenom ? JSON.stringify(r.nativeDenom) : "undefined"},
    nativeDecimals: ${r.nativeDecimals ?? "undefined"},
  },`
  )
  .join("\n");

fs.writeFileSync(
  OUT,
  `/**
 * Cosmos chains carrying Hyperlane warp routes.
 *
 * GENERATED FILE. Do not edit by hand: run \\\`npm run sync:cosmos\\\`, which
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
${body}
];
`,
  "utf8"
);

console.log(`${OUT}: ${rows.length} сетей — ${rows.map((r) => r.key).join(", ")}`);
}

// Only when run as a script. The self-test imports the parser above to cover
// it offline, and a module that fetches on import would have made every test
// run depend on the network.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
