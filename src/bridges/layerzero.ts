import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { isAddress } from "viem";
import type { Custodian } from "./types";
import { getChain } from "../config/chains";
import { getClient } from "../services/rpcClient";
import { LZ_ENDPOINT_V2 } from "../protocols/addresses/layerzero";

const OAPP_ABI = [
  { type: "function", name: "endpoint", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
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
  try {
    const client = getClient(chainKey);
    const endpoint = (await client.readContract({
      address: tokenAddress,
      abi: OAPP_ABI,
      functionName: "endpoint",
    })) as Address;

    if (!endpoint || endpoint.toLowerCase() !== LZ_ENDPOINT_V2.toLowerCase()) return undefined;

    let wrapped: Address | undefined;
    try {
      wrapped = (await client.readContract({
        address: tokenAddress,
        abi: OAPP_ABI,
        functionName: "token",
      })) as Address;
    } catch {
      wrapped = undefined;
    }

    // OFT.sol returns address(this); OFTAdapter.sol returns what it locks.
    const isAdapter = !!wrapped && wrapped.toLowerCase() !== tokenAddress.toLowerCase();
    return isAdapter
      ? { chainKey, kind: "adapter", wrappedToken: wrapped }
      : { chainKey, kind: "native" };
  } catch {
    return undefined;
  }
}

/**
 * LayerZero has no public registry mapping a ticker to its OFT Adapter, so
 * these are maintained by hand. Shape:
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

/** How many tickers the manual config covers, for the /sources report. */
export function layerZeroConfigSize(): number {
  return Object.keys(loadConfig()).length;
}
