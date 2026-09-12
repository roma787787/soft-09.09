import type { Address } from "viem";
import type { Custodian } from "./types";
import { getChain, getChainByChainId } from "../config/chains";
import { getClient } from "../services/rpcClient";
import { CCIP_ROUTER_BY_CHAIN } from "../protocols/addresses/transporter";
import { CCIP_EVM_DEPLOYMENTS, type CcipEvmDeployment } from "../protocols/addresses/ccip.generated";

/**
 * Chainlink's published deployment for a chain, by our key.
 *
 * Joined on the EVM chain id, so a chain the bot discovered at runtime picks
 * its router up without anything being written down for it - which is the
 * point: five routers were listed here by hand out of the seventy-five
 * Chainlink publishes, so CCIP was checked on five chains and skipped in
 * silence on the rest.
 */
const deploymentByKey = new Map<string, CcipEvmDeployment>();
function deploymentFor(chainKey: string): CcipEvmDeployment | undefined {
  const cached = deploymentByKey.get(chainKey);
  if (cached) return cached;

  const chainId = getChain(chainKey)?.viemChain.id;
  const found = chainId === undefined ? undefined : CCIP_EVM_DEPLOYMENTS.find((d) => d.chainId === chainId);
  if (found) deploymentByKey.set(chainKey, found);
  return found;
}

/** The Router on a chain: Chainlink's directory first, the old table behind. */
export function ccipRouter(chainKey: string): Address | undefined {
  return deploymentFor(chainKey)?.router ?? CCIP_ROUTER_BY_CHAIN[chainKey];
}

/** Our key for every chain Chainlink names, for coverage counts. */
export function ccipChainKeys(): string[] {
  const keys = new Set<string>();
  for (const deployment of CCIP_EVM_DEPLOYMENTS) {
    const chain = getChainByChainId(deployment.chainId);
    if (chain) keys.add(chain.key);
  }
  for (const key of Object.keys(CCIP_ROUTER_BY_CHAIN)) {
    if (getChain(key)) keys.add(key);
  }
  return [...keys];
}

/**
 * Chainlink CCIP - the rail Transporter runs on - keeps a "token pool" per
 * token per chain. A lock/release pool holds the real collateral, which is
 * exactly the liquidity this bot reports; a burn/mint pool holds nothing,
 * and its zero balance is dropped downstream like any other zero.
 *
 * Nothing here is a hardcoded list of tokens or pools. The chain of calls
 * starts at the Router, whose address the bot already knows, and asks the
 * contracts themselves:
 *
 *   Router -> OffRamps (which chain selectors this chain talks to)
 *          -> OnRamp for one of those selectors
 *          -> TokenAdminRegistry from the OnRamp's static config
 *          -> getPool(token) for the token we are asking about
 *
 * Every step is verified, and a step that does not answer ends the walk. A
 * wrong guess therefore costs a missing row, never a wrong balance.
 */

const ROUTER_ABI = [
  {
    type: "function",
    name: "getOffRamps",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "sourceChainSelector", type: "uint64" },
          { name: "offRamp", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getOnRamp",
    stateMutability: "view",
    inputs: [{ name: "destChainSelector", type: "uint64" }],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * The OnRamp's static config carries the TokenAdminRegistry, but its shape
 * changed between CCIP versions. Both are tried: a tuple of the wrong length
 * fails to decode rather than decoding into nonsense, so the return data
 * picks the right one by itself.
 */
const ONRAMP_ABIS = [
  {
    label: "1.6",
    abi: [
      {
        type: "function",
        name: "getStaticConfig",
        stateMutability: "view",
        inputs: [],
        outputs: [
          {
            type: "tuple",
            components: [
              { name: "chainSelector", type: "uint64" },
              { name: "rmnRemote", type: "address" },
              { name: "nonceManager", type: "address" },
              { name: "tokenAdminRegistry", type: "address" },
            ],
          },
        ],
      },
    ] as const,
  },
  {
    label: "1.5",
    abi: [
      {
        type: "function",
        name: "getStaticConfig",
        stateMutability: "view",
        inputs: [],
        outputs: [
          {
            type: "tuple",
            components: [
              { name: "linkToken", type: "address" },
              { name: "chainSelector", type: "uint64" },
              { name: "destChainSelector", type: "uint64" },
              { name: "defaultTxGasLimit", type: "uint64" },
              { name: "maxNopFeesJuels", type: "uint96" },
              { name: "prevOnRamp", type: "address" },
              { name: "rmnProxy", type: "address" },
              { name: "tokenAdminRegistry", type: "address" },
            ],
          },
        ],
      },
    ] as const,
  },
];

const TOKEN_ADMIN_REGISTRY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

const TOKEN_POOL_ABI = [
  { type: "function", name: "getToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "typeAndVersion", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

function isSet(address: unknown): address is Address {
  return typeof address === "string" && address.toLowerCase() !== ZERO;
}

/** One step of the walk, for both the resolver and the /ccip diagnostic. */
export interface CcipStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CcipRegistryLookup {
  registry?: Address;
  steps: CcipStep[];
}

/**
 * Walks from the Router to the chain's TokenAdminRegistry, reporting each
 * step. The report is what makes this maintainable: when a chain stops
 * resolving, the answer to "where did it stop" is a command away instead of
 * a guess.
 */
export async function findTokenAdminRegistry(chainKey: string): Promise<CcipRegistryLookup> {
  const steps: CcipStep[] = [];

  const router = ccipRouter(chainKey);
  if (!router) {
    steps.push({ name: "Router", ok: false, detail: "адреса роутера для этой сети нет в справочнике" });
    return { steps };
  }
  steps.push({ name: "Router", ok: true, detail: router });

  // Chainlink publishes the registry per chain, so where the directory has
  // it the walk below is skipped entirely. That walk is four calls deep -
  // getOffRamps, getOnRamp, then getStaticConfig in one of two shapes - and
  // every one of them has to succeed on a chain that may answer none.
  const published = deploymentFor(chainKey)?.tokenAdminRegistry;
  if (published) {
    steps.push({ name: "TokenAdminRegistry", ok: true, detail: `${published} (из справочника Chainlink)` });
    return { registry: published, steps };
  }

  const client = getClient(chainKey);

  // The selectors of the chains this one receives from are the same numbers
  // used to address them as destinations, so the Router hands us the input
  // for the next call and no selector has to be written down anywhere.
  let selectors: bigint[] = [];
  try {
    const offRamps = (await client.readContract({
      address: router,
      abi: ROUTER_ABI,
      functionName: "getOffRamps",
    })) as ReadonlyArray<{ sourceChainSelector: bigint; offRamp: Address }>;
    selectors = [...new Set(offRamps.map((o) => o.sourceChainSelector))];
    steps.push({ name: "getOffRamps", ok: selectors.length > 0, detail: `${selectors.length} направлений` });
  } catch (err) {
    steps.push({ name: "getOffRamps", ok: false, detail: shortError(err) });
    return { steps };
  }

  // Bounded because each selector costs up to three calls and a chain can
  // list dozens of lanes. Eight rather than a handful: the older OnRamps
  // have no registry in their config at all, and on a chain whose first
  // lanes are old ones a shorter walk gives up on a registry that exists.
  const walked = selectors.slice(0, 8);
  for (const selector of walked) {
    let onRamp: Address | undefined;
    try {
      const result = await client.readContract({
        address: router,
        abi: ROUTER_ABI,
        functionName: "getOnRamp",
        args: [selector],
      });
      if (isSet(result)) onRamp = result;
    } catch {
      continue;
    }
    if (!onRamp) continue;

    for (const { label, abi } of ONRAMP_ABIS) {
      try {
        const config = (await client.readContract({
          address: onRamp,
          abi: abi as never,
          functionName: "getStaticConfig",
        })) as { tokenAdminRegistry?: Address };

        if (isSet(config?.tokenAdminRegistry)) {
          steps.push({ name: "OnRamp", ok: true, detail: `${onRamp} (селектор ${selector}, конфиг ${label})` });
          steps.push({ name: "TokenAdminRegistry", ok: true, detail: config.tokenAdminRegistry });
          return { registry: config.tokenAdminRegistry, steps };
        }
      } catch {
        // Wrong shape for this version; try the next.
      }
    }
  }

  steps.push({
    name: "TokenAdminRegistry",
    ok: false,
    // With the count, because "none of them" reads as "all of them were
    // asked". When the walk stops short of the lanes the chain listed, the
    // honest answer is that the registry was not found in what was checked.
    detail:
      walked.length < selectors.length
        ? `проверено ${walked.length} направлений из ${selectors.length} — реестр не отдал ни один OnRamp`
        : "ни один OnRamp не отдал реестр в известных форматах конфига",
  });
  return { steps };
}

function shortError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0].slice(0, 120);
}

/**
 * Cached per chain: the registry address of a live deployment is stable.
 *
 * A miss is not. Finding the registry means walking the OnRamps, and a node
 * that rate-limits during one report makes that walk come back empty - which
 * was then remembered as "no CCIP here" for the life of the process, on a
 * chain that has it. So a found address is kept for good and a miss only
 * briefly: long enough that a report does not re-walk the same chains it
 * just walked, short enough that one bad minute does not cost a bridge until
 * the next deploy.
 */
const registryCache = new Map<string, Address>();
const registryMisses = new Map<string, number>();

const MISS_TTL_MS = 10 * 60 * 1000;

async function tokenAdminRegistryFor(chainKey: string): Promise<Address | undefined> {
  const known = registryCache.get(chainKey);
  if (known) return known;

  const missedAt = registryMisses.get(chainKey);
  if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return undefined;

  const { registry } = await findTokenAdminRegistry(chainKey);
  if (registry) {
    registryCache.set(chainKey, registry);
    registryMisses.delete(chainKey);
  } else {
    registryMisses.set(chainKey, Date.now());
  }
  return registry;
}

export interface CcipPool {
  chainKey: string;
  pool: Address;
  token: Address;
  kind: string;
}

/**
 * The CCIP pool holding this token on one chain, if there is one.
 *
 * The pool must confirm it is the pool for this exact token: the registry is
 * asked by address, but a contract that answers getPool() for anything at
 * all would otherwise let an unrelated balance into the report.
 */
export async function findCcipPool(chainKey: string, token: Address): Promise<CcipPool | undefined> {
  const registry = await tokenAdminRegistryFor(chainKey);
  if (!registry) return undefined;

  try {
    const client = getClient(chainKey);
    const pool = await client.readContract({
      address: registry,
      abi: TOKEN_ADMIN_REGISTRY_ABI,
      functionName: "getPool",
      args: [token],
    });
    if (!isSet(pool)) return undefined;

    const held = (await client.readContract({
      address: pool,
      abi: TOKEN_POOL_ABI,
      functionName: "getToken",
    })) as Address;
    if (!held || held.toLowerCase() !== token.toLowerCase()) return undefined;

    let kind = "пул CCIP";
    try {
      kind = (await client.readContract({
        address: pool,
        abi: TOKEN_POOL_ABI,
        functionName: "typeAndVersion",
      })) as string;
    } catch {
      // Older pools may not implement it; the balance is what matters.
    }

    return { chainKey, pool, token, kind };
  } catch {
    return undefined;
  }
}

/** Every CCIP pool holding this token, across the chains we have a Router for. */
export async function findCcipCustodians(tokenByChain: Map<string, Address>): Promise<Custodian[]> {
  const chains = [...tokenByChain.entries()].filter(
    ([chainKey]) => getChain(chainKey) && ccipRouter(chainKey)
  );

  const pools = await Promise.all(chains.map(([chainKey, token]) => findCcipPool(chainKey, token)));

  return pools
    .filter((p): p is CcipPool => p !== undefined)
    .map((p) => ({
      protocol: "ccip" as const,
      chainKey: p.chainKey,
      custodyAddress: p.pool,
      tokenAddress: p.token,
      note: p.kind,
    }));
}

/** How many chains CCIP can be walked on, for the /sources report. */
export function ccipChainCount(): number {
  return ccipChainKeys().length;
}

/**
 * Chains Chainlink names that the bot has no EVM table entry for, so a
 * coverage report can say which CCIP deployments are out of reach rather
 * than leaving them out of both the covered list and the gaps.
 */
export function ccipChainsWithoutTable(): number {
  return CCIP_EVM_DEPLOYMENTS.filter((d) => !getChainByChainId(d.chainId)).length;
}
