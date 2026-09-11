import fs from "node:fs";
import path from "node:path";
import type { Chain } from "viem";
import * as viemChains from "viem/chains";
import { type ChainDef, CHAINS, getChainByChainId, registerChain } from "../config/chains";
import { assetPlatforms, type AssetPlatform } from "./coingecko";
import { lzChainCandidates, type LzChainCandidate } from "../bridges/lzMetadata";
import { env } from "../config/env";
import { mapWithConcurrency } from "./concurrency";

/**
 * Hyperlane's chain metadata, read the same way the warp-route registry is:
 * from the file rather than through the package. The package is ESM-only,
 * does not export this path, and its entry point pulls in the wider SDK -
 * while the file itself is a self-contained JSON literal. Failing to read it
 * must never take the bot down; it only costs the chains viem does not
 * already describe.
 */
function loadHyperlaneMetadata(): Record<string, Record<string, any>> {
  try {
    const file = path.join(process.cwd(), "node_modules", "@hyperlane-xyz", "registry", "dist", "chainMetadata.js");
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch (err) {
    console.error("[chains] не удалось прочитать метаданные сетей Hyperlane:", err);
    return {};
  }
}

const HYPERLANE_METADATA = loadHyperlaneMetadata();

/** How long a node gets to prove it is a node. */
const PROBE_TIMEOUT_MS = 6_000;

/**
 * Chains probed at once, each probing its endpoints in parallel.
 *
 * Sized against the clock rather than politeness: a rescan asked for in
 * chat has to finish inside Telegram's handler window, and a hundred and
 * fifty candidates at a registry lookup plus six six-second probes each
 * would not have, at ten.
 */
const PROBE_CONCURRENCY = 16;

/** Endpoints tried per candidate chain, matching what the reader will use. */
const MAX_ENDPOINTS = 6;

export interface DiscoveredChain {
  key: string;
  label: string;
  chainId: number;
  rpcUrl: string;
}

export interface RejectedChain {
  label: string;
  chainId: number;
  reason: string;
}

export interface DiscoveryReport {
  at: Date;
  /** Distinct EVM networks the sources named between them. */
  listed: number;
  /** Of those, how many only the bridge registry named. */
  fromBridges: number;
  /** Of those, the ones the bot already had. */
  known: number;
  added: DiscoveredChain[];
  rejected: RejectedChain[];
  /**
   * Probed successfully, then refused by the table because the chain was
   * already there.
   *
   * Its own bucket rather than nothing at all, which is where these went:
   * eighty-seven chains passed every check and then vanished from the
   * report, and the only sign of it was that the numbers did not add up -
   * 120 known plus 0 added plus 68 refused, out of 275.
   */
  duplicates: number;
  error?: string;
}

let lastReport: DiscoveryReport | undefined;

export function lastDiscovery(): DiscoveryReport | undefined {
  return lastReport;
}

/* ------------------------------------------------------------------ */

export interface ChainFacts {
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  explorerUrl?: string;
}

const viemById = new Map<number, Chain>();
for (const candidate of Object.values(viemChains as Record<string, unknown>)) {
  const chain = candidate as Chain;
  if (typeof chain?.id !== "number" || !chain?.nativeCurrency || !chain?.rpcUrls) continue;
  // viem ships the testnets alongside the mainnets, and this bot answers
  // questions about real liquidity: a testnet added here would report
  // balances in play money under a name that looks like the real chain.
  // Hyperlane's metadata is already filtered the same way.
  if (chain.testnet) continue;
  if (!viemById.has(chain.id)) viemById.set(chain.id, chain);
}

const hyperlaneById = new Map<number, ChainFacts>();
for (const entry of Object.values(HYPERLANE_METADATA) as Array<Record<string, any>>) {
  if (entry?.protocol !== "ethereum" || entry?.isTestnet) continue;
  const id = Number(entry?.chainId);
  if (!Number.isInteger(id) || hyperlaneById.has(id)) continue;
  const token = entry.nativeToken ?? {};
  hyperlaneById.set(id, {
    name: String(entry.displayName ?? entry.name ?? id),
    nativeCurrency: {
      name: String(token.name ?? "Ether"),
      symbol: String(token.symbol ?? "ETH"),
      decimals: Number.isInteger(token.decimals) ? token.decimals : 18,
    },
    rpcUrls: (entry.rpcUrls ?? [])
      .map((r: { http?: unknown }) => r?.http)
      .filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://")),
    explorerUrl: typeof entry.blockExplorers?.[0]?.url === "string" ? entry.blockExplorers[0].url : undefined,
  });
}

/**
 * What is known about a chain id, from the two registries that ship with the
 * bot. Neither costs a request, and between them they cover a chain the
 * token API has only just started listing.
 */
export function factsFor(chainId: number): ChainFacts | undefined {
  const viem = viemById.get(chainId);
  const hyperlane = hyperlaneById.get(chainId);
  if (!viem && !hyperlane) return undefined;

  const urls = [
    ...(viem?.rpcUrls?.default?.http ?? []),
    ...(hyperlane?.rpcUrls ?? []),
  ].filter((u) => typeof u === "string" && u.startsWith("https://") && !/\$\{|API_KEY/i.test(u));

  return {
    name: hyperlane?.name ?? viem?.name ?? String(chainId),
    nativeCurrency: hyperlane?.nativeCurrency ??
      viem?.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [...new Set(urls.map((u) => u.replace(/\/+$/, "")))],
    explorerUrl: viem?.blockExplorers?.default?.url ?? hyperlane?.explorerUrl,
  };
}

/**
 * The canonical chain registry - the one chainid.network serves - asked for
 * the chains neither local registry describes.
 *
 * Sixty-five candidates fell at that first hurdle: CoinGecko knew the
 * network existed, and nothing inside the bot knew what its coin was called
 * or where to reach it. This is one request per unknown chain id, once a
 * day, and it is the difference between "we cannot describe it" and having
 * it in the table.
 */
const REGISTRY_URL = "https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains";

/** Answers already fetched, misses included: a miss costs a request too. */
const registryCache = new Map<number, ChainFacts | undefined>();

async function registryFacts(chainId: number): Promise<ChainFacts | undefined> {
  if (registryCache.has(chainId)) return registryCache.get(chainId);

  let facts: ChainFacts | undefined;
  try {
    const response = await fetch(`${REGISTRY_URL}/eip155-${chainId}.json`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      const body = (await response.json()) as Record<string, any>;
      facts = factsFromRegistryEntry(body, chainId);
    }
  } catch {
    // A registry that will not answer is the same as one that does not carry
    // the chain: nothing is added, and the next run asks again.
  }
  registryCache.set(chainId, facts);
  return facts;
}

/** Split out from the fetch so the shape can be checked without a network. */
export function factsFromRegistryEntry(
  entry: Record<string, any> | undefined,
  chainId: number
): ChainFacts | undefined {
  if (!entry || Number(entry.chainId) !== chainId) return undefined;
  // A non-empty faucet list is what a testnet has and a mainnet does not -
  // the registry keeps both in one directory and does not label them.
  if (Array.isArray(entry.faucets) && entry.faucets.length > 0) return undefined;
  if (entry.status === "deprecated") return undefined;

  const rpcUrls = (Array.isArray(entry.rpc) ? entry.rpc : []).filter(
    (u: unknown): u is string =>
      typeof u === "string" && u.startsWith("https://") && !/\$\{|API_KEY/i.test(u)
  );
  if (rpcUrls.length === 0) return undefined;

  const token = entry.nativeCurrency ?? {};
  const explorer = entry.explorers?.[0]?.url;
  return {
    name: String(entry.name ?? chainId),
    nativeCurrency: {
      name: String(token.name ?? "Ether"),
      symbol: String(token.symbol ?? "ETH"),
      decimals: Number.isInteger(token.decimals) ? token.decimals : 18,
    },
    rpcUrls: [...new Set(rpcUrls.map((u: string) => u.replace(/\/+$/, "")))],
    explorerUrl: typeof explorer === "string" ? explorer : undefined,
  };
}

/**
 * Everything all three registries know about a chain id, merged.
 *
 * Merged, not tried in order, and that distinction is the whole point.
 * The canonical registry used to be consulted only when the local two said
 * nothing at all, and forty-four candidates were then refused with "the one
 * node did not answer" - one node, because that is all the local registries
 * carried. Ethereum Classic has five in the canonical registry, ThunderCore
 * three, Boba BNB four. Those are not obscure dead chains; they are live
 * ones whose first listed endpoint has gone stale, which is the same thing
 * that already cost the bot a chain a week ago.
 */
async function mergedFacts(chainId: number): Promise<ChainFacts | undefined> {
  return mergeFacts(factsFor(chainId), await registryFacts(chainId));
}

/** The merge itself, without the fetch, so it can be checked offline. */
export function mergeFacts(
  local: ChainFacts | undefined,
  registry: ChainFacts | undefined
): ChainFacts | undefined {
  if (!local) return registry;
  if (!registry) return local;
  return {
    // The local registries name a chain the way people do ("Astar zkEVM"),
    // the canonical one the way its team filed it ("Astar zkEVM Mainnet").
    name: local.name,
    nativeCurrency: local.nativeCurrency,
    rpcUrls: [...new Set([...local.rpcUrls, ...registry.rpcUrls])],
    explorerUrl: local.explorerUrl ?? registry.explorerUrl,
  };
}

/**
 * A key for a chain the bot was not told about.
 *
 * Derived from CoinGecko's slug, which is stable and already lowercase, so
 * the same chain gets the same key on every boot - the key ends up in the
 * database behind /track, and a key that changed between restarts would
 * orphan every subscription on that chain.
 */
export function keyForSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]/g, "") || "chain";
}

/**
 * Asks one endpoint which chain it is.
 *
 * eth_chainId rather than eth_blockNumber, because the answer has to be
 * checked, not just received: a URL that has been repointed at another
 * network answers a block number perfectly happily, and reading one chain's
 * balances while calling them another's is worse than not reading them.
 */
async function confirmsChainId(url: string, expected: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { result?: unknown };
    return typeof body.result === "string" && Number(BigInt(body.result)) === expected;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function firstWorkingEndpoint(urls: string[], chainId: number): Promise<string | undefined> {
  const tried = urls.slice(0, MAX_ENDPOINTS);
  const answers = await Promise.all(tried.map(async (u) => ((await confirmsChainId(u, chainId)) ? u : undefined)));
  return answers.find(Boolean);
}

function chainDefFor(platform: AssetPlatform, facts: ChainFacts, rpcUrl: string): ChainDef {
  const key = keyForSlug(platform.id);
  const label = platform.name || facts.name;
  const explorer = facts.explorerUrl?.replace(/\/+$/, "");
  const viem = viemById.get(platform.chainId!);

  // viem's own chain object when it has one - it carries the details that
  // matter for reads, like multicall and fee history support - and a
  // constructed one otherwise, which is what lets the bot reach a chain
  // released after the version of viem it was built against.
  const viemChain: Chain =
    viem ??
    ({
      id: platform.chainId!,
      name: label,
      nativeCurrency: facts.nativeCurrency,
      rpcUrls: { default: { http: facts.rpcUrls.length > 0 ? facts.rpcUrls : [rpcUrl] } },
      ...(explorer ? { blockExplorers: { default: { name: `${label} explorer`, url: explorer } } } : {}),
    } as Chain);

  return {
    key,
    label,
    viemChain,
    rpcEnvVar: `${key.toUpperCase()}_RPC_URL`,
    // The endpoint that answered goes first: the rest are kept behind it,
    // but there is no sense making every read pay for a node that just
    // failed its only test.
    defaultRpcUrls: [rpcUrl, ...facts.rpcUrls.filter((u) => u !== rpcUrl)],
    // Empty when the chain has no known explorer, never the bare hash. The
    // bare value went straight into an href, and "0xdAC17…" is not a URL:
    // Telegram rejects the message rather than rendering a dead link, so one
    // chain without an explorer would have taken down whole reports. Every
    // caller already treats an empty string as "no link".
    explorerTxUrl: (hash) => (explorer ? `${explorer}/tx/${hash}` : ""),
    explorerAddressUrl: (address) => (explorer ? `${explorer}/address/${address}` : ""),
    aliases: [...new Set([key, platform.id.toLowerCase(), label.toLowerCase().replace(/\s+/g, "")])],
    platformNames: [platform.name],
  };
}

/* ------------------------------------------------------------------ */

/**
 * Adds the EVM networks CoinGecko lists that the bot does not yet have.
 *
 * The customer's ask was that new chains appear without anyone editing the
 * table, and the shape of the reports is what makes that safe: a report only
 * reads the chains a token actually lives on, so a wider table costs nothing
 * per report. It only decides whether a chain a token IS on gets read, or
 * gets printed in the footer as one the bot does not check - which is the
 * complaint this answers.
 *
 * Nothing is added on the token API's say-so alone. A candidate has to be
 * described by a registry that ships with the bot, and then a node has to
 * answer eth_chainId with the id we expected. A chain nobody can read would
 * only lengthen every report's footer with a network the bot cannot say
 * anything about.
 */
export async function discoverChains(): Promise<DiscoveryReport> {
  // One scan at a time. Startup begins one without waiting for it, so a
  // /chains обнови a few seconds later used to start a second: both then
  // took their "already known" count before either had added anything, both
  // probed the same hundred and fifty chains, and the one that finished
  // second reported nothing added - having done all the work and found the
  // table already full. It also doubled the requests to every registry and
  // every node involved.
  if (scanInFlight) return scanInFlight;
  scanInFlight = runDiscovery().finally(() => {
    scanInFlight = undefined;
  });
  return scanInFlight;
}

let scanInFlight: Promise<DiscoveryReport> | undefined;

/** What a candidate needs to be probed and, if it answers, registered. */
interface Candidate {
  /** Stable across restarts: it becomes the chain key /track stores. */
  slug: string;
  chainId: number;
  name: string;
  /** Only the bridge registry carries these; merged behind the others. */
  facts?: ChainFacts;
  fromBridgeOnly: boolean;
}

/**
 * Everything both sources name, one entry per chain id.
 *
 * The price API goes first and keeps its slug where both name a chain: that
 * slug is already in the database behind every /track subscription, and a
 * key that changed the day a second source was added would orphan them all.
 */
export function mergeCandidates(
  platforms: Iterable<AssetPlatform>,
  bridgeChains: Iterable<LzChainCandidate>
): Candidate[] {
  const byId = new Map<number, Candidate>();

  for (const platform of platforms) {
    if (platform.chainId === undefined) continue;
    if (!byId.has(platform.chainId)) {
      byId.set(platform.chainId, {
        slug: platform.id,
        chainId: platform.chainId,
        name: platform.name || platform.id,
        fromBridgeOnly: false,
      });
    }
  }

  for (const chain of bridgeChains) {
    const seen = byId.get(chain.chainId);
    if (seen) {
      // Known to both: keep the established slug, take the endpoints. A
      // chain refused for "no public nodes" can be carried by the ones the
      // bridge publishes for itself.
      seen.facts = factsFromBridge(chain);
      continue;
    }
    byId.set(chain.chainId, {
      slug: chain.slug,
      chainId: chain.chainId,
      name: chain.name,
      facts: factsFromBridge(chain),
      fromBridgeOnly: true,
    });
  }

  return [...byId.values()];
}

function factsFromBridge(chain: LzChainCandidate): ChainFacts | undefined {
  if (chain.rpcUrls.length === 0 && !chain.nativeCurrency) return undefined;
  return {
    name: chain.name,
    nativeCurrency: chain.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: chain.rpcUrls,
    explorerUrl: chain.explorerUrl,
  };
}

async function runDiscovery(): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    at: new Date(),
    listed: 0,
    fromBridges: 0,
    known: 0,
    added: [],
    rejected: [],
    duplicates: 0,
  };

  let platforms: Map<string, AssetPlatform>;
  try {
    platforms = await assetPlatforms();
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    lastReport = report;
    return report;
  }

  // The second source, and the reason Sanko, Glue and Apex Fusion Nexus were
  // missing: the price API lists the chains worth pricing tokens on, and
  // those three carry Stargate pools while nobody prices anything on them.
  // A failure here costs those chains, never the scan.
  let bridgeChains: LzChainCandidate[] = [];
  try {
    bridgeChains = await lzChainCandidates();
  } catch (err) {
    console.error("[chains] не удалось получить список сетей моста:", err);
  }

  const candidates: Candidate[] = [];
  for (const candidate of mergeCandidates(platforms.values(), bridgeChains)) {
    report.listed++;
    if (candidate.fromBridgeOnly) report.fromBridges++;
    if (getChainByChainId(candidate.chainId)) {
      report.known++;
      continue;
    }
    candidates.push(candidate);
  }

  const results = await mapWithConcurrency(candidates, PROBE_CONCURRENCY, async (candidate) => {
    const facts = mergeFacts(await mergedFacts(candidate.chainId), candidate.facts);
    if (!facts) {
      return {
        label: candidate.name,
        chainId: candidate.chainId,
        reason: "ни один реестр её не описывает",
      } as RejectedChain;
    }
    if (facts.rpcUrls.length === 0) {
      return { label: candidate.name, chainId: candidate.chainId, reason: "нет публичных узлов" } as RejectedChain;
    }
    const url = await firstWorkingEndpoint(facts.rpcUrls, candidate.chainId);
    return url
      ? { candidate, facts, url }
      : ({
          label: candidate.name,
          chainId: candidate.chainId,
          reason: `ни один из ${Math.min(facts.rpcUrls.length, MAX_ENDPOINTS)} узлов не отозвался`,
        } as RejectedChain);
  });

  const found: StoredChain[] = [];
  for (const result of results) {
    if (!result) continue;
    if ("reason" in result) {
      report.rejected.push(result);
      continue;
    }
    const { candidate, facts, url } = result;
    const def = chainDefFor({ id: candidate.slug, chainId: candidate.chainId, name: candidate.name }, facts, url);
    if (registerChain(def)) {
      report.added.push({
        key: def.key,
        label: def.label,
        chainId: def.viemChain.id,
        rpcUrl: url,
      });
      found.push({
        slug: candidate.slug,
        chainId: candidate.chainId,
        name: candidate.name || facts.name,
        nativeCurrency: facts.nativeCurrency,
        rpcUrls: facts.rpcUrls,
        explorerUrl: facts.explorerUrl,
        rpcUrl: url,
      });
    } else {
      report.duplicates++;
    }
  }

  saveDiscoveredChains(found);
  lastReport = report;
  return report;
}

/**
 * A discovered chain as plain data, enough to rebuild its definition.
 *
 * Discovery only ever added chains to memory, so every restart began without
 * them and rebuilt the table by probing a hundred and fifty endpoints - and
 * answered questions in the meantime with the chains it had. Two identical
 * USDC reports minutes apart differed by three networks and eighty-eight
 * million in reported supply, purely because one of them ran before the scan
 * finished. A report that changes with the bot's uptime is not a report.
 */
export interface StoredChain {
  slug: string;
  chainId: number;
  name: string;
  nativeCurrency: ChainFacts["nativeCurrency"];
  rpcUrls: string[];
  explorerUrl?: string;
  /** The endpoint that answered when the chain was found. */
  rpcUrl: string;
}

/** Kept beside the database, like the price API's platform list. */
function discoveredPath(): string {
  return path.join(path.dirname(env.dbPath), "chains.discovered.json");
}

/**
 * Rebuilds a chain definition from stored facts.
 *
 * Defensive because the file is not code: a truncated write or a hand edit
 * must cost one chain, not the boot. Anything that does not describe a chain
 * completely is skipped rather than half-registered.
 */
export function defFromDiscovered(entry: unknown): ChainDef | undefined {
  const e = entry as StoredChain | undefined;
  if (!e || typeof e.slug !== "string" || !e.slug) return undefined;
  if (typeof e.chainId !== "number" || !Number.isFinite(e.chainId)) return undefined;
  if (typeof e.rpcUrl !== "string" || !e.rpcUrl) return undefined;

  const currency = e.nativeCurrency;
  if (!currency || typeof currency.symbol !== "string" || typeof currency.decimals !== "number") return undefined;

  const name = typeof e.name === "string" && e.name ? e.name : e.slug;
  const rpcUrls = Array.isArray(e.rpcUrls) ? e.rpcUrls.filter((u) => typeof u === "string") : [];

  return chainDefFor(
    { id: e.slug, chainId: e.chainId, name },
    { name, nativeCurrency: currency, rpcUrls, explorerUrl: e.explorerUrl },
    e.rpcUrl
  );
}

/**
 * Registers the chains a previous scan found. Called before the bot answers
 * anything, so the first report of a deploy covers as much as the last one
 * of the deploy before it.
 */
export function loadDiscoveredChains(): number {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(discoveredPath(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[chains] не удалось прочитать сохранённые сети:", err);
    }
    return 0;
  }
  if (!Array.isArray(raw)) return 0;

  let added = 0;
  for (const entry of raw) {
    const def = defFromDiscovered(entry);
    if (def && registerChain(def)) added++;
  }
  return added;
}

/**
 * Merges this scan's finds into the stored ones.
 *
 * Merged rather than replaced: a chain found yesterday counts as already
 * known today, so it never appears in a later scan's additions, and writing
 * only what this run added would empty the file one deploy at a time.
 */
function saveDiscoveredChains(found: StoredChain[]): void {
  if (found.length === 0) return;
  const byChainId = new Map<number, StoredChain>();
  try {
    const existing = JSON.parse(fs.readFileSync(discoveredPath(), "utf8"));
    if (Array.isArray(existing)) {
      for (const entry of existing) {
        if (defFromDiscovered(entry)) byChainId.set((entry as StoredChain).chainId, entry as StoredChain);
      }
    }
  } catch {
    // No file yet, or an unreadable one: this scan's finds become the file.
  }
  for (const entry of found) byChainId.set(entry.chainId, entry);

  try {
    fs.mkdirSync(path.dirname(discoveredPath()), { recursive: true });
    fs.writeFileSync(discoveredPath(), JSON.stringify([...byChainId.values()], null, 2), "utf8");
  } catch (err) {
    // Losing the cache costs a slower first report, not an answer.
    console.error("[chains] не удалось сохранить найденные сети:", err);
  }
}

/** How often the table is refreshed. Chains launch weekly, not hourly. */
const REDISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Runs discovery now and once a day after that. Returns a stop function.
 *
 * Deliberately not awaited at startup: a slow or rate-limited token API
 * would otherwise delay the bot answering at all, and the chains it would
 * add are the long tail, not the ones anyone asks about first.
 */
export function startChainDiscovery(): () => void {
  const run = () => {
    discoverChains()
      .then((report) => {
        if (report.error) {
          console.error(`[chains] не удалось получить список сетей: ${report.error}`);
          return;
        }
        console.log(
          `[chains] CoinGecko знает ${report.listed} EVM-сетей, из них было ${report.known}; ` +
            `добавлено ${report.added.length}, отклонено ${report.rejected.length}, ` +
            `уже были ${report.duplicates}, всего ${CHAINS.length}`
        );
        for (const chain of report.added) console.log(`[chains] + ${chain.label} (${chain.chainId}) ${chain.rpcUrl}`);
      })
      .catch((err) => console.error("[chains] discovery failed:", err));
  };

  run();
  const timer = setInterval(run, REDISCOVERY_INTERVAL_MS);
  return () => clearInterval(timer);
}
