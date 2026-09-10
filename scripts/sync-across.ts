/**
 * Regenerates the Across SpokePool address book from Across's own published
 * deployment file.
 *
 * The addresses are not typed in and not taken from a blog post: they come
 * from `@across-protocol/contracts`, the package Across publishes its
 * deployments in. That package pulls 242 transitive dependencies, which is
 * a lot to carry at runtime for one JSON file, so it is fetched here, read,
 * and the result committed as source.
 *
 * Run with: npm run sync:across   (needs network access)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as viemChains from "viem/chains";
import { validateAddress } from "../src/protocols/addresses/validate";

const PACKAGE = "@across-protocol/contracts";
const OUT = "src/protocols/addresses/across.generated.ts";

const mainnetChainIds = new Map<number, string>();
for (const chain of Object.values(viemChains) as any[]) {
  if (!chain || typeof chain.id !== "number" || chain.testnet) continue;
  if (!mainnetChainIds.has(chain.id)) mainnetChainIds.set(chain.id, chain.name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "across-"));
const tarball = execFileSync("npm", ["pack", PACKAGE, "--pack-destination", tmp, "--silent"], {
  encoding: "utf8",
}).trim();
execFileSync("tar", ["xzf", path.join(tmp, tarball), "-C", tmp, "package/dist/broadcast/deployed-addresses.json"]);

const version = tarball.replace(/^.*-(\d+\.\d+\.\d+.*)\.tgz$/, "$1");
const deployed = JSON.parse(
  fs.readFileSync(path.join(tmp, "package/dist/broadcast/deployed-addresses.json"), "utf8")
).chains as Record<string, { chain_name: string; contracts: Record<string, { address: string }> }>;

const rows: Array<[number, string, string]> = [];
for (const [rawId, chain] of Object.entries(deployed)) {
  const chainId = Number(rawId);
  // Across deploys to testnets and to non-EVM chains too; neither belongs in
  // a table the bot looks up by EVM chain id.
  const known = mainnetChainIds.get(chainId);
  if (!known) continue;

  const spokePool = chain.contracts?.SpokePool?.address;
  if (!spokePool) continue;

  const problems = validateAddress(spokePool);
  if (problems.length > 0) {
    console.error(`пропущен ${chain.chain_name} (${chainId}): ${problems.join("; ")}`);
    continue;
  }
  rows.push([chainId, known, spokePool]);
}
rows.sort((a, b) => a[0] - b[0]);

const body = rows.map(([id, name, address]) => `  ${id}: "${address}", // ${name}`).join("\n");

fs.writeFileSync(
  OUT,
  `import type { Address } from "viem";

/**
 * Across SpokePool per EVM chain id - the contract that actually holds the
 * bridged funds, so its balance is the liquidity available to withdraw.
 *
 * GENERATED FILE. Do not edit by hand: run \`npm run sync:across\`, which
 * reads Across's own published deployments. Keyed by chain id rather than by
 * name, so a chain added to chains.ts is picked up without a second mapping
 * to get wrong.
 *
 * Source: ${PACKAGE}@${version}, dist/broadcast/deployed-addresses.json
 * Mainnet EVM chains only; testnets and non-EVM deployments are dropped.
 */
export const ACROSS_SPOKE_POOL_BY_CHAIN_ID: Record<number, Address> = {
${body}
};
`,
  "utf8"
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${OUT}: ${rows.length} сетей из ${PACKAGE}@${version}`);
