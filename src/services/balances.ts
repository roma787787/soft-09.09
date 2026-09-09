import type { Address } from "viem";
import { getClient } from "./rpcClient";
import type { Custodian } from "../bridges/types";

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export interface CustodianBalance extends Custodian {
  amount: bigint;
  decimals: number;
}

/** Cached per chain+token: decimals never change for a deployed ERC-20. */
const decimalsCache = new Map<string, number>();

async function readDecimals(chainKey: string, token: Address): Promise<number> {
  const key = `${chainKey}:${token.toLowerCase()}`;
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;

  const value = (await getClient(chainKey).readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "decimals",
  })) as number;
  decimalsCache.set(key, value);
  return value;
}

export interface BalanceReport {
  balances: CustodianBalance[];
  /** Chains whose node did not answer, so their rows are missing. */
  failedChains: string[];
}

/**
 * Reads how much of the token each custody contract currently holds.
 *
 * A chain that fails is dropped rather than allowed to fail the whole
 * report, and named separately: a missing row must never read as "there is
 * no liquidity here", which is the opposite of the truth.
 */
/** A widely bridged token has 100+ custodians; firing them all at once is
 * a reliable way to get rate-limited by every node at the same time. */
const MAX_CONCURRENT_READS = 12;

export async function readCustodianBalances(custodians: Custodian[]): Promise<BalanceReport> {
  const failedChains = new Set<string>();

  const readOne = async (c: Custodian): Promise<CustodianBalance | undefined> => {
    try {
      const [amount, decimals] = await Promise.all([
          getClient(c.chainKey).readContract({
            address: c.tokenAddress,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [c.custodyAddress],
          }) as Promise<bigint>,
          readDecimals(c.chainKey, c.tokenAddress),
        ]);
        return { ...c, amount, decimals };
      } catch (err) {
        failedChains.add(c.chainKey);
        return undefined;
      }
  };

  const results: Array<CustodianBalance | undefined> = [];
  for (let i = 0; i < custodians.length; i += MAX_CONCURRENT_READS) {
    const batch = custodians.slice(i, i + MAX_CONCURRENT_READS);
    results.push(...(await Promise.all(batch.map(readOne))));
  }

  return {
    balances: results.filter((b): b is CustodianBalance => b !== undefined),
    failedChains: [...failedChains],
  };
}

/** Formats a raw token amount the way the spec's example does: 1 250 000. */
export function formatAmount(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const remainder = amount % base;

  const wholeText = whole.toLocaleString("ru-RU").replace(/ /g, " ");
  if (remainder === 0n) return wholeText;

  // Show enough of the fraction to distinguish "almost nothing" from zero,
  // which matters when the question is whether a withdrawal will go through.
  const fraction = remainder.toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  return fraction ? `${wholeText},${fraction}` : wholeText;
}
