/**
 * Regenerates the Stargate pool address book from Stargate's own published
 * deployments.
 *
 * Stargate is LayerZero, and for the tokens people actually bridge to
 * arbitrage - USDC, USDT, ETH - its pools hold more than anything else on
 * this list. There is no registry that maps a ticker to them, which is
 * precisely the gap that made LayerZero coverage thin.
 *
 * The package holding these deployments is 327 MB, far too much to install
 * for a handful of addresses, so the tarball is streamed and only the
 * deployment files are unpacked. The result is committed as source.
 *
 * Run with: npm run sync:stargate   (needs network access)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as viemChains from "viem/chains";
import { validateAddress } from "../src/protocols/addresses/validate";

const PACKAGE = "@stargatefinance/stg-evm-v2";
const OUT = "src/protocols/addresses/stargate.generated.ts";

// Stargate deploys to testnets too, and a testnet pool in a table the bot
// reads by chain id would report testnet play money as real liquidity.
const mainnetChainIds = new Set<number>();
for (const chain of Object.values(viemChains) as any[]) {
  if (chain && typeof chain.id === "number" && !chain.testnet) mainnetChainIds.add(chain.id);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stargate-"));
const tarball = execFileSync("npm", ["view", PACKAGE, "dist.tarball"], { encoding: "utf8" }).trim();
const version = execFileSync("npm", ["view", PACKAGE, "version"], { encoding: "utf8" }).trim();

console.log(`качаю ${PACKAGE}@${version}, распаковываю только deployments...`);
execFileSync("bash", ["-c", `curl -sL '${tarball}' | tar xz -C '${tmp}' --wildcards 'package/deployments/*'`]);

const root = path.join(tmp, "package/deployments");

/** symbol -> chainId -> pool address */
const pools: Record<string, Record<number, string>> = {};
let skipped = 0;

for (const dir of fs.readdirSync(root)) {
  const chainIdFile = path.join(root, dir, ".chainId");
  if (!fs.existsSync(chainIdFile)) continue;
  const chainId = Number(fs.readFileSync(chainIdFile, "utf8").trim());
  if (!Number.isFinite(chainId) || !mainnetChainIds.has(chainId)) continue;

  for (const file of fs.readdirSync(path.join(root, dir))) {
    // StargatePool* locks a real ERC-20 and holds withdrawable liquidity.
    // StargateOFT* mints and burns its own supply and holds nothing, so a
    // balance read against it would always be zero and mean nothing.
    const match = /^StargatePool([A-Za-z0-9]+)\.json$/.exec(file);
    if (!match) continue;

    const asset = match[1];
    // The native pool holds the chain's own coin, not an ERC-20; reading it
    // needs a different call than every other row here, so it is left out
    // rather than silently reported as zero.
    if (asset === "Native") continue;

    const address = JSON.parse(fs.readFileSync(path.join(root, dir, file), "utf8"))?.address;
    if (typeof address !== "string") continue;

    const problems = validateAddress(address);
    if (problems.length > 0) {
      console.error(`пропущен ${dir}/${file}: ${problems.join("; ")}`);
      skipped++;
      continue;
    }

    const symbol = asset.toUpperCase();
    (pools[symbol] ??= {})[chainId] = address;
  }
}

const body = Object.keys(pools)
  .sort()
  .map((symbol) => {
    const rows = Object.entries(pools[symbol])
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([chainId, address]) => `    ${chainId}: "${address}",`)
      .join("\n");
    return `  ${symbol}: {\n${rows}\n  },`;
  })
  .join("\n");

fs.writeFileSync(
  OUT,
  `import type { Address } from "viem";

/**
 * Stargate pools by token symbol and EVM chain id - the contracts that hold
 * the locked collateral, so their balance is the liquidity available to
 * withdraw on that chain.
 *
 * GENERATED FILE. Do not edit by hand: run \`npm run sync:stargate\`, which
 * reads Stargate's own published deployments. Only StargatePool* is included;
 * StargateOFT* mints and burns its own supply and holds nothing, and the
 * native pool holds the chain's coin rather than an ERC-20.
 *
 * Source: ${PACKAGE}@${version}, deployments/*
 */
export const STARGATE_POOLS_BY_SYMBOL: Record<string, Record<number, Address>> = {
${body}
};
`,
  "utf8"
);

fs.rmSync(tmp, { recursive: true, force: true });
const total = Object.values(pools).reduce((n, byChain) => n + Object.keys(byChain).length, 0);
console.log(`${OUT}: ${Object.keys(pools).length} активов, ${total} пулов${skipped ? `, пропущено ${skipped}` : ""}`);
