import "dotenv/config";
import { CHAINS } from "./chains";

/**
 * Reads an env var, trimming surrounding whitespace. Values are frequently
 * pasted from a phone or a chat window, where a stray space or newline rides
 * along - and an untrimmed bot token fails authentication with a 401 that
 * looks like "the bot is broken" rather than "the token has a space in it".
 */
function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function required(name: string): string {
  const v = read(name);
  if (!v) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

/** Parses a positive integer env var, falling back (loudly) when unusable. */
function positiveInt(name: string, fallback: number, min: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[config] ${name}="${raw}" is not a positive number, using ${fallback}`);
    return fallback;
  }
  if (parsed < min) {
    console.warn(`[config] ${name}=${parsed} is below the minimum ${min}, using ${min}`);
    return min;
  }
  return Math.floor(parsed);
}

// A NaN interval would make setInterval fire in a tight loop and hammer the
// RPC endpoints, so the floor here is a real safeguard, not just tidiness.
const MIN_POLL_INTERVAL_MS = 5_000;

export const env = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  dbPath: read("DB_PATH") || "./data/bot.db",
  trackPollIntervalMs: positiveInt("TRACK_POLL_INTERVAL_MS", 60_000, MIN_POLL_INTERVAL_MS),
  trackMaxBlockRange: BigInt(positiveInt("TRACK_MAX_BLOCK_RANGE", 2000, 1)),
  trackInitialLookbackBlocks: BigInt(positiveInt("TRACK_INITIAL_LOOKBACK_BLOCKS", 1000, 1)),
  cmcApiKey: read("CMC_API_KEY"),
  cmcApiBase: read("CMC_API_BASE") || "https://pro-api.coinmarketcap.com",
  layerZeroScanApi: read("LAYERZERO_SCAN_API") || "https://scan.layerzero-api.com/v1",
  wormholescanApi: read("WORMHOLESCAN_API") || "https://api.wormholescan.io",
  circleIrisApi: read("CIRCLE_IRIS_API") || "https://iris-api.circle.com/v2",
};

/**
 * Endpoints to try for a chain, in order. A configured endpoint goes first
 * and the public ones stay behind it as a safety net, so a rate-limited or
 * expired key degrades instead of taking the chain down.
 */
export function rpcUrlsFor(chainKey: string): string[] {
  const chain = CHAINS.find((c) => c.key === chainKey);
  if (!chain) throw new Error(`Unknown chain "${chainKey}"`);
  const configured = read(chain.rpcEnvVar);
  return configured ? [configured, ...chain.defaultRpcUrls] : [...chain.defaultRpcUrls];
}

/** True when the operator supplied their own endpoint for this chain. */
export function hasCustomRpc(chainKey: string): boolean {
  const chain = CHAINS.find((c) => c.key === chainKey);
  return !!chain && !!read(chain.rpcEnvVar);
}


/**
 * A configured endpoint ahead of the built-in ones.
 *
 * Every non-EVM chain declares an env var for its endpoint, and for a while
 * none of them read it: the variables were advertised in the chain tables
 * and ignored everywhere else, so setting one did nothing. Public endpoints
 * on these chains go stale, get discontinued, or fall behind the ledger -
 * which is exactly when someone needs to point the bot at their own.
 */
export function endpointsWithOverride(envVar: string, defaults: string[]): string[] {
  const configured = read(envVar);
  return configured ? [configured, ...defaults] : [...defaults];
}
