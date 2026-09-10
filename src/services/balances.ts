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
  /**
   * How many reads failed per chain. A count, not a flag: one contract
   * timing out on a chain whose other twenty answered is a very different
   * fact from the whole chain being unreachable, and reporting both as
   * "could not check this chain" tells the user their data is missing when
   * most of it is right there in the report.
   */
  failuresByChain: Record<string, number>;
  /** How many reads were attempted per chain. */
  attemptsByChain: Record<string, number>;
}

/**
 * Reads how much of the token each custody contract currently holds.
 *
 * A chain that fails is dropped rather than allowed to fail the whole
 * report, and named separately: a missing row must never read as "there is
 * no liquidity here", which is the opposite of the truth.
 */
/**
 * Concurrency is per chain, not per report.
 *
 * Rate limits belong to a node, so that is the thing worth pacing. A single
 * global limit made every chain queue behind every other one: a widely
 * bridged token across forty-two chains is three hundred reads, and taking
 * them six at a time overall meant fifty sequential rounds while forty-one
 * nodes sat idle. Per chain, the same work is a handful of rounds, and no
 * node is asked for more at once than it was before.
 */
const MAX_CONCURRENT_PER_CHAIN = 4;

export async function readCustodianBalances(custodians: Custodian[]): Promise<BalanceReport> {
  const failuresByChain: Record<string, number> = {};
  const attemptsByChain: Record<string, number> = {};
  for (const c of custodians) {
    attemptsByChain[c.chainKey] = (attemptsByChain[c.chainKey] ?? 0) + 1;
  }

  const readOne = async (c: Custodian, attempt = 0): Promise<CustodianBalance | undefined> => {
    try {
      if (c.readsNativeCoin) {
          // The chain's own coin is not an ERC-20 and has no balanceOf; it
          // is always 18 decimals on the chains these pools live on.
          const amount = await getClient(c.chainKey).getBalance({ address: c.custodyAddress });
          return { ...c, amount, decimals: 18 };
        }

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
        // One retry: a public node under load refuses a request that
        // succeeds moments later, and a dropped row reads as "no liquidity
        // here", which is the opposite of what it means.
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return readOne(c, 1);
        }
        failuresByChain[c.chainKey] = (failuresByChain[c.chainKey] ?? 0) + 1;
        return undefined;
      }
  };

  const byChain = new Map<string, Custodian[]>();
  for (const c of custodians) {
    if (!byChain.has(c.chainKey)) byChain.set(c.chainKey, []);
    byChain.get(c.chainKey)!.push(c);
  }

  const perChain = await Promise.all(
    [...byChain.values()].map(async (queue) => {
      const out: Array<CustodianBalance | undefined> = [];
      for (let i = 0; i < queue.length; i += MAX_CONCURRENT_PER_CHAIN) {
        out.push(...(await Promise.all(queue.slice(i, i + MAX_CONCURRENT_PER_CHAIN).map((c) => readOne(c)))));
      }
      return out;
    })
  );
  const results = perChain.flat();

  return {
    balances: results.filter((b): b is CustodianBalance => b !== undefined),
    failuresByChain,
    attemptsByChain,
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
  if (fraction) return `${wholeText},${fraction}`;

  // Dust: a balance too small to show at this precision, but not zero.
  // Printing a bare "0" would say there is nothing here, and "nothing here"
  // is the single most consequential thing this bot can get wrong.
  return whole === 0n ? "< 0,0001" : wholeText;
}
