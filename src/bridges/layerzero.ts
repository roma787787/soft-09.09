import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { isAddress } from "viem";
import type { Custodian } from "./types";
import { getChain } from "../config/chains";

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
