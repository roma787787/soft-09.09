/**
 * Regenerates the table of the remaining non-EVM chains - Starknet, Radix,
 * Aleo - from Hyperlane's registry, same as the Sealevel and Cosmos tables.
 *
 * Run with: npm run sync:other
 */
import fs from "node:fs";

const OUT = "src/config/otherChains.generated.ts";
const PROTOCOLS = new Set(["starknet", "radix", "aleo"]);

const meta = require("../node_modules/@hyperlane-xyz/registry/dist/chainMetadata.js");
const chainMetadata = meta.chainMetadata ?? meta.default?.chainMetadata ?? meta.default ?? meta;

interface Row {
  key: string;
  label: string;
  protocol: string;
  rpcUrls: string[];
  explorer?: string;
}

const rows: Row[] = [];
for (const [key, value] of Object.entries<any>(chainMetadata)) {
  if (!PROTOCOLS.has(value?.protocol) || value?.isTestnet) continue;

  const rpcUrls = (value.rpcUrls ?? []).map((r: any) => r?.http).filter((u: unknown): u is string => !!u);
  if (rpcUrls.length === 0) continue;

  rows.push({
    key,
    label: value.displayName ?? value.name ?? key,
    protocol: value.protocol,
    rpcUrls,
    explorer: (value.blockExplorers ?? [])[0]?.url,
  });
}
rows.sort((a, b) => a.key.localeCompare(b.key));

const body = rows
  .map(
    (r) => `  {
    key: ${JSON.stringify(r.key)},
    label: ${JSON.stringify(r.label)},
    protocol: ${JSON.stringify(r.protocol)},
    rpcUrls: [${r.rpcUrls.map((u) => JSON.stringify(u)).join(", ")}],
    explorer: ${r.explorer ? JSON.stringify(r.explorer) : "undefined"},
  },`
  )
  .join("\n");

fs.writeFileSync(
  OUT,
  `/**
 * Starknet, Radix and Aleo chains carrying Hyperlane warp routes.
 *
 * GENERATED FILE. Do not edit by hand: run \\\`npm run sync:other\\\`.
 */
export interface GeneratedOtherChain {
  key: string;
  label: string;
  protocol: string;
  rpcUrls: string[];
  explorer?: string;
}

export const GENERATED_OTHER_CHAINS: GeneratedOtherChain[] = [
${body}
];
`,
  "utf8"
);

console.log(`${OUT}: ${rows.length} сетей — ${rows.map((r) => `${r.key}(${r.protocol})`).join(", ")}`);
