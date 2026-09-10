import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { CHAINS, getChain } from "../config/chains";
import { rpcUrlsFor } from "../config/env";

const clients = new Map<string, PublicClient>();

/**
 * How many endpoints one chain's fallback carries. The generated list runs
 * to twelve for some chains, and every one of them past the first few is a
 * timeout waiting to be paid rather than redundancy worth having.
 */
export const MAX_ENDPOINTS_PER_CHAIN = 6;

/**
 * One client per chain, backed by viem's fallback transport: endpoints are
 * tried in order and a failing one is skipped for the next. Free public
 * nodes frequently reject requests from datacenter IPs (403/429), which is
 * exactly where this bot runs, so a single endpoint is a single point of
 * failure.
 */
export function getClient(chainKey: string): PublicClient {
  const cached = clients.get(chainKey);
  if (cached) return cached;

  const chain = getChain(chainKey);
  if (!chain) throw new Error(`Unknown chain "${chainKey}"`);

  // Six seconds per node, no retry, at most six nodes.
  //
  // fallback walks its endpoints in order and gives each one a full timeout
  // before moving on, so the cost of a dead node is paid before a healthy
  // one is ever asked. At twelve seconds with a retry that is twenty-four
  // seconds per dead node, and Metis lists twelve nodes: a single balance
  // read on a chain whose first few endpoints are down could spend four
  // minutes failing. The chain then vanishes from the report, where a
  // missing chain reads as "no liquidity here" rather than as nodes that
  // said no.
  //
  // Six and six bounds the worst case at thirty-six seconds while leaving
  // five alternates behind the one that matters - and a node that needs
  // more than six seconds for one call cannot serve the dozen a bridge
  // sweep asks it anyway.
  const transports = rpcUrlsFor(chainKey)
    .slice(0, MAX_ENDPOINTS_PER_CHAIN)
    .map((url) => http(url, { timeout: 6_000, retryCount: 0 }));

  const client = createPublicClient({
    chain: chain.viemChain,
    transport: fallback(transports, { rank: false, retryCount: 0 }),
  });
  clients.set(chainKey, client);
  return client;
}

export function allChainKeysWithClients(): string[] {
  return CHAINS.map((c) => c.key);
}
