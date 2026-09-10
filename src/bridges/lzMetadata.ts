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

let cache: { at: number; data: Map<string, number> } | undefined;
let inFlight: Promise<Map<string, number>> | undefined;

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

  const byNativeId = new Map<number, string>();
  for (const chain of CHAINS) byNativeId.set(chain.viemChain.id, chain.key);

  for (const [rawKey, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, any>;

    // The EVM chain id is a number both sides already agree on; the name is
    // the fallback, and only where our own alias table recognises it.
    const nativeId = Number(entry.chainDetails?.nativeChainId ?? entry.nativeChainId);
    const chainKey =
      (Number.isFinite(nativeId) ? byNativeId.get(nativeId) : undefined) ?? resolveChain(rawKey)?.key;
    if (!chainKey || found.has(chainKey)) continue;

    const eid = pickV2Eid(entry);
    if (eid !== undefined) found.set(chainKey, eid);
  }

  return found;
}

/**
 * V2 eids are V1's chain ids plus 30000, so the number itself says which
 * generation it belongs to. That makes the version field unnecessary to
 * trust: a value in the V2 range is a V2 eid whatever it is labelled.
 */
function pickV2Eid(entry: Record<string, any>): number | undefined {
  const deployments = Array.isArray(entry.deployments) ? entry.deployments : [];
  for (const deployment of deployments) {
    const eid = Number(deployment?.eid);
    if (Number.isFinite(eid) && eid > 30000 && eid < 31000) return eid;
  }

  const direct = Number(entry.eid);
  return Number.isFinite(direct) && direct > 30000 && direct < 31000 ? direct : undefined;
}
