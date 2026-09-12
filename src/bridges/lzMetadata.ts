import { CHAINS, resolveChain, getChainByChainId } from "../config/chains";
import { LZ_V2_EID_BY_CHAIN } from "../protocols/addresses/layerzero";

/**
 * Chain ids for names the OFT registry uses and the chain metadata does not
 * publish, so the id lookup has nothing to match on.
 *
 * Not a general alias table and not the mechanism: the metadata's own chain
 * ids resolve 66 of 75 chains and keep resolving new ones by themselves.
 * These are the leftovers, where the registry files a chain under a name
 * that appears nowhere else - Linea as "zkconsensys" was losing all
 * twenty-two of its deployments to it. Each entry is a chain id, never a
 * chain key, and it stops mattering on its own the day the metadata
 * publishes the name.
 *
 * A chain id here is also enough to go and add the chain: see
 * registryOnlyCandidates below.
 */
export const REGISTRY_CHAIN_IDS: Record<string, number> = {
  zkconsensys: 59144, // Linea
  zkpolygon: 1101, // Polygon zkEVM
  // LayerZero's two sources disagree: its OFT registry files deployments on
  // these seven chains and its own chain metadata describes none of them, so
  // the id lookup had nothing to match on and the alias table had nothing
  // either - the registry's short names are not what anyone else calls them.
  // Seven deployments the registry itself marks as holding collateral were
  // invisible in every report because of it. /lzgaps is what found them.
  etherlink: 42793,
  xdc: 50, // XDC Network
  sanko: 1996,
  apexfusionnexus: 9069, // Apex Fusion - Nexus
  goat: 2345, // GOAT Network
  iota: 8822, // IOTA EVM
  glue: 1300,
};

/**
 * LayerZero's chain metadata, used to learn the eid of a chain the bot
 * cannot ask directly.
 *
 * EndpointV2 sits at the same address on most chains, so asking it for eid()
 * usually works. It does not work everywhere: zk-rollups compile contracts
 * differently, so deterministic deployment does not hold there and the
 * endpoint lives at a chain-specific address. Twenty-one of forty-two chains
 * resolved this way, and a chain with no eid is a chain the peer walk cannot
 * ask about - the deployment there stays invisible.
 *
 * The published metadata knows every chain's eid regardless of where its
 * endpoint was deployed, which closes that gap without a single address
 * being written down here.
 */
const METADATA_URL = process.env.LAYERZERO_METADATA_URL || "https://metadata.layerzero-api.com/v1/metadata";

const TTL_MS = 6 * 60 * 60 * 1000;

/** How many chains the payload held, matched or not. */
let lastSeen = 0;

interface RawEntry {
  key: string;
  nativeChainId?: number;
  eids: number[];
  /** Top-level field names, so an unread shape can be described. */
  fields: string[];
}

/**
 * A chain LayerZero says it is deployed on, described well enough to add.
 *
 * Discovery used to take its candidates from the price API alone, and the
 * price API lists the chains that have tokens worth pricing. Sanko, Glue and
 * Apex Fusion Nexus are none of them - and all three carry Stargate pools,
 * which is precisely the thing this bot is for. A chain a bridge it reads is
 * deployed on belongs in the table whether or not anyone prices it.
 */
export interface LzChainCandidate {
  /** LayerZero's own name for the chain, folded: stable across restarts. */
  slug: string;
  chainId: number;
  name: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  explorerUrl?: string;
}

/**
 * A light index of the last payload, kept so a chain that did not match can
 * be explained rather than merely counted. "38 of 42" says nothing about the
 * other four: absent from the source, listed under a name we do not
 * recognise, and deployed on V1 only are three different situations, and
 * only one of them is ours to fix.
 */
let lastEntries: RawEntry[] = [];

/**
 * Total chains in the last metadata response. Without it, "38 chains" cannot
 * be read: it does not say whether the other four were absent from the
 * source or present under a name we failed to match, which are different
 * problems.
 */
export function lastMetadataChainCount(): number {
  return lastSeen;
}

/** Every EVM mainnet the last payload described, whether the bot has it. */
let lastCandidates: LzChainCandidate[] = [];

/**
 * The chains LayerZero is deployed on, for discovery to consider adding.
 *
 * Shares the one cached fetch with the eid lookup - the payload is the same
 * payload, and a scan must not cost a second download of it.
 */
export async function lzChainCandidates(): Promise<LzChainCandidate[]> {
  await fetchLzEidsFromMetadata();
  return lastCandidates;
}

/** Names LayerZero gives a network that is not the real one. */
const NOT_MAINNET = /testnet|sandbox|devnet|staging|local/i;

/**
 * Pure half, so the shape is covered by a test rather than only by a live
 * call - and it is worth covering, because everything read here is optional.
 * A payload that dropped `rpcs` would otherwise quietly stop discovering
 * chains, and "found nothing new" is exactly what a working scan says too.
 */
export function candidatesFrom(payload: unknown): LzChainCandidate[] {
  if (!payload || typeof payload !== "object") return [];

  const byId = new Map<number, LzChainCandidate>();
  for (const [rawKey, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, any>;
    const details = (entry.chainDetails ?? {}) as Record<string, any>;

    // Only where LayerZero is actually deployed. An entry without one is a
    // description of a network, not a bridge on it, and adding it would put
    // a chain in the table that no bridge the bot reads can reach.
    if (deploymentsOf(entry).length === 0) continue;

    // Play money under a real chain's name is the one outcome worse than a
    // missing chain, so every hint of a testnet is refused: the declared
    // environment, the chain type, and the name itself.
    const environment = String(details.environment ?? entry.environment ?? "");
    if (environment && environment.toLowerCase() !== "mainnet") continue;
    if (NOT_MAINNET.test(rawKey) || NOT_MAINNET.test(String(details.name ?? ""))) continue;

    // Non-EVM chains are reached by their own readers, not by an RPC url and
    // a chain id, so they are not discovery's to add. Where the type is not
    // stated, a plausible EVM chain id is the same evidence.
    const chainType = String(details.chainType ?? entry.chainType ?? "").toLowerCase();
    if (chainType && chainType !== "evm") continue;

    const chainId = Number(details.nativeChainId ?? entry.nativeChainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) continue;

    const slug = normaliseLzKey(rawKey);
    if (!slug) continue;

    const token = details.nativeCurrency ?? entry.nativeCurrency;
    const candidate: LzChainCandidate = {
      slug,
      chainId,
      name: String(details.name ?? entry.name ?? rawKey),
      nativeCurrency:
        token && typeof token === "object" && typeof token.symbol === "string"
          ? {
              name: String(token.name ?? token.symbol),
              symbol: String(token.symbol),
              decimals: Number.isInteger(token.decimals) ? token.decimals : 18,
            }
          : undefined,
      rpcUrls: urlsOf(entry.rpcs).filter((u) => !/\$\{|API_KEY/i.test(u)),
      explorerUrl: urlsOf(entry.blockExplorers)[0],
    };

    // One entry per chain id. LayerZero lists a chain more than once when it
    // has several deployments, and the richer description wins rather than
    // whichever happened to come last.
    const seen = byId.get(chainId);
    if (!seen || seen.rpcUrls.length < candidate.rpcUrls.length) byId.set(chainId, candidate);
  }

  return [...byId.values()];
}

/** `[{ url }]` in the payload, and defensive about it not being that. */
function urlsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls = value
    .map((item) => (typeof item === "string" ? item : (item as { url?: unknown })?.url))
    .filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
    .map((u) => u.replace(/\/+$/, ""));
  return [...new Set(urls)];
}

let cache: { at: number } | undefined;
let inFlight: Promise<Map<string, number>> | undefined;

/**
 * LayerZero's own name for a chain, folded to something comparable.
 *
 * Its registry files Linea under "zkconsensys", Polygon zkEVM under
 * "zkpolygon" and Plume under "plumephoenix" - names no alias table would
 * have guessed, and resolveChain answered nothing for every one of them. A
 * deployment on such a chain was dropped from every report, silently, even
 * though the bot has an RPC for the chain and could read it.
 */
export function normaliseLzKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/mainnet$/, "");
}

/** LayerZero's name for a chain -> ours, built from the chain id both agree on. */
let keyIndex = new Map<string, string>();

/**
 * The name index, loaded if it is not already.
 *
 * Matching on the EVM chain id rather than on a spelling is the same
 * decision the price API's platform lookup makes, and for the same reason:
 * a chain id is a number both sides agree on, where a name is a spelling one
 * side invents and the other has to guess.
 */
export async function lzChainKeyIndex(): Promise<Map<string, string>> {
  await fetchLzEidsFromMetadata();

  // The written-down ids fill in behind the metadata, never over it.
  const index = new Map(keyIndex);
  for (const [name, chainId] of Object.entries(REGISTRY_CHAIN_IDS)) {
    const chain = getChainByChainId(chainId);
    if (chain && !index.has(name)) index.set(name, chain.key);
  }
  return index;
}

/**
 * The registry's chains that the bot's table does not have, ready to be
 * added.
 *
 * The chains discovery looks at come from the price API and from LayerZero's
 * chain metadata, and Sanko and Glue are in neither: nobody prices tokens
 * there, and the metadata does not describe them - which is why they are in
 * the table above at all. But the OFT registry files deployments on them,
 * three of which it marks as locking collateral, and the id above is all a
 * chain registry needs to describe a chain. So the same table that lets a
 * name be recognised also lets the chain be found.
 *
 * Only the ids, and only for chains not already present: everything else
 * about the chain - its name, its nodes, whether it is a testnet - comes
 * from the registries discovery already consults, which is what decides
 * whether it gets in.
 */
export function registryOnlyCandidates(): { slug: string; chainId: number; name: string }[] {
  return Object.entries(REGISTRY_CHAIN_IDS)
    .filter(([, chainId]) => !getChainByChainId(chainId))
    .map(([name, chainId]) => ({ slug: name, chainId, name }));
}

export async function fetchLzEidsFromMetadata(): Promise<Map<string, number>> {
  // Rebuilt from the cached payload rather than returned from cache. The
  // download is what the six-hour window is for; the mapping is cheap and
  // depends on a chain table that keeps growing under it.
  if (cache && Date.now() - cache.at < TTL_MS && haveEntries()) return indexEntries();
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(METADATA_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = extractEids(await response.json());
      cache = { at: Date.now() };
      console.log(`[layerzero] eid из метаданных: ${data.size} сетей`);
      return data;
    } catch (err) {
      console.error("[layerzero] не удалось загрузить метаданные сетей:", err);
      // A failed refresh falls back to the last payload read, re-indexed
      // against the table as it stands - not to a mapping from whenever that
      // payload arrived.
      return haveEntries() ? indexEntries() : new Map();
    } finally {
      inFlight = undefined;
    }
  })();

  return inFlight;
}

/**
 * Pure half of the lookup. The response shape is not something this code can
 * verify from here, so it is read defensively: a chain is matched by its EVM
 * chain id where one is given and by name otherwise, and anything that does
 * not yield a plausible V2 eid is skipped rather than guessed at.
 */
export function extractEids(payload: unknown): Map<string, number> {
  if (!payload || typeof payload !== "object") return new Map();
  lastSeen = Object.keys(payload as Record<string, unknown>).length;
  lastEntries = [];
  lastCandidates = candidatesFrom(payload);

  for (const [rawKey, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    remember(rawKey, value as Record<string, any>);
  }

  return indexEntries();
}

/**
 * The chain-key mapping, built from the stored facts against the table as it
 * stands right now.
 *
 * Not once, when the payload arrives. The metadata is fetched at startup and
 * cached for six hours, while the chain table is discovered in the
 * background and takes minutes to fill - so a mapping frozen at parse time
 * was built against forty chains and then answered for two hundred and
 * fifty. Forty-eight chains had an eid sitting in the payload, under a name
 * matching theirs, and no eid as far as the bot was concerned: /lzchains
 * said "есть как «etherlink» с eid 30292 — сопоставление не сработало" and
 * it was right, forty-eight times over. The peer walk cannot go where there
 * is no eid, so every one of them was unreachable for six hours at a time.
 *
 * The facts in lastEntries do not depend on our table, so rebuilding costs
 * a walk over five hundred small records and nothing else.
 */
function indexEntries(): Map<string, number> {
  const found = new Map<string, number>();
  keyIndex = new Map();

  const byNativeId = new Map<number, string>();
  for (const chain of CHAINS) byNativeId.set(chain.viemChain.id, chain.key);

  for (const entry of lastEntries) {
    const rawKey = entry.key;

    // A testnet entry never supplies a mainnet chain's eid. LayerZero's
    // metadata carries an entry keyed "astar-testnet" declaring the chain id
    // of Japan Open Chain, and matching on the id alone handed joc that
    // entry's eid - so the peer walk would have asked a real contract about
    // a network it has nothing to do with, and any peer that came back would
    // have been printed as this token's adapter. No eid is a gap the report
    // states plainly; a wrong one is a row with a real balance under the
    // wrong name. Discovery already refuses these entries; this is the same
    // filter on the other half of the same payload.
    if (NOT_MAINNET.test(rawKey)) continue;

    const nativeId = entry.nativeChainId;
    const chainKey =
      (nativeId !== undefined ? byNativeId.get(nativeId) : undefined) ?? resolveChain(rawKey)?.key;
    if (!chainKey) continue;

    const eid = entry.eids.find((e) => e > 30000 && e < 31000);

    // A chain id is only unique among EVM chains. Aptos numbers its own
    // mainnet 1 - the number Ethereum uses - so matching on it alone filed
    // Aptos under Ethereum and reported it as a chain the bot reads. Where
    // the eid is known independently, the entry has to agree with it; a
    // different eid means a different chain reusing the number.
    const knownEid = LZ_V2_EID_BY_CHAIN[chainKey];
    if (knownEid !== undefined && eid !== undefined && eid !== knownEid) continue;

    // Recorded even when this chain's eid is already known from another
    // entry: the name is what the OFT registry keys its deployments by, and
    // a name left out of the index is a chain whose deployments keep being
    // dropped no matter how well its eid is known.
    keyIndex.set(normaliseLzKey(rawKey), chainKey);
    if (found.has(chainKey)) continue;

    if (eid !== undefined) found.set(chainKey, eid);
  }

  return found;
}

/** True once a payload has been read, however the table looked at the time. */
function haveEntries(): boolean {
  return lastEntries.length > 0;
}

/**
 * The mapping as of right now, from the payload already in hand.
 *
 * Callers that await several things before rendering should ask for it at
 * the end rather than keep what an await handed them. The table fills in
 * the background and the gap is largest exactly when someone is looking:
 * the first command after a restart parses the metadata against a table of
 * a hundred and forty chains, spends seconds on the other awaits while
 * discovery finishes, and then prints against a table of two hundred and
 * fifty. That is 98 chains with an eid where the payload holds 144, and it
 * looked like the rebuild had not worked at all.
 */
export function lzEidsNow(): Map<string, number> {
  return haveEntries() ? indexEntries() : new Map();
}

/**
 * The deployments of one chain entry. Usually an array; Boba's entry is not,
 * and a shape this reader does not accept is indistinguishable from a chain
 * with nothing deployed on it - which is the wrong conclusion to draw
 * silently.
 */
function deploymentsOf(entry: Record<string, any>): any[] {
  if (Array.isArray(entry.deployments)) return entry.deployments;
  if (entry.deployments && typeof entry.deployments === "object") return Object.values(entry.deployments);
  return [];
}

/** Records every entry, matched or not, so a miss can be accounted for. */
function remember(key: string, entry: Record<string, any>): void {
  const nativeChainId = Number(entry.chainDetails?.nativeChainId ?? entry.nativeChainId);
  const deployments = deploymentsOf(entry);
  const eids = deployments.map((d: any) => Number(d?.eid)).filter((n: number) => Number.isFinite(n));
  const direct = Number(entry.eid);
  if (Number.isFinite(direct)) eids.push(direct);

  lastEntries.push({
    key,
    nativeChainId: Number.isFinite(nativeChainId) ? nativeChainId : undefined,
    eids,
    fields: Object.keys(entry),
  });
}

/**
 * Why a chain has no eid, in one sentence, from what the last payload held.
 */
export function explainMissing(chainKey: string, evmChainId: number): string {
  if (lastEntries.length === 0) return "метаданные не загружены";

  const byId = lastEntries.filter((e) => e.nativeChainId === evmChainId);
  // On a segment of the name, not on a substring of it. A raw includes()
  // matched ENI Mainnet against "plumephoenix" - the letters e-n-i sit
  // inside "phoenix" - and the report then said ENI has eid 30370 and the
  // matching is fixable, about Plume. A wrong lead in a diagnostic is worse
  // than none: it is the one the reader will follow.
  const wanted = chainKey.toLowerCase();
  const byName = lastEntries.filter((e) =>
    e.key
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((part) => part === wanted || part === `${wanted}mainnet`)
  );
  const hits = byId.length > 0 ? byId : byName;

  if (hits.length === 0) return "в метаданных этой сети нет — LayerZero туда не развёрнут";

  const eids = [...new Set(hits.flatMap((h) => h.eids))];
  if (eids.length === 0) {
    // An entry with no deployments field at all is a chain description, not
    // a chain LayerZero is on - a plain answer, and one worth giving plainly
    // rather than leaving to be inferred from a list of field names.
    if (!hits[0].fields.includes("deployments")) {
      return `есть как «${hits[0].key}», но деплоя LayerZero в ней не указано — только описание сети`;
    }
    // Otherwise the entry does carry deployments and this reader still found
    // no eid in them, which is a shape it does not handle: name the fields.
    const fields = hits[0].fields.slice(0, 8).join(", ") || "нет полей";
    return `есть как «${hits[0].key}», deployments есть, но eid не найден. Поля записи: ${fields}`;
  }

  const v2 = eids.filter((e) => e > 30000 && e < 31000);
  if (v2.length === 0) {
    return `есть как «${hits[0].key}», но только V1 (eid ${eids.join(", ")}) — обход пиров V2 туда не пойдёт`;
  }
  return `есть как «${hits[0].key}» с eid ${v2.join(", ")} — сопоставление не сработало, это чинится`;
}

/**
 * V2 eids are V1's chain ids plus 30000, so the number itself says which
 * generation it belongs to. That makes the version field unnecessary to
 * trust: a value in the V2 range is a V2 eid whatever it is labelled.
 */
function pickV2Eid(entry: Record<string, any>): number | undefined {
  const deployments = deploymentsOf(entry);
  for (const deployment of deployments) {
    const eid = Number(deployment?.eid);
    if (Number.isFinite(eid) && eid > 30000 && eid < 31000) return eid;
  }

  const direct = Number(entry.eid);
  return Number.isFinite(direct) && direct > 30000 && direct < 31000 ? direct : undefined;
}
