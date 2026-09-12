import { SUI_CHAIN } from "../config/suiChain";
import { endpointsWithOverride } from "../config/env";

/**
 * Sui's JSON-RPC, over plain fetch.
 *
 * No SDK: every call this bot makes to Sui is a read with a two-field
 * result, and the official client library brings a transaction builder, a
 * keypair implementation and a BCS codec to serve them. The endpoints are
 * walked in order the same way the Solana reader walks its own, because a
 * public node refusing a datacenter IP is the normal case rather than the
 * exception.
 */

const TIMEOUT_MS = 10_000;

export class SuiRpcError extends Error {}

/**
 * Whether an RPC error is about this node rather than about the request.
 *
 * The distinction decides whether trying the next endpoint can help. A node
 * that does not implement a method, is rate-limiting, or is overloaded will
 * be answered differently by the node beside it; a malformed argument will
 * not. Treating every RPC error as final meant one endpoint's "method not
 * found" ended the read for all three.
 */
export function isNodeLevelError(code: unknown, message: string): boolean {
  if (code === -32601 || code === -32603 || code === -32000 || code === -32005) return true;
  return /method not found|not supported|unsupported|rate ?limit|too many requests|overload|unavailable|try again/i.test(
    message
  );
}

/** Set by the caller when it wants a node other than the configured ones. */
export function suiEndpoints(): string[] {
  return endpointsWithOverride(SUI_CHAIN.rpcEnvVar, [...SUI_CHAIN.defaultRpcUrls]);
}

/**
 * One JSON-RPC call, tried against each endpoint until one answers.
 *
 * A node that answers with an RPC error has answered: the request reached
 * Sui and Sui rejected it, which is a fact about the request and will be
 * the same everywhere. Retrying that against three more nodes turns one
 * wrong question into four, and hides the answer behind a transport error
 * the reader can do nothing about. So only a failure to reach a node moves
 * on to the next one.
 */
export async function suiCall<T>(method: string, params: unknown[]): Promise<T> {
  const endpoints = suiEndpoints();
  let lastTransportError: unknown;

  for (const url of endpoints) {
    let payload: any;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        lastTransportError = new Error(`${url} ответил ${response.status}`);
        continue;
      }
      payload = await response.json();
    } catch (err) {
      lastTransportError = err;
      continue;
    }

    if (payload?.error) {
      const message = String(payload.error.message ?? payload.error.code ?? "ошибка RPC");
      // Only a request-level error is final. Anything that is a property of
      // this particular node gets the next one a chance.
      if (isNodeLevelError(payload.error.code, message)) {
        lastTransportError = new SuiRpcError(message);
        continue;
      }
      throw new SuiRpcError(message);
    }
    return payload?.result as T;
  }

  throw lastTransportError ?? new Error("ни один узел Sui не ответил");
}
