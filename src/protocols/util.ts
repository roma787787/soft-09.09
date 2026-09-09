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
