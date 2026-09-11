import type { Address } from "viem";
import { getClient } from "./rpcClient";
import { getChain } from "../config/chains";
import type { Custodian } from "../bridges/types";
import { isTransportError } from "../protocols/util";
import { isFragile, noteChainTrouble } from "./rpcHealth";

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface CustodianBalance extends Custodian {
  amount: bigint;
  decimals: number;
}

/**
 * A row the report can render, whatever chain it came from. Solana addresses
 * are base58, so the address here is a plain string - an EVM balance
 * satisfies this shape unchanged, while a Solana one could never be forced
 * into viem's hex-typed address.
 */
export interface BalanceRow {
  protocol: Custodian["protocol"];
  chainKey: string;
  custodyAddress: string;
  tokenAddress: string;
  note?: string;
  readsNativeCoin?: boolean;
  amount: bigint;
  decimals: number;
}

/** What one unit of a chain's own coin is worth, in the smallest unit. */
function nativeDecimals(chainKey: string): number {
  const decimals = getChain(chainKey)?.viemChain.nativeCurrency?.decimals;
  return Number.isInteger(decimals) ? (decimals as number) : 18;
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

export interface ChainSupply {
  chainKey: string;
  tokenAddress: Address;
  /** Undefined when the chain or the contract would not answer. */
  amount?: bigint;
  decimals?: number;
  /** The contract refused, as opposed to the node being unreachable. */
  unreadable?: boolean;
}

/**
 * How much of the token exists on a chain, asked of the token itself.
 *
 * Not a bridge balance and never mixed in with one: this answers the
 * question a report could not previously answer at all. A chain where
 * CoinGecko lists the token but no tracked bridge holds custody produced no
 * rows and no mention, so "we looked and no bridge is there" was
 * indistinguishable from "we did not look" - which for a bot whose whole
 * job is telling those two apart is the worst answer available.
 *
 * A supply with no custody behind it means the token reached that chain by
 * a route this bot does not track, or was minted there natively. Either way
 * it cannot be withdrawn through the bridges here, and saying so is the
 * point.
 */
export async function readChainSupplies(
  tokens: Array<{ chainKey: string; tokenAddress: Address }>
): Promise<ChainSupply[]> {
  return Promise.all(
    tokens.map(async ({ chainKey, tokenAddress }) => {
      try {
        const [amount, decimals] = await Promise.all([
          getClient(chainKey).readContract({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "totalSupply",
          }) as Promise<bigint>,
          readDecimals(chainKey, tokenAddress),
        ]);
        return { chainKey, tokenAddress, amount, decimals };
      } catch (err) {
        // Unknown rather than zero: zero would read as "the token is not
        // there", which is the very confusion this exists to remove.
        //
        // And the two reasons are kept apart, because the report blames one
        // of them out loud. A node that would not answer is a connection
        // problem the reader can fix with an RPC; a contract that refuses
        // totalSupply is not a node problem at all, and saying so would send
        // them chasing the wrong thing.
        return { chainKey, tokenAddress, unreadable: !isTransportError(err) };
      }
    })
  );
}

export interface BalanceReport {
  balances: CustodianBalance[];
  /**
   * How many reads failed per chain because the node would not answer. A
   * count, not a flag: one contract timing out on a chain whose other twenty
   * answered is a very different fact from the whole chain being
   * unreachable, and reporting both as "could not check this chain" tells
   * the user their data is missing when most of it is right there.
   *
   * A contract that reverts is not counted here at all. That is not a
   * failure to reach the chain, it is a contract with nothing to say, and
   * warning about the chain's connection because of it points at the wrong
   * thing entirely.
   */
  failuresByChain: Record<string, number>;
  /** How many reads were attempted per chain. */
  attemptsByChain: Record<string, number>;
  /**
   * Contracts that answered with a revert rather than a balance - a warp
   * route whose collateral is not a plain ERC-20, a proxy that is not a
   * token. Kept separate from failures so the report can stop blaming the
   * chain's connection for them.
   */
  notReadableByChain: Record<string, number>;
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

/** Parallel reads allowed on a chain that answers on a single node. */
const FRAGILE_CONCURRENCY = 2;

/** Attempts such a chain gets, since there is no second node to try. */
const FRAGILE_RETRIES = 2;

/** Grows with each attempt: a node that just refused needs a moment, not a nudge. */
const RETRY_BACKOFF_MS = 400;

/**
 * The two policies, apart from the state they read, so they can be checked.
 *
 * A chain's own declared limit always wins: it was written down because
 * someone watched that chain throttle, which is better evidence than
 * anything measured in passing.
 */
export function concurrencyFor(override: number | undefined, fragile: boolean): number {
  if (override !== undefined) return override;
  return fragile ? FRAGILE_CONCURRENCY : MAX_CONCURRENT_PER_CHAIN;
}

export function attemptsFor(fragile: boolean): number {
  return fragile ? FRAGILE_RETRIES : 1;
}

export async function readCustodianBalances(custodians: Custodian[]): Promise<BalanceReport> {
  const failuresByChain: Record<string, number> = {};
  const notReadable: Record<string, number> = {};
  const attemptsByChain: Record<string, number> = {};
  for (const c of custodians) {
    attemptsByChain[c.chainKey] = (attemptsByChain[c.chainKey] ?? 0) + 1;
  }

  const readOne = async (c: Custodian, attempt = 0): Promise<CustodianBalance | undefined> => {
    try {
      if (c.readsNativeCoin) {
          // The chain's own coin is not an ERC-20 and has no balanceOf, so
          // its precision comes from the chain rather than the token.
          //
          // This used to be hardcoded to 18 on the grounds that every chain
          // carrying a native pool used 18 - true of a table kept by hand,
          // and no longer something anything guarantees: the table is
          // discovered now, and the pool list is regenerated by a script.
          // Two chains already in it are not 18 (Tron's TRX and Tempo's USD,
          // both 6), and a native pool appearing on one of those would have
          // been reported a trillion times small. A wrong number is worse
          // here than a missing row: a missing row invites a second look.
          const amount = await getClient(c.chainKey).getBalance({ address: c.custodyAddress });
          return { ...c, amount, decimals: nativeDecimals(c.chainKey) };
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
        // A revert is an answer: this contract does not hold the token in a
        // way we can read. Retrying it wastes a round trip and it will
        // revert again, so it is dropped without accusing the chain of
        // being unreachable.
        if (!isTransportError(err)) {
          notReadable[c.chainKey] = (notReadable[c.chainKey] ?? 0) + 1;
          return undefined;
        }

        // Retried, because a public node under load refuses a request that
        // succeeds moments later, and a dropped row reads as "no liquidity
        // here", which is the opposite of what it means.
        //
        // A chain with one working node gets a second attempt and a longer
        // wait: the fallback transport has nowhere to fall, so this retry is
        // the only other chance there is. A chain with six healthy nodes has
        // already tried five others by the time it gets here, and waiting
        // longer would only add to a report that is already slow.
        const attempts = attemptsFor(isFragile(c.chainKey));
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
          return readOne(c, attempt + 1);
        }
        failuresByChain[c.chainKey] = (failuresByChain[c.chainKey] ?? 0) + 1;
        // The reads know a node has gone bad long before the next scheduled
        // measurement would, and the ordering is only as fresh as that
        // measurement. This is them saying so.
        noteChainTrouble(c.chainKey);
        return undefined;
      }
  };

  const byChain = new Map<string, Custodian[]>();
  for (const c of custodians) {
    if (!byChain.has(c.chainKey)) byChain.set(c.chainKey, []);
    byChain.get(c.chainKey)!.push(c);
  }

  const perChain = await Promise.all(
    [...byChain.entries()].map(async ([chainKey, queue]) => {
      // A chain may ask for less: TronGrid throttles four parallel reads
      // into three failures, and a throttled read costs a whole row.
      // Gentler on a chain with nothing to fall back to. Four parallel
      // requests into a single public node is how a 429 is earned, and a
      // chain down to one node cannot absorb one: the refusal costs the
      // whole row, which reads as "no liquidity here".
      const limit = concurrencyFor(getChain(chainKey)?.maxConcurrentReads, isFragile(chainKey));
      const out: Array<CustodianBalance | undefined> = [];
      for (let i = 0; i < queue.length; i += limit) {
        out.push(...(await Promise.all(queue.slice(i, i + limit).map((c) => readOne(c)))));
      }
      return out;
    })
  );
  const results = perChain.flat();

  return {
    balances: results.filter((b): b is CustodianBalance => b !== undefined),
    failuresByChain,
    notReadableByChain: notReadable,
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
