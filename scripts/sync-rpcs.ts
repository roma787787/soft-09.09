/**
 * Regenerates fallback RPC endpoints from the public chain list that
 * chainlist.org is built on.
 *
 * viem carries one endpoint per chain, which is fine for the majors and not
 * fine for the long tail: fifty-two of a hundred and fifty-two chains had
 * their single endpoint refuse, and a chain that drops out of a report reads
 * as "no liquidity here" rather than as a node saying no.
 *
 * Only chains this bot actually has are written out, and only plain public
 * HTTPS endpoints - anything wanting a key would fail on every request and
 * cost a round trip each time.
 *
 * Run with: npm run sync:rpcs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHAINS } from "../src/config/chains";

const PACKAGE = "chainlist-rpcs";
const OUT = "src/config/rpcs.generated.ts";

/**
 * The canonical chain registry - the one chainid.network serves and every
 * wallet reads. A second source because the first one disagrees with it in
 * exactly the cases that matter: chainlist had Astar zkEVM at
 * rpc-zkevm.astar.network, a hostname that no longer resolves, while the
 * registry has it at rpc.startale.com. One dead entry is the whole chain
 * when it is the only entry.
 */
const REGISTRY = "https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains";

/**
 * Endpoints kept per chain. The reader uses the first six, counting the one
 * viem carries; eight leaves room for the dead ones to be skipped past
 * without the list turning into a queue of timeouts.
 */
const PER_CHAIN = 8;

/** Registry lookups in flight. Polite to GitHub, still under a minute. */
const REGISTRY_CONCURRENCY = 12;

/**
 * An endpoint that wants a key answers nothing without one, so it is a
 * guaranteed failed request on every report - and it occupies a slot a
 * working node could have had.
 */
function usable(url: unknown): url is string {
  if (typeof url !== "string" || !url.startsWith("https://")) return false;
  if (/\$\{|API_KEY|\{.*\}/i.test(url)) return false;
  // A websocket endpoint written with an https scheme - the registry lists
  // Taraxa's as https://ws.mainnet.taraxa.io - will refuse an ordinary POST
  // every single time, and it would sit in front of a node that works.
  if (/^https:\/\/ws[.-]/.test(url) || /\/wss?$/.test(url)) return false;
  return true;
}

/** Trailing slashes and nothing else: the same node twice is a wasted slot. */
function canonicalUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function registryRpcs(chainId: number): Promise<string[]> {
  try {
    const response = await fetch(`${REGISTRY}/eip155-${chainId}.json`);
    if (!response.ok) return [];
    const body = (await response.json()) as { rpc?: unknown };
    return Array.isArray(body.rpc) ? body.rpc.filter(usable) : [];
  } catch {
    // A chain the registry does not carry is normal, not an error: this bot
    // tracks chains younger than the registry entry that would describe them.
    return [];
  }
}

/** Registry answers keyed by chain id, fetched a dozen at a time. */
async function fetchRegistry(ids: number[]): Promise<Map<number, string[]>> {
  const found = new Map<number, string[]>();
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;
      found.set(ids[index], await registryRpcs(ids[index]));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REGISTRY_CONCURRENCY, ids.length) }, () => worker())
  );
  return found;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rpcs-"));
const tarball = execFileSync("npm", ["pack", PACKAGE, "--pack-destination", tmp, "--silent"], {
  encoding: "utf8",
}).trim();
execFileSync("tar", ["xzf", path.join(tmp, tarball), "-C", tmp]);

const version = tarball.replace(/^.*-(\d+\.\d+\.\d+.*)\.tgz$/, "$1");
const modulePath = path.join(tmp, "package/constants/extraRpcs.js");

(async () => {
  const { extraRpcs } = await import(modulePath);

  const wanted = new Map<number, string>();
  for (const chain of CHAINS) wanted.set(chain.viemChain.id, chain.key);

  const registry = await fetchRegistry(CHAINS.map((c) => c.viemChain.id));

  const rows: Array<[number, string, string[]]> = [];
  let fromRegistryOnly = 0;
  for (const chain of CHAINS) {
    const entry = extraRpcs[String(chain.viemChain.id)];
    const rpcs = Array.isArray(entry?.rpcs) ? entry.rpcs : [];

    // chainlist first, registry after: chainlist ranks its entries by
    // observed health, and the registry lists whatever the chain's own team
    // wrote down. Both are then deduplicated against what viem already
    // carries, ignoring a trailing slash - the two sources spell the same
    // node differently often enough to matter when only six are read.
    const candidates = [
      ...rpcs.map((rpc: unknown) => (typeof rpc === "string" ? rpc : (rpc as { url?: unknown })?.url)),
      ...(registry.get(chain.viemChain.id) ?? []),
    ];

    const seen = new Set(chain.defaultRpcUrls.map(canonicalUrl));
    const urls: string[] = [];
    for (const candidate of candidates) {
      if (!usable(candidate)) continue;
      const url = canonicalUrl(candidate);
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= PER_CHAIN) break;
    }

    if (urls.length > 0) rows.push([chain.viemChain.id, chain.key, urls]);
    else if ((registry.get(chain.viemChain.id) ?? []).length > 0) fromRegistryOnly++;
  }

  const body = rows
    .sort((a, b) => a[0] - b[0])
    .map(([, key, urls]) => `  ${JSON.stringify(key)}: [${urls.map((u) => JSON.stringify(u)).join(", ")}],`)
    .join("\n");

  fs.writeFileSync(
    OUT,
    `/**
 * Extra public endpoints per chain, tried after the one viem carries.
 *
 * GENERATED FILE. Do not edit by hand: run \\\`npm run sync:rpcs\\\`.
 *
 * viem lists a single endpoint per chain. That is enough for the majors and
 * not enough for the long tail, where one refusal takes the whole chain out
 * of the report - and a missing chain reads as "no liquidity here", which is
 * the opposite of what it means.
 *
 * Sources: ${PACKAGE}@${version}, the data behind chainlist.org, and
 * ethereum-lists/chains, the registry chainid.network serves. Two of them
 * because they disagree exactly where it matters: chainlist had Astar zkEVM
 * on a hostname that no longer resolves, while the registry had the live
 * one, and a chain with a single dead entry has no endpoints at all.
 */
export const EXTRA_RPC_URLS: Record<string, string[]> = {
${body}
};
`,
    "utf8"
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  const total = rows.reduce((n, r) => n + r[2].length, 0);
  const alone = CHAINS.filter((c) => !rows.some((r) => r[1] === c.key)).length;
  console.log(`${OUT}: ${rows.length} сетей, ${total} эндпоинтов`);
  console.log(`без запасных узлов остались: ${alone} ${fromRegistryOnly ? `(из них ${fromRegistryOnly} — реестр знает только то, что уже есть у viem)` : ""}`);
})();
