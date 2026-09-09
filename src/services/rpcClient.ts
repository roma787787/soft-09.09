import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { CHAINS, getChain } from "../config/chains";
import { rpcUrlsFor } from "../config/env";

const clients = new Map<string, PublicClient>();

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

  const transports = rpcUrlsFor(chainKey).map((url) => http(url, { timeout: 12_000, retryCount: 1 }));

  const client = createPublicClient({
    chain: chain.viemChain,
    transport: fallback(transports, { rank: false, retryCount: 1 }),
  });
  clients.set(chainKey, client);
  return client;
}

export function allChainKeysWithClients(): string[] {
  return CHAINS.map((c) => c.key);
}
