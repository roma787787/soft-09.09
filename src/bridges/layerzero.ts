import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { isAddress } from "viem";
import type { Custodian } from "./types";
import { getChain, resolveChain } from "../config/chains";
import { getClient } from "../services/rpcClient";
import { LZ_ENDPOINT_V2 } from "../protocols/addresses/layerzero";
import { getLzEidMap } from "../services/idMaps";
import { bytes32ToAddress, isEvmAddressBytes32 } from "../protocols/util";

const OAPP_ABI = [
  { type: "function", name: "endpoint", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * LayerZero V1 names its endpoint differently and deploys it at a different
 * address on every chain, so there is no constant to compare against the way
 * V2 has one. The endpoint is verified by asking it a question only a real
 * V1 endpoint answers instead.
 */
const OAPP_V1_ABI = [
  { type: "function", name: "lzEndpoint", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const ENDPOINT_V1_ABI = [
  { type: "function", name: "getChainId", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

export interface OftProbe {
  chainKey: string;
  /**
   * "adapter" locks a separate ERC-20 and therefore holds withdrawable
   * liquidity. "native" mints and burns its own supply, so no contract
   * holds anything - there is nothing to measure, which is a different
   * answer from "this token is not bridged".
   */
  kind: "adapter" | "native";
  /** The ERC-20 an adapter locks. */
  wrappedToken?: Address;
  /** Which generation of the protocol this contract belongs to. */
  version: "v1" | "v2";
}

/**
 * Asks the token contract itself whether it is a LayerZero OFT.
 *
 * LayerZero publishes no ticker-to-adapter registry, which is why adapters
 * are configured by hand. But when the token address CoinMarketCap gives us
 * is itself the OFT, the contract answers for itself - and the answer
 * decides whether "no custody balance" means no liquidity or means the
 * design has no custody contract at all.
 */
export async function probeLayerZeroToken(
  chainKey: string,
  tokenAddress: Address
): Promise<OftProbe | undefined> {
  const version = await layerZeroVersionOf(chainKey, tokenAddress);
  if (!version) return undefined;

  let wrapped: Address | undefined;
  try {
    wrapped = (await getClient(chainKey).readContract({
      address: tokenAddress,
      abi: OAPP_ABI,
      functionName: "token",
    })) as Address;
  } catch {
    wrapped = undefined;
  }

  // OFT.sol returns address(this); OFTAdapter.sol returns what it locks.
  // V1's ProxyOFT behaves the same way, which is why one check covers both.
  const isAdapter = !!wrapped && wrapped.toLowerCase() !== tokenAddress.toLowerCase();
  return isAdapter
    ? { chainKey, kind: "adapter", wrappedToken: wrapped, version }
    : { chainKey, kind: "native", version };
}

/**
 * Which generation of LayerZero this contract belongs to, if any.
 *
 * V2 is easy: one EndpointV2 address, the same on every chain, so the
 * contract's endpoint() either matches it or the contract is not a V2 OApp.
 *
 * V1 has no such constant - its endpoint is a different address on every
 * chain - so the address that comes back is verified by asking it for its
 * own V1 chain id. Only a real endpoint answers that, which keeps an
 * unrelated contract with an lzEndpoint() getter from being read as a
 * bridge. Until this existed, a V1 adapter's locked balance was invisible:
 * the report showed nothing and meant "not bridged here", which for the
 * older half of LayerZero was simply wrong.
 */
async function layerZeroVersionOf(
  chainKey: string,
  address: Address
): Promise<"v1" | "v2" | undefined> {
  const client = getClient(chainKey);

  try {
    const endpoint = (await client.readContract({
      address,
      abi: OAPP_ABI,
      functionName: "endpoint",
    })) as Address;
    if (endpoint && endpoint.toLowerCase() === LZ_ENDPOINT_V2.toLowerCase()) return "v2";
  } catch {
    // Not a V2 OApp; V1 is still possible.
  }

  try {
    const endpoint = (await client.readContract({
      address,
      abi: OAPP_V1_ABI,
      functionName: "lzEndpoint",
    })) as Address;
    if (!endpoint || /^0x0+$/i.test(endpoint)) return undefined;

    const chainId = (await client.readContract({
      address: endpoint,
      abi: ENDPOINT_V1_ABI,
      functionName: "getChainId",
    })) as number;
    return chainId > 0 ? "v1" : undefined;
  } catch {
    return undefined;
  }
}


// ---------------------------------------------------------------------------
// LayerZero's public OFT registry
// ---------------------------------------------------------------------------

const OFT_REGISTRY_URL =
  process.env.LAYERZERO_OFT_LIST_URL || "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list";

const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;

interface RegistryDeployment {
  address?: string;
  localDecimals?: number;
  /** "OFT" mints its own supply; anything naming an adapter locks a token. */
  type?: string;
}

interface RegistryEntry {
  name?: string;
  sharedDecimals?: number;
  endpointVersion?: string;
  deployments?: Record<string, RegistryDeployment>;
}

type OftRegistry = Record<string, RegistryEntry[]>;

let registryCache: { at: number; data: OftRegistry } | undefined;
let registryInFlight: Promise<OftRegistry | undefined> | undefined;

/**
 * LayerZero publishes an OFT registry keyed by ticker. It is what makes
 * LayerZero automatic rather than hand-maintained, so a failure to load it
 * degrades to the manual config instead of failing the report.
 */
async function fetchOftRegistry(): Promise<OftRegistry | undefined> {
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.data;
  if (registryInFlight) return registryInFlight;

  registryInFlight = (async () => {
    try {
      const response = await fetch(OFT_REGISTRY_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as OftRegistry;
      registryCache = { at: Date.now(), data };
      console.log(`[layerzero] реестр OFT загружен, тикеров: ${Object.keys(data).length}`);
      return data;
    } catch (err) {
      console.error("[layerzero] не удалось загрузить реестр OFT:", err);
      return registryCache?.data;
    } finally {
      registryInFlight = undefined;
    }
  })();

  return registryInFlight;
}

export interface RegistryDeploymentInfo {
  chainKey: string;
  address: Address;
  /** True when the contract locks a separate ERC-20 and so holds liquidity. */
  locksCollateral: boolean;
  rawType: string;
}

/**
 * Looks a ticker up in LayerZero's registry.
 *
 * The `type` field decides everything downstream: a plain OFT mints and
 * burns, so no contract holds anything and there is no balance to read; an
 * adapter locks a real token and is exactly the custody contract this bot
 * exists to measure. Unknown types are treated as non-locking, since
 * inventing a balance for one would be worse than omitting it.
 */
export async function findLayerZeroRegistryDeployments(symbol: string): Promise<RegistryDeploymentInfo[]> {
  const registry = await fetchOftRegistry();
  if (!registry) return [];

  const entries = registry[symbol.toUpperCase()] ?? registry[symbol];
  return extractDeployments(entries);
}

/**
 * Pure half of the registry lookup, so the real response shape is covered
 * by a test rather than only by a live call.
 */
export function extractDeployments(entries: unknown): RegistryDeploymentInfo[] {
  if (!Array.isArray(entries)) return [];

  const found: RegistryDeploymentInfo[] = [];
  for (const entry of entries as RegistryEntry[]) {
    for (const [lzChainKey, deployment] of Object.entries(entry?.deployments ?? {})) {
      const address = deployment?.address;
      if (!address || !isAddress(address, { strict: false })) continue;

      // LayerZero names chains its own way; resolveChain also matches our aliases.
      const chain = resolveChain(lzChainKey);
      if (!chain) continue;

      const rawType = String(deployment.type ?? "");
      found.push({
        chainKey: chain.key,
        address: address as Address,
        locksCollateral: /adapter|lockbox|proxy/i.test(rawType),
        rawType: rawType || "неизвестно",
      });
    }
  }
  return found;
}

/** Reads the ERC-20 an adapter locks. Authoritative, unlike guessing it. */
export async function readAdapterUnderlying(
  chainKey: string,
  adapterAddress: Address
): Promise<Address | undefined> {
  try {
    const underlying = (await getClient(chainKey).readContract({
      address: adapterAddress,
      abi: OAPP_ABI,
      functionName: "token",
    })) as Address;
    if (!underlying || underlying.toLowerCase() === adapterAddress.toLowerCase()) return undefined;
    return underlying;
  } catch {
    return undefined;
  }
}

/**
 * A manual override for what the registry does not cover, or gets wrong. Shape:
 *
 * {
 *   "ARB": {
 *     "ethereum": "0xLockboxAddress",
 *     "arbitrum": { "custody": "0xLockbox", "token": "0xTokenOverride" }
 *   }
 * }
 *
 * The short form uses the token address CoinMarketCap reported for that
 * chain. The long form is for the case where the adapter locks a different
 * contract than the one CMC lists.
 */
export interface LockboxEntry {
  custody: string;
  token?: string;
}

type RawConfig = Record<string, Record<string, string | LockboxEntry>>;

const CONFIG_PATH = process.env.LAYERZERO_CONFIG_PATH || path.join("config", "layerzero-lockboxes.json");

let cache: RawConfig | undefined;
let cacheMtimeMs = 0;

/** Re-reads the file when it changes, so adding an adapter needs no restart. */
function loadConfig(): RawConfig {
  const file = path.resolve(process.cwd(), CONFIG_PATH);
  try {
    const stat = fs.statSync(file);
    if (cache && stat.mtimeMs === cacheMtimeMs) return cache;
    cache = JSON.parse(fs.readFileSync(file, "utf8")) as RawConfig;
    cacheMtimeMs = stat.mtimeMs;
    return cache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[layerzero] не удалось прочитать ${CONFIG_PATH}:`, err);
    }
    cache = {};
    return cache;
  }
}

export function findLayerZeroCustodians(
  symbol: string,
  tokenByChain: Map<string, Address>
): Custodian[] {
  const config = loadConfig();
  const entry =
    config[symbol.toUpperCase()] ??
    config[symbol.toLowerCase()] ??
    config[symbol];
  if (!entry) return [];

  const found: Custodian[] = [];
  for (const [chainKey, value] of Object.entries(entry)) {
    if (!getChain(chainKey)) continue;

    const custody = typeof value === "string" ? value : value.custody;
    const tokenOverride = typeof value === "string" ? undefined : value.token;
    if (!custody || !isAddress(custody, { strict: false })) continue;

    const token = tokenOverride ?? tokenByChain.get(chainKey);
    if (!token || !isAddress(token, { strict: false })) continue;

    found.push({
      protocol: "layerzero",
      chainKey,
      custodyAddress: custody as Address,
      tokenAddress: token as Address,
    });
  }
  return found;
}

/**
 * How many tickers LayerZero's registry currently covers, or undefined when
 * it has not been loaded yet. Deliberately does not trigger a fetch: a
 * coverage report should describe what the bot has, not go and get it.
 */
export function layerZeroRegistrySize(): number | undefined {
  return registryCache ? Object.keys(registryCache.data).length : undefined;
}

/** How many tickers the manual config covers, for the /sources report. */
export function layerZeroConfigSize(): number {
  return Object.keys(loadConfig()).length;
}

// ---------------------------------------------------------------------------
// Walking the peer mesh
// ---------------------------------------------------------------------------

const PEERS_ABI = [
  {
    type: "function",
    name: "peers",
    stateMutability: "view",
    inputs: [{ name: "eid", type: "uint32" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** Peer lookups per round against a single node. */
const PEER_QUERY_BATCH = 8;

const ERC20_SYMBOL_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export interface MeshResult {
  custodians: Custodian[];
  /** Chains whose peer mints its own supply, so nothing is held there. */
  nativeChains: string[];
  /** Chains the walk reached, for the report's own accounting. */
  reached: string[];
}

/**
 * Expands one known OFT into the whole deployment it belongs to.
 *
 * This is what closes the gap the registries leave. A registry lists a token
 * only if someone published it there, and LayerZero's covers a few hundred
 * tickers out of everything that exists. But an OFT knows its own
 * counterparts: `peers(eid)` returns its address on the destination chain,
 * because that is how it decides which messages to trust. So a single hit
 * anywhere - from the registry, from the manual config, or from probing the
 * token address CoinMarketCap gave us - unfolds into every chain that
 * deployment reaches, including chains no registry mentions.
 *
 * A peer that locks an ERC-20 is a custody contract and holds withdrawable
 * liquidity. A peer that returns itself mints and burns, and holds nothing -
 * a different answer from "not bridged here", and one worth stating.
 */
export async function expandLayerZeroMesh(
  seeds: Array<{ chainKey: string; oapp: Address }>,
  symbol: string,
  known: Set<string> = new Set()
): Promise<MeshResult> {
  if (seeds.length === 0) return { custodians: [], nativeChains: [], reached: [] };

  const eidMap = await getLzEidMap();

  // Two seeds, not all of them: the mesh is fully connected, so the first
  // one that answers already names every chain. The second is there for the
  // case where the first sits on a chain whose node is refusing calls.
  const useful = seeds.slice(0, 2);

  const peerByChain = new Map<string, Address>();
  for (const seed of useful) {
    const client = getClient(seed.chainKey);
    const targets = [...eidMap.chainKeyToId.entries()].filter(
      ([chainKey]) => chainKey !== seed.chainKey && !peerByChain.has(chainKey) && !known.has(chainKey)
    );

    // Every one of these lands on the seed's own node, so they go in batches
    // rather than all at once: asking one endpoint for forty answers in the
    // same instant is a reliable way to be rate-limited by it.
    for (let i = 0; i < targets.length; i += PEER_QUERY_BATCH) {
      await Promise.all(
        targets.slice(i, i + PEER_QUERY_BATCH).map(async ([chainKey, eid]) => {
          try {
            const raw = (await client.readContract({
              address: seed.oapp,
              abi: PEERS_ABI,
              functionName: "peers",
              args: [eid],
            })) as string;
            if (!isEvmAddressBytes32(raw)) return;
            peerByChain.set(chainKey, bytes32ToAddress(raw) as Address);
          } catch {
            // This chain is simply not a destination for this deployment.
          }
        })
      );
    }
  }

  const custodians: Custodian[] = [];
  const nativeChains: string[] = [];
  const reached: string[] = [];

  await Promise.all(
    [...peerByChain.entries()].map(async ([chainKey, peer]) => {
      const probe = await probeLayerZeroToken(chainKey, peer);
      if (!probe) return;
      reached.push(chainKey);

      if (probe.kind === "native" || !probe.wrappedToken) {
        nativeChains.push(chainKey);
        return;
      }

      // The mesh guarantees these contracts talk to each other; it does not
      // guarantee the ERC-20 underneath is the token that was asked about.
      // Checking the symbol keeps a mismatched deployment from being
      // reported under the wrong ticker.
      if (!(await symbolLooksRight(chainKey, probe.wrappedToken, symbol))) return;

      custodians.push({
        protocol: "layerzero",
        chainKey,
        custodyAddress: peer,
        tokenAddress: probe.wrappedToken,
        note: "найден по сети пиров LayerZero",
      });
    })
  );

  return { custodians, nativeChains, reached };
}

/**
 * Accepts a token whose symbol matches the ticker, allowing for the variants
 * a bridged token picks up ("USDT" locked by a "USDT0" deployment). A token
 * that will not answer symbol() is accepted: the peer link is already strong
 * evidence, and dropping the row would hide real liquidity.
 */
async function symbolLooksRight(chainKey: string, token: Address, symbol: string): Promise<boolean> {
  try {
    const actual = (await getClient(chainKey).readContract({
      address: token,
      abi: ERC20_SYMBOL_ABI,
      functionName: "symbol",
    })) as string;
    if (!actual) return true;

    const a = actual.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const b = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return a.includes(b) || b.includes(a);
  } catch {
    return true;
  }
}
