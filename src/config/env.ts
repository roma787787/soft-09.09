import "dotenv/config";
import { CHAINS } from "./chains";
import { EXTRA_RPC_URLS_BY_CHAIN_ID } from "./rpcs.generated";
import { learnedEndpoints } from "../services/extraEndpoints";

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
  /**
   * Where the host mounted a persistent volume, if it did.
   *
   * The only signal that separates "no volume" from "a volume mounted for
   * the first time". Both start with an empty directory, so the boot check
   * alone cannot tell them apart - and it was calling a correctly mounted,
   * freshly created volume a container without one.
   */
  volumeMountPath: read("RAILWAY_VOLUME_MOUNT_PATH") || read("VOLUME_MOUNT_PATH") || "",
  trackPollIntervalMs: positiveInt("TRACK_POLL_INTERVAL_MS", 60_000, MIN_POLL_INTERVAL_MS),
  trackMaxBlockRange: BigInt(positiveInt("TRACK_MAX_BLOCK_RANGE", 2000, 1)),
  trackInitialLookbackBlocks: BigInt(positiveInt("TRACK_INITIAL_LOOKBACK_BLOCKS", 1000, 1)),
  // Optional on purpose: CoinGecko answers without a key, just on a limit
  // shared by IP - and a hosting provider's IP is shared with everyone
  // else's bots. A free Demo key makes the limit ours alone.
  coingeckoApiKey: read("COINGECKO_API_KEY"),
  coingeckoApiBase: read("COINGECKO_API_BASE") || "https://api.coingecko.com",

  /**
   * Which build is running.
   *
   * Railway puts the deployed commit in the environment, and without it
   * there is no way to tell a fix that did not work from a fix that did not
   * deploy - a distinction that cost a round trip more than once, with the
   * bot answering exactly as before because it was still the build from
   * before.
   */
  /**
   * Optional. The jetton index answers without it at about one request a
   * second, which a report shares with everything else it is doing.
   */
  tonApiKey: read("TON_API_KEY"),

  commitSha: read("RAILWAY_GIT_COMMIT_SHA") || read("GIT_COMMIT_SHA") || "",
  gitBranch: read("RAILWAY_GIT_BRANCH") || "",
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

  // viem carries one endpoint per chain, which held while there were forty
  // of them and stopped holding at a hundred and fifty: a single refusal
  // takes a whole chain out of the report, and a missing chain reads as "no
  // liquidity here". The generated list adds public alternates behind it.
  // Looked up by chain id, not by name. A chain the bot discovered at
  // runtime has no name in a file generated at build time, and that is
  // exactly the set of chains most short of alternates.
  const extras = EXTRA_RPC_URLS_BY_CHAIN_ID[chain.viemChain.id] ?? [];
  // And behind those, the endpoints the bridges publish for their own
  // chains, picked up while the bot was reading that metadata anyway. Last,
  // because they are the least vouched-for; present at all, because a chain
  // whose only listed node refuses this server drops out of every report,
  // and a missing chain reads as "no liquidity here".
  const learned = learnedEndpoints(chain.viemChain.id);
  const configured = read(chain.rpcEnvVar);
  const urls = [...new Set([...chain.defaultRpcUrls, ...extras, ...learned])];
  return configured ? [configured, ...urls] : urls;
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
