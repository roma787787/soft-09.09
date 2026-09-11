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
import * as viemChains from "viem/chains";

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
 * And a third: the registry Hyperlane runs its own relayers against. Not
 * another copy of the same list - a bridge operator has to keep these
 * answering or its messages stop being delivered, so it carries endpoints
 * the public lists never got. Zero Network is the case in point: chainlist
 * and the canonical registry both had only dead hosts for it, Hyperlane has
 * rpc.zerion.io and zero.drpc.org, and both answer.
 *
 * Read from the installed package, so this source costs no network.
 */
const HYPERLANE_METADATA = "../node_modules/@hyperlane-xyz/registry/dist/chainMetadata.js";

interface HyperlaneChain {
  chainId?: number | string;
  protocol?: string;
  isTestnet?: boolean;
  rpcUrls?: Array<{ http?: unknown }>;
}

/**
 * A chain id an EVM chain could actually have.
 *
 * Not every registry entry is EVM, and the non-EVM ones do not use this
 * number space at all: Hyperlane files Aleo under chain id 0 and Paradex
 * under one so large it comes out of JSON as 8.4e66. Both were landing in
 * the generated table, where nothing could ever match them - dead weight,
 * and a key that is not an integer in a file that claims to be keyed by
 * chain id.
 */
function isEvmChainId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0;
}

function hyperlaneRpcs(): Map<number, string[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const module = require(HYPERLANE_METADATA);
  const metadata = module.chainMetadata ?? module.default ?? module;
  const found = new Map<number, string[]>();
  for (const chain of Object.values(metadata) as HyperlaneChain[]) {
    if (chain?.isTestnet || chain?.protocol !== "ethereum") continue;
    const id = Number(chain?.chainId);
    if (!isEvmChainId(id)) continue;
    const urls = (chain.rpcUrls ?? []).map((r) => r?.http).filter(usable);
    if (urls.length > 0) found.set(id, urls);
  }
  return found;
}

/**
 * Endpoints kept per chain.
 *
 * Eight used to be a compromise: the reader uses six, and a longer list was
 * just a longer queue of timeouts to wait through. It is not a compromise
 * any more. The endpoints are measured at runtime and the six the reader
 * uses are the six that answered fastest, so a larger pool costs a slightly
 * longer measurement and buys a better six.
 *
 * Eight was throwing away 599 endpoints, and a fifth of what it kept came
 * from one aggregator that refuses this host outright - so the chains that
 * needed alternates most were the ones whose alternates were being dropped.
 */
const PER_CHAIN = 16;

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

  // Every chain id the bot could end up holding, not just the ones the table
  // carries today. It discovers chains at runtime, and a discovered chain
  // used to get no alternates at all: this file was keyed by the bot's own
  // chain names, and a chain it had not been told about has no such name.
  // Ninety-one chains were down to a single working node because of it.
  const universe = new Set<number>(CHAINS.map((c) => c.viemChain.id).filter(isEvmChainId));
  for (const candidate of Object.values(viemChains as Record<string, unknown>)) {
    const chain = candidate as { id?: number; testnet?: boolean };
    if (typeof chain?.id === "number" && !chain.testnet && isEvmChainId(chain.id)) universe.add(chain.id);
  }
  for (const id of hyperlaneRpcs().keys()) universe.add(id);

  const ids = [...universe].sort((a, b) => a - b);
  const registry = await fetchRegistry(ids);
  const hyperlane = hyperlaneRpcs();

  const rows: Array<[number, string[]]> = [];
  let truncated = 0;
  for (const id of ids) {
    const entry = extraRpcs[String(id)];
    const rpcs = Array.isArray(entry?.rpcs) ? entry.rpcs : [];
    const chain = CHAINS.find((c) => c.viemChain.id === id);

    // Ordered by how much each source has to lose from a dead entry.
    // chainlist ranks its own entries by observed health; Hyperlane has to
    // keep its endpoints answering or its relayers stop delivering; the
    // canonical registry lists whatever a chain's team wrote down and never
    // came back to correct. All three are then deduplicated against what
    // viem already carries and against each other, ignoring a trailing
    // slash - they spell the same node differently often enough to matter
    // when only six are read.
    const candidates = [
      ...rpcs.map((rpc: unknown) => (typeof rpc === "string" ? rpc : (rpc as { url?: unknown })?.url)),
      ...(hyperlane.get(id) ?? []),
      ...(registry.get(id) ?? []),
    ];

    const seen = new Set((chain?.defaultRpcUrls ?? []).map(canonicalUrl));
    const urls: string[] = [];
    for (const candidate of candidates) {
      if (!usable(candidate)) continue;
      const url = canonicalUrl(candidate);
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= PER_CHAIN) break;
    }

    if (urls.length > 0) rows.push([id, urls]);

    // How much the cap is costing. Kept as a number the run prints rather
    // than a guess: raising it is only worth the file size if candidates are
    // actually being thrown away.
    let usableCandidates = 0;
    const counted = new Set<string>();
    for (const candidate of candidates) {
      if (!usable(candidate)) continue;
      const url = canonicalUrl(candidate);
      if (counted.has(url)) continue;
      counted.add(url);
      usableCandidates++;
    }
    if (usableCandidates > urls.length) truncated += usableCandidates - urls.length;
  }

  const body = rows
    .sort((a, b) => a[0] - b[0])
    .map(([id, urls]) => `  ${id}: [${urls.map((u) => JSON.stringify(u)).join(", ")}],`)
    .join("\n");

  fs.writeFileSync(
    OUT,
    `/**
 * Extra public endpoints per chain id, tried after the one viem carries.
 *
 * Keyed by chain id, not by the bot's own name for a chain: it discovers
 * chains at runtime, and a chain it was never told about has no such name -
 * so keying by name gave every discovered chain an empty list.
 *
 * GENERATED FILE. Do not edit by hand: run \\\`npm run sync:rpcs\\\`.
 *
 * viem lists a single endpoint per chain. That is enough for the majors and
 * not enough for the long tail, where one refusal takes the whole chain out
 * of the report - and a missing chain reads as "no liquidity here", which is
 * the opposite of what it means.
 *
 * Sources: ${PACKAGE}@${version}, the data behind chainlist.org;
 * @hyperlane-xyz/registry, which a bridge operator keeps answering because
 * its relayers depend on it; and ethereum-lists/chains, the registry
 * chainid.network serves. Three of them because they disagree exactly where
 * it matters - both public lists had only dead hosts for Zero Network while
 * Hyperlane had two that answer - and a chain whose single entry is dead has
 * no endpoints at all.
 */
export const EXTRA_RPC_URLS_BY_CHAIN_ID: Record<number, string[]> = {
${body}
};
`,
    "utf8"
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  const total = rows.reduce((n, r) => n + r[1].length, 0);
  const covered = new Set(rows.map((r) => r[0]));
  const ourChainsCovered = CHAINS.filter((c) => covered.has(c.viemChain.id)).length;
  console.log(`${OUT}: ${rows.length} сетей, ${total} эндпоинтов`);
  console.log(`из них в сегодняшней таблице бота: ${ourChainsCovered} из ${CHAINS.length}`);
  console.log(`отрезано лимитом PER_CHAIN=${PER_CHAIN}: ${truncated} узлов`);
})();
