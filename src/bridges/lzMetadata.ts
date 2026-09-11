import { CHAINS, resolveChain } from "../config/chains";

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

let cache: { at: number; data: Map<string, number> } | undefined;
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
  return keyIndex;
}

export async function fetchLzEidsFromMetadata(): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(METADATA_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = extractEids(await response.json());
      cache = { at: Date.now(), data };
      console.log(`[layerzero] eid из метаданных: ${data.size} сетей`);
      return data;
    } catch (err) {
      console.error("[layerzero] не удалось загрузить метаданные сетей:", err);
      return cache?.data ?? new Map();
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
  const found = new Map<string, number>();
  if (!payload || typeof payload !== "object") return found;
  lastSeen = Object.keys(payload as Record<string, unknown>).length;
  lastEntries = [];
  keyIndex = new Map();

  const byNativeId = new Map<number, string>();
  for (const chain of CHAINS) byNativeId.set(chain.viemChain.id, chain.key);

  for (const [rawKey, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, any>;
    remember(rawKey, entry);

    // The EVM chain id is a number both sides already agree on; the name is
    // the fallback, and only where our own alias table recognises it.
    const nativeId = Number(entry.chainDetails?.nativeChainId ?? entry.nativeChainId);
    const chainKey =
      (Number.isFinite(nativeId) ? byNativeId.get(nativeId) : undefined) ?? resolveChain(rawKey)?.key;
    if (!chainKey) continue;

    // Recorded even when this chain's eid is already known from another
    // entry: the name is what the OFT registry keys its deployments by, and
    // a name left out of the index is a chain whose deployments keep being
    // dropped no matter how well its eid is known.
    keyIndex.set(normaliseLzKey(rawKey), chainKey);
    if (found.has(chainKey)) continue;

    const eid = pickV2Eid(entry);
    if (eid !== undefined) found.set(chainKey, eid);
  }

  return found;
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
  const byName = lastEntries.filter((e) => e.key.toLowerCase().includes(chainKey.toLowerCase()));
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
