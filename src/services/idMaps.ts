import { getClient } from "./rpcClient";
import { CHAINS } from "../config/chains";
import { LZ_ENDPOINT_V2, LZ_V2_EID_BY_CHAIN } from "../protocols/addresses/layerzero";
import { HYPERLANE_MAILBOX_BY_CHAIN, HYPERLANE_DOMAIN_BY_CHAIN } from "../protocols/addresses/hyperlane";
import { PORTAL_TOKEN_BRIDGE_BY_CHAIN, WORMHOLE_CHAIN_ID_BY_CHAIN } from "../protocols/addresses/portal";
import { CCTP_MESSAGE_TRANSMITTER_BY_CHAIN, CCTP_DOMAIN_BY_CHAIN } from "../protocols/addresses/transporter";

/**
 * Rather than trust hard-coded numeric protocol IDs (eid / domain / wormhole
 * chain id) for the chains this bot actually talks to, we ask each chain's
 * own infra contract what ITS id is, at runtime, and cache the answer. This
 * is the authoritative source for any chain we have an RPC client for. The
 * static tables in protocols/addresses/* are only used as a display label
 * for REMOTE chains we don't have an RPC connection to.
 */

const TTL_MS = 60 * 60 * 1000; // 1h

interface CachedMap {
  builtAt: number;
  chainKeyToId: Map<string, number>;
  idToChainKey: Map<number, string>;
}

interface CacheSlot {
  builtAt: number;
  value?: CachedMap;
  /** Set while a build is in progress, so concurrent callers share one build. */
  inFlight?: Promise<CachedMap>;
}

const slots = new Map<string, CacheSlot>();

const EID_ABI = [
  { type: "function", name: "eid", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
] as const;

const LOCAL_DOMAIN_ABI = [
  { type: "function", name: "localDomain", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
] as const;

const WH_CHAIN_ID_ABI = [
  { type: "function", name: "chainId", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

async function buildMap(
  fetcher: (chainKey: string) => Promise<number | undefined>,
  fallback: Record<string, number>
): Promise<CachedMap> {
  const chainKeyToId = new Map<string, number>();
  const idToChainKey = new Map<number, string>();

  await Promise.all(
    CHAINS.map(async (c) => {
      let id: number | undefined;
      try {
        id = await fetcher(c.key);
      } catch {
        id = undefined;
      }
      if (id === undefined) id = fallback[c.key];
      if (id !== undefined) {
        chainKeyToId.set(c.key, id);
        idToChainKey.set(id, c.key);
      }
    })
  );

  // Fill in labels for remote chains we have no RPC client for at all.
  for (const [key, id] of Object.entries(fallback)) {
    if (!idToChainKey.has(id)) idToChainKey.set(id, key);
  }

  return { builtAt: Date.now(), chainKeyToId, idToChainKey };
}

/**
 * Cached with single-flight semantics: an /info that scans every chain runs
 * all four detectors on all seven chains at once, and each of them asks for
 * these maps. Without sharing the in-flight promise, that first call would
 * kick off dozens of duplicate builds and hammer rate-limited public RPCs.
 */
async function cachedMap(
  key: string,
  fetcher: (chainKey: string) => Promise<number | undefined>,
  fallback: Record<string, number>
): Promise<CachedMap> {
  let slot = slots.get(key);
  if (!slot) {
    slot = { builtAt: 0 };
    slots.set(key, slot);
  }

  if (slot.value && Date.now() - slot.builtAt < TTL_MS) return slot.value;
  if (slot.inFlight) return slot.inFlight;

  const build = buildMap(fetcher, fallback)
    .then((map) => {
      slot!.value = map;
      slot!.builtAt = Date.now();
      return map;
    })
    .finally(() => {
      slot!.inFlight = undefined;
    });

  slot.inFlight = build;
  return build;
}

export async function getLzEidMap(): Promise<CachedMap> {
  return cachedMap(
    "layerzero",
    async (chainKey) => {
      const client = getClient(chainKey);
      return (await client.readContract({
        address: LZ_ENDPOINT_V2,
        abi: EID_ABI,
        functionName: "eid",
      })) as number;
    },
    LZ_V2_EID_BY_CHAIN
  );
}

export async function getHyperlaneDomainMap(): Promise<CachedMap> {
  return cachedMap(
    "hyperlane",
    async (chainKey) => {
      const mailbox = HYPERLANE_MAILBOX_BY_CHAIN[chainKey];
      if (!mailbox) return undefined;
      const client = getClient(chainKey);
      return (await client.readContract({
        address: mailbox,
        abi: LOCAL_DOMAIN_ABI,
        functionName: "localDomain",
      })) as number;
    },
    HYPERLANE_DOMAIN_BY_CHAIN
  );
}

export async function getWormholeChainIdMap(): Promise<CachedMap> {
  return cachedMap(
    "wormhole",
    async (chainKey) => {
      const bridge = PORTAL_TOKEN_BRIDGE_BY_CHAIN[chainKey];
      if (!bridge) return undefined;
      const client = getClient(chainKey);
      return (await client.readContract({
        address: bridge,
        abi: WH_CHAIN_ID_ABI,
        functionName: "chainId",
      })) as number;
    },
    WORMHOLE_CHAIN_ID_BY_CHAIN
  );
}

export async function getCctpDomainMap(): Promise<CachedMap> {
  return cachedMap(
    "cctp",
    async (chainKey) => {
      const transmitter = CCTP_MESSAGE_TRANSMITTER_BY_CHAIN[chainKey];
      if (!transmitter) return undefined;
      const client = getClient(chainKey);
      return (await client.readContract({
        address: transmitter,
        abi: LOCAL_DOMAIN_ABI,
        functionName: "localDomain",
      })) as number;
    },
    CCTP_DOMAIN_BY_CHAIN
  );
}
