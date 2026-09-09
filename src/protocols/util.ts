import type { Abi, Address, PublicClient } from "viem";
import { BaseError, HttpRequestError, TimeoutError } from "viem";
import { getChain } from "../config/chains";

/** Raised when a read failed because the node did not answer, not because
 * the contract lacks that function. */
export class RpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTransportError";
  }
}

/**
 * Distinguishes "the node refused or timed out" from "this contract has no
 * such function". Both arrive here as an exception, and treating them alike
 * is what makes a rate-limited node look like a contract that is not a
 * bridge: the probes come back empty and the answer silently degrades.
 * Only clear transport failures count, so a revert or an empty return still
 * reads as "function absent".
 */
export function isTransportError(err: unknown): boolean {
  if (err instanceof BaseError) {
    const hit = err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError);
    if (hit) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /fetch failed|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|timed out|too many requests|rate limit/i.test(
    message
  );
}

/** Calls a view function and returns undefined instead of throwing on revert/missing function. */
export async function safeRead<T>(
  client: PublicClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = []
): Promise<T | undefined> {
  try {
    const result = await client.readContract({ address, abi, functionName, args } as any);
    return result as T;
  } catch (err) {
    if (isTransportError(err)) {
      throw new RpcTransportError(`${functionName}(): нода не ответила`);
    }
    return undefined;
  }
}

/** True if the given bytes32/address value is not the zero value. */
export function isNonZero(value: string | undefined): value is string {
  if (!value) return false;
  return /[1-9a-f]/i.test(value.replace(/^0x/, ""));
}

/** Decodes a bytes32 peer value holding a 20-byte EVM address, left-padded. */
export function bytes32ToAddress(value: string): Address {
  return `0x${value.slice(-40)}` as Address;
}

/**
 * True when a bytes32 value actually holds a left-padded EVM address, i.e.
 * its leading 12 bytes are zero. Cross-chain protocols store addresses of
 * non-EVM chains (Solana, Aptos, Sui) in the full 32 bytes, and truncating
 * those to 20 bytes yields a plausible-looking but meaningless address.
 */
export function isEvmAddressBytes32(value: string): boolean {
  const hex = value.replace(/^0x/, "").padStart(64, "0");
  if (hex.length !== 64) return false;
  return /^0{24}$/.test(hex.slice(0, 24)) && isNonZero(hex.slice(24));
}

export function chainLabel(chainKey: string | undefined, fallback: string): string {
  if (!chainKey) return fallback;
  return getChain(chainKey)?.label ?? fallback;
}
