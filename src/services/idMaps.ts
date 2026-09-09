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

let lzCache: CachedMap | undefined;
let hyperlaneCache: CachedMap | undefined;
let wormholeCache: CachedMap | undefined;
let cctpCache: CachedMap | undefined;

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

function isFresh(cache: CachedMap | undefined): cache is CachedMap {
  return !!cache && Date.now() - cache.builtAt < TTL_MS;
}

export async function getLzEidMap(): Promise<CachedMap> {
  if (isFresh(lzCache)) return lzCache;
  lzCache = await buildMap(async (chainKey) => {
    const client = getClient(chainKey);
    return (await client.readContract({
      address: LZ_ENDPOINT_V2,
      abi: EID_ABI,
      functionName: "eid",
    })) as number;
  }, LZ_V2_EID_BY_CHAIN);
  return lzCache;
}

export async function getHyperlaneDomainMap(): Promise<CachedMap> {
  if (isFresh(hyperlaneCache)) return hyperlaneCache;
  hyperlaneCache = await buildMap(async (chainKey) => {
    const mailbox = HYPERLANE_MAILBOX_BY_CHAIN[chainKey];
    if (!mailbox) return undefined;
    const client = getClient(chainKey);
    return (await client.readContract({
      address: mailbox,
      abi: LOCAL_DOMAIN_ABI,
      functionName: "localDomain",
    })) as number;
  }, HYPERLANE_DOMAIN_BY_CHAIN);
  return hyperlaneCache;
}

export async function getWormholeChainIdMap(): Promise<CachedMap> {
  if (isFresh(wormholeCache)) return wormholeCache;
  wormholeCache = await buildMap(async (chainKey) => {
    const bridge = PORTAL_TOKEN_BRIDGE_BY_CHAIN[chainKey];
    if (!bridge) return undefined;
    const client = getClient(chainKey);
    return (await client.readContract({
      address: bridge,
      abi: WH_CHAIN_ID_ABI,
      functionName: "chainId",
    })) as number;
  }, WORMHOLE_CHAIN_ID_BY_CHAIN);
  return wormholeCache;
}

export async function getCctpDomainMap(): Promise<CachedMap> {
  if (isFresh(cctpCache)) return cctpCache;
  cctpCache = await buildMap(async (chainKey) => {
    const transmitter = CCTP_MESSAGE_TRANSMITTER_BY_CHAIN[chainKey];
    if (!transmitter) return undefined;
    const client = getClient(chainKey);
    return (await client.readContract({
      address: transmitter,
      abi: LOCAL_DOMAIN_ABI,
      functionName: "localDomain",
    })) as number;
  }, CCTP_DOMAIN_BY_CHAIN);
  return cctpCache;
}
