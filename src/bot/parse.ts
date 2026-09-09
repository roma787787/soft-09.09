import { isAddress, type Address } from "viem";
import { resolveChain } from "../config/chains";

export interface ParsedArgs {
  address?: Address;
  chainKey?: string;
  error?: string;
}

/** Parses "<address> [chain]" style command arguments. */
export function parseAddressChainArgs(text: string): ParsedArgs {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  // parts[0] is the command itself (e.g. "/info"), drop it.
  const args = parts.slice(1);

  if (args.length === 0) {
    return { error: "Укажите адрес контракта." };
  }

  const rawAddress = args[0];
  // strict:false skips EIP-55 checksum validation. Length and hex shape are
  // still enforced; without this, an address pasted with non-canonical
  // capitalisation (common when copying from chats or docs) is rejected as
  // "invalid", which is confusing and not actually true.
  if (!isAddress(rawAddress, { strict: false })) {
    return { error: `«${rawAddress}» не похож на корректный EVM-адрес.` };
  }

  let chainKey: string | undefined;
  if (args[1]) {
    const chain = resolveChain(args[1]);
    if (!chain) {
      return { error: `Неизвестная сеть «${args[1]}». Доступные: ethereum, arbitrum, optimism, base, polygon, bsc, avalanche.` };
    }
    chainKey = chain.key;
  }

  return { address: rawAddress as Address, chainKey };
}
