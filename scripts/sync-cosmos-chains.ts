/**
 * Regenerates the Cosmos chain table from Hyperlane's registry.
 *
 * Same reasoning as the Sealevel table: the registry is the source the warp
 * routes come from, so a chain a route names is always a chain this table
 * knows. It also carries each chain's REST endpoint, its native denom and
 * that denom's decimals - everything needed to read a balance - so none of
 * it is transcribed.
 *
 * Run with: npm run sync:cosmos
 */
import fs from "node:fs";

const OUT = "src/config/cosmosChains.generated.ts";

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
