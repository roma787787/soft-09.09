import type { Abi, Address, PublicClient } from "viem";
import { getChain } from "../config/chains";

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
  } catch {
    return undefined;
  }
}

/** True if the given bytes32/address value is not the zero value. */
export function isNonZero(value: string | undefined): value is string {
  if (!value) return false;
  return /[1-9a-f]/i.test(value.replace(/^0x/, ""));
}

/** Decodes a LayerZero/Hyperlane style bytes32 peer value (right-padded... actually left-padded) EVM address. */
export function bytes32ToAddress(value: string): Address {
  // Peer values store a 20-byte EVM address left-padded to 32 bytes.
  return `0x${value.slice(-40)}` as Address;
}

export function chainLabel(chainKey: string | undefined, fallback: string): string {
  if (!chainKey) return fallback;
  return getChain(chainKey)?.label ?? fallback;
}
