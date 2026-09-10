import { Connection } from "@solana/web3.js";
import { getSvmChain } from "../config/svmChains";

/**
 * One cached connection per non-EVM chain, mirroring how rpcClient caches
 * viem clients. There is no fallback transport here the way viem provides
 * one, so the endpoints are tried in order by hand when a call fails.
 */
const clients = new Map<string, Connection[]>();

export function getSvmClients(chainKey: string): Connection[] {
  const cached = clients.get(chainKey);
  if (cached) return cached;

  const chain = getSvmChain(chainKey);
  if (!chain) throw new Error(`Неизвестная не-EVM сеть "${chainKey}"`);

  const configured = process.env[chain.rpcEnvVar]?.trim();
  const urls = configured ? [configured, ...chain.defaultRpcUrls] : [...chain.defaultRpcUrls];
  const built = urls.map((url) => new Connection(url, "confirmed"));
  clients.set(chainKey, built);
  return built;
}

/**
 * Runs a call against each endpoint until one answers. A public Solana
 * endpoint refusing a datacenter IP is the normal case rather than the
 * exception, and a chain dropping out of the report reads as "no liquidity
 * here" - the opposite of what it means.
 */
export async function withSvmClient<T>(chainKey: string, fn: (c: Connection) => Promise<T>): Promise<T> {
  const connections = getSvmClients(chainKey);
  let lastError: unknown;
  for (const connection of connections) {
    try {
      return await fn(connection);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("нет доступных узлов");
}
