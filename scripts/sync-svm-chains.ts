/**
 * Regenerates the table of Sealevel (Solana-family) chains from Hyperlane's
 * own registry.
 *
 * The registry already states each chain's protocol, its RPC endpoints and
 * its explorer, and it is the same source the warp routes come from - so the
 * chain a route names is guaranteed to be a chain this table knows, with no
 * second mapping to get wrong. Writing them out by hand would reintroduce
 * exactly the transcription risk the EVM tables were built to avoid.
 *
 * Run with: npm run sync:svm
 */
import fs from "node:fs";

const OUT = "src/config/svmChains.generated.ts";

const meta = require("../node_modules/@hyperlane-xyz/registry/dist/chainMetadata.js");
const chainMetadata = meta.chainMetadata ?? meta.default?.chainMetadata ?? meta.default ?? meta;

interface Row {
  key: string;
  label: string;
  rpcUrls: string[];
  explorer?: string;
}

const rows: Row[] = [];
for (const [key, value] of Object.entries<any>(chainMetadata)) {
  if (value?.protocol !== "sealevel" || value?.isTestnet) continue;

  const rpcUrls = (value.rpcUrls ?? []).map((r: any) => r?.http).filter((u: unknown): u is string => !!u);
  if (rpcUrls.length === 0) continue;

  rows.push({
    key,
    label: value.displayName ?? value.name ?? key,
    rpcUrls,
    // A base carrying its own query string cannot take a path appended to
    // it, so those chains get a link to the explorer rather than a wrong
    // deep link to nothing.
    explorer: (value.blockExplorers ?? [])[0]?.url,
  });
}
rows.sort((a, b) => a.key.localeCompare(b.key));

const body = rows
  .map(
    (r) => `  {
    key: ${JSON.stringify(r.key)},
    label: ${JSON.stringify(r.label)},
    rpcUrls: [${r.rpcUrls.map((u) => JSON.stringify(u)).join(", ")}],
    explorer: ${r.explorer ? JSON.stringify(r.explorer) : "undefined"},
  },`
  )
  .join("\n");

fs.writeFileSync(
  OUT,
  `/**
 * Sealevel chains - Solana and the rollups that run its VM.
 *
 * GENERATED FILE. Do not edit by hand: run \\\`npm run sync:svm\\\`, which reads
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
${body}
];
`,
  "utf8"
);

console.log(`${OUT}: ${rows.length} сетей — ${rows.map((r) => r.key).join(", ")}`);
