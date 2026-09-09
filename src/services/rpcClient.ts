import { createPublicClient, http, type PublicClient } from "viem";
import { CHAINS, getChain } from "../config/chains";
import { rpcUrlFor } from "../config/env";

const clients = new Map<string, PublicClient>();

export function getClient(chainKey: string): PublicClient {
  const cached = clients.get(chainKey);
  if (cached) return cached;

  const chain = getChain(chainKey);
  if (!chain) throw new Error(`Unknown chain "${chainKey}"`);

  const client = createPublicClient({
    chain: chain.viemChain,
    transport: http(rpcUrlFor(chainKey), { timeout: 15_000 }),
  });
  clients.set(chainKey, client);
  return client;
}

export function allChainKeysWithClients(): string[] {
  return CHAINS.map((c) => c.key);
}
