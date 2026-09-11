import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { isAddress } from "viem";
import { env } from "../config/env";
import { CHAINS } from "../config/chains";
import { SVM_CHAINS } from "../config/svmChains";
import { COSMOS_CHAINS } from "../config/cosmosChains";
import { OTHER_CHAINS } from "../config/otherChains";
import { PORTAL_CHAINS } from "../config/portalChains";

export class TokenSourceNotConfiguredError extends Error {}
export class TokenSourceRequestError extends Error {}

export interface TokenPlatform {
  /** Our internal chain key, when the platform is one we support. */
  chainKey?: string;
  /** CoinGecko's own name for the network, kept for unsupported chains. */
  platformName: string;
  tokenAddress: Address;
}

/**
 * A deployment on a chain that is not EVM, so its address is not hex and
 * cannot be handed to any of the EVM code. Kept apart from `platforms` for
 * exactly that reason: widening the EVM address type to fit base58 would put
 * a cast at every call site to serve one kind of chain.
 */
export interface OtherPlatform {
  /** Our key for the chain, when it is one the bot can read. */
  chainKey?: string;
  platformName: string;
  /** Base58 on Solana, bech32 on Cosmos, and whatever the chain uses elsewhere. */
  tokenAddress: string;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  platforms: TokenPlatform[];
  /** Deployments on non-EVM chains, which have addresses of another shape. */
  otherPlatforms: OtherPlatform[];
}

/** One network as CoinGecko describes it. */
export interface AssetPlatform {
  /** CoinGecko's stable slug, and the key its `platforms` map is keyed by. */
  id: string;
  /** The EVM chain id, when the platform has one. This is the good field. */
  chainId?: number;
  name: string;
}

/**
 * Matching is done on a normalised string so it survives punctuation and
 * casing: "BNB Smart Chain" and "binance-smart-chain" are the same network
 * spelled by two different people.
 */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A network name can carry a qualifier the chain's own name does not:
 * "Polygon (prev. MATIC)" in brackets, "World Chain Mainnet" appended. Both
 * forms matched nothing and put the chain in the report's "not checked"
 * list while the same report showed rows for it two screens above - the bot
 * contradicting itself inside one message.
 *
 * This is now the fallback rather than the mechanism: CoinGecko publishes
 * the EVM chain id for every platform that has one, and a chain id cannot be
 * spelled two ways. Names are only consulted for chains that have no chain
 * id at all, which is where the fallback still earns its place.
 */
const TRAILING_QUALIFIERS = ["mainnet", "main net", "network", "blockchain", "protocol"];

function stripTrailingQualifier(name: string): string {
  let out = name.trim();
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const word of TRAILING_QUALIFIERS) {
      const pattern = new RegExp(`\\s+${word}$`, "i");
      if (!pattern.test(out)) continue;
      const shorter = out.replace(pattern, "").trim();
      // Never strip a chain down to nothing: "Mainnet" on its own is a
      // useless candidate, and an empty one matches a chain with an empty
      // alias.
      if (!shorter) continue;
      out = shorter;
      stripped = true;
    }
  }
  return out;
}

function nameCandidates(platformName: string, platformId: string | undefined): string[] {
  const withoutBrackets = platformName.replace(/\s*\(.*?\)\s*/g, " ").trim();
  return [
    normalise(platformName),
    normalise(withoutBrackets),
    normalise(stripTrailingQualifier(withoutBrackets)),
    platformId ? normalise(platformId) : "",
  ].filter(Boolean);
}

function matchesByName(
  candidates: string[],
  chain: { key: string; label: string; aliases?: string[]; platformNames?: string[] }
): boolean {
  const names = [chain.key, chain.label, ...(chain.aliases ?? []), ...(chain.platformNames ?? [])].map(
    normalise
  );
  return candidates.some((c) => names.includes(c));
}

/**
 * The EVM chain a platform refers to.
 *
 * By chain id when CoinGecko gives one, which it does for every EVM network
 * it lists. That is not a nicety: a chain id is a number both sides agree on,
 * where a name is a spelling one side invents and the other has to guess.
 */
export function resolveEvmPlatform(platform: AssetPlatform | undefined, platformId: string): string | undefined {
  if (platform?.chainId !== undefined) {
    const byId = CHAINS.find((c) => c.viemChain.id === platform.chainId);
    if (byId) return byId.key;
  }
  const candidates = nameCandidates(platform?.name ?? platformId, platformId);
  return CHAINS.find((c) => matchesByName(candidates, c))?.key;
}

/** The same, for the chains the bot reads without viem and without chain ids. */
export function resolveNonEvmPlatform(
  platform: AssetPlatform | undefined,
  platformId: string
): string | undefined {
  const candidates = nameCandidates(platform?.name ?? platformId, platformId);
  for (const list of [SVM_CHAINS, COSMOS_CHAINS, OTHER_CHAINS, PORTAL_CHAINS]) {
    const hit = list.find((c) => matchesByName(candidates, c));
    if (hit) return hit.key;
  }

  // And the EVM table last, for the chain that sits in it without EVM
  // addresses. Tron speaks Ethereum's JSON-RPC, so the bot reads it through
  // viem like any other chain - but its addresses are base58, so a Tron
  // deployment never reaches the EVM branch above. It was landing here and
  // finding nothing, and the report said "the bot does not check TRON" on
  // the same screen as a Tron section listing balances.
  return CHAINS.find((c) => matchesByName(candidates, c))?.key;
}

/**
 * Whether a string is worth carrying as a non-EVM token address.
 *
 * Loose on purpose, and deliberately looser than the base58 test it
 * replaces: that one recognised Solana and silently dropped every other
 * shape, so an Aptos or Sui deployment did not merely go unread - it went
 * unmentioned, and the report's own "not checked" list did not know it
 * existed. Everything kept here is verified against its chain before it is
 * ever used.
 */
function looksLikeAddress(value: string): boolean {
  return value.length >= 20 && value.length <= 120 && !/\s/.test(value);
}

/* ------------------------------------------------------------------ */

const PLATFORM_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let platformCache: { at: number; byId: Map<string, AssetPlatform> } | undefined;
let platformInFlight: Promise<Map<string, AssetPlatform>> | undefined;

/**
 * The platform list, kept on disk beside the database.
 *
 * In memory it would be lost to every restart, and the first lookup after a
 * deploy is exactly when the free tier is most likely to refuse - the limit
 * is shared by IP with every other bot on the hosting provider. Without the
 * list a network is matched by the spelling of its slug rather than by its
 * chain id, which mostly works and quietly does not for the ones whose slug
 * is nothing like their name: CoinGecko files Optimism under
 * "optimistic-ethereum".
 *
 * A file that cannot be read or written is not an error worth reporting
 * twice - the list is a convenience, and the network is still there.
 */
function platformCachePath(): string {
  return path.join(path.dirname(env.dbPath), "coingecko-platforms.json");
}

function readPlatformCache(): Map<string, AssetPlatform> | undefined {
  try {
    const raw = fs.readFileSync(platformCachePath(), "utf8");
    const byId = parseAssetPlatforms(JSON.parse(raw));
    return byId.size > 0 ? byId : undefined;
  } catch {
    return undefined;
  }
}

function writePlatformCache(byId: Map<string, AssetPlatform>): void {
  try {
    // Written back in the API's own shape, so the file can be replaced with
    // a hand-saved response and still be read.
    const rows = [...byId.values()].map((p) => ({
      id: p.id,
      chain_identifier: p.chainId ?? null,
      name: p.name,
    }));
    fs.mkdirSync(path.dirname(platformCachePath()), { recursive: true });
    fs.writeFileSync(platformCachePath(), JSON.stringify(rows), "utf8");
  } catch {
    // Read-only disk, no volume mounted: the bot works, it just re-fetches.
  }
}

function apiUrl(path: string): URL {
  return new URL(path, env.coingeckoApiBase);
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!env.coingeckoApiKey) return headers;
  // The two plans take different headers, and the wrong one is ignored
  // rather than rejected - which looks exactly like a key that does not
  // work. The base URL is what distinguishes them.
  const header = env.coingeckoApiBase.includes("pro-api") ? "x-cg-pro-api-key" : "x-cg-demo-api-key";
  headers[header] = env.coingeckoApiKey;
  return headers;
}

/**
 * CoinGecko's own account of what went wrong.
 *
 * It puts one in the body of every rejection - "This endpoint is available
 * on other plans", "invalid api key" - and reading it is the difference
 * between a diagnosis and a guess. Learned the expensive way: a Demo key
 * was reported as rejected when it was the endpoint, not the key, that the
 * plan did not include.
 */
export function explainBody(body: unknown): string | undefined {
  const status = (body as { status?: { error_message?: unknown; error_code?: unknown } })?.status;
  const message = typeof status?.error_message === "string" ? status.error_message : undefined;
  const code = typeof status?.error_code === "number" ? status.error_code : undefined;
  const plain = typeof (body as { error?: unknown })?.error === "string" ? (body as { error: string }).error : undefined;
  const text = message ?? plain;
  if (!text) return code !== undefined ? `код ${code}` : undefined;
  return code !== undefined ? `${text} (код ${code})` : text;
}

async function get(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = apiUrl(path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let response: Response;
  try {
    response = await fetch(url, { headers: apiHeaders(), signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new TokenSourceRequestError(err instanceof Error ? err.message : String(err));
  }

  // The body is read before the status is judged: CoinGecko explains itself
  // in there, and the HTTP code alone cannot tell a bad key from an endpoint
  // the plan does not carry - they are both 401.
  const body = await response.json().catch(() => undefined);
  const said = explainBody(body);
  const suffix = said ? `\n\nОтвет CoinGecko: ${said}` : "";

  if (response.status === 429) {
    // The free tier is shared by IP, and this bot runs on a hosting provider
    // whose addresses are shared with everyone else's bots. Naming the fix
    // matters more than naming the status.
    throw new TokenSourceRequestError(
      (env.coingeckoApiKey
        ? "CoinGecko: превышен лимит запросов, попробуйте через минуту."
        : "CoinGecko: превышен лимит запросов. Бесплатный лимит общий на IP, а хостинг делит адрес " +
          "с чужими ботами. Лечится бесплатным ключом: coingecko.com → API → Demo, потом переменная " +
          "COINGECKO_API_KEY.") + suffix
    );
  }
  if (response.status === 401 || response.status === 403) {
    // Only blame the key when there is one. A 403 with no key configured is
    // something between the bot and CoinGecko - a proxy, a firewall, a
    // blocked datacentre range - and sending the reader to check a variable
    // they never set is a wasted evening.
    throw new TokenSourceRequestError(
      (env.coingeckoApiKey
        ? `CoinGecko отклонил запрос (HTTP ${response.status}).`
        : `CoinGecko: доступ закрыт (HTTP ${response.status}). Ключ не задан, так что дело не в нём — ` +
          `запрос режет что-то по дороге. Проверьте, что хостинг выпускает трафик на ` +
          `${env.coingeckoApiBase}.`) + suffix
    );
  }
  if (!response.ok) {
    throw new TokenSourceRequestError(`CoinGecko: запрос не прошёл, HTTP ${response.status}.${suffix}`);
  }

  if (body === undefined) throw new TokenSourceRequestError("CoinGecko вернул неразборчивый ответ");
  return body;
}

/** Parses /api/v3/asset_platforms. Split out so it can be tested offline. */
export function parseAssetPlatforms(body: unknown): Map<string, AssetPlatform> {
  const byId = new Map<string, AssetPlatform>();
  if (!Array.isArray(body)) return byId;
  for (const entry of body) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !id) continue;
    const rawChainId = (entry as { chain_identifier?: unknown }).chain_identifier;
    const name = (entry as { name?: unknown }).name;
    byId.set(id, {
      id,
      chainId: typeof rawChainId === "number" && Number.isInteger(rawChainId) ? rawChainId : undefined,
      name: typeof name === "string" && name ? name : id,
    });
  }
  return byId;
}

/**
 * Every network CoinGecko knows, cached for half a day.
 *
 * Cached because it is the same answer for everyone and it changes when a
 * chain launches, not when a token is looked up - and on the free tier every
 * avoidable call is one the next user does not get to make.
 */
export async function assetPlatforms(): Promise<Map<string, AssetPlatform>> {
  const fresh = platformCache && Date.now() - platformCache.at < PLATFORM_CACHE_TTL_MS;
  if (fresh) return platformCache!.byId;
  if (platformInFlight) return platformInFlight;

  platformInFlight = (async () => {
    try {
      const byId = parseAssetPlatforms(await get("/api/v3/asset_platforms"));
      if (byId.size > 0) {
        platformCache = { at: Date.now(), byId };
        writePlatformCache(byId);
      }
      return platformCache?.byId ?? byId;
    } catch (err) {
      // A stale list beats no list: the platform names barely move, and
      // failing the whole lookup because this one call was rate-limited
      // would report a token as unbridged.
      if (platformCache) return platformCache.byId;
      const saved = readPlatformCache();
      if (saved) {
        // Not stamped with now: this is last deploy's answer, and it should
        // still be replaced by a fresh one at the first opportunity.
        platformCache = { at: 0, byId: saved };
        return saved;
      }
      throw err;
    } finally {
      platformInFlight = undefined;
    }
  })();
  return platformInFlight;
}

/* ------------------------------------------------------------------ */

/**
 * Ticker to coin id.
 *
 * A hit is kept for the life of the process - a coin's id never changes.
 * A miss is kept only briefly: tickers get listed, and a permanent "not
 * found" would keep the bot answering "нет такого тикера" about a token
 * CoinGecko has known about for hours, until someone thought to redeploy.
 */
const COIN_ID_MISS_TTL_MS = 10 * 60 * 1000;

const coinIdHits = new Map<string, string>();
const coinIdMisses = new Map<string, number>();

/**
 * Picks the coin a ticker means.
 *
 * By market capitalisation, because tickers are not unique and the copies
 * outnumber the originals: a search for USDT returns Tether and a long tail
 * of imitations, and reporting bridge liquidity for the wrong one is worse
 * than reporting none.
 */
export function pickCoin(body: unknown, symbol: string): string | undefined {
  const coins = (body as { coins?: unknown })?.coins;
  if (!Array.isArray(coins)) return undefined;
  const wanted = normalise(symbol);

  const ranked = coins
    .filter((c): c is { id: string; symbol?: string; name?: string; market_cap_rank?: number } =>
      typeof (c as { id?: unknown })?.id === "string"
    )
    .map((c) => ({
      id: c.id,
      exactSymbol: normalise(String(c.symbol ?? "")) === wanted,
      exactName: normalise(String(c.name ?? "")) === wanted,
      rank: typeof c.market_cap_rank === "number" ? c.market_cap_rank : Number.POSITIVE_INFINITY,
    }));

  const bySymbol = ranked.filter((c) => c.exactSymbol).sort((a, b) => a.rank - b.rank);
  if (bySymbol.length > 0) return bySymbol[0].id;

  // A person may type a name rather than a ticker. Accepted only on an exact
  // match: a partial one would answer a question nobody asked.
  const byName = ranked.filter((c) => c.exactName).sort((a, b) => a.rank - b.rank);
  return byName[0]?.id;
}

async function coinIdFor(symbol: string): Promise<string | undefined> {
  const key = symbol.toUpperCase();
  const hit = coinIdHits.get(key);
  if (hit) return hit;

  const missedAt = coinIdMisses.get(key);
  if (missedAt !== undefined && Date.now() - missedAt < COIN_ID_MISS_TTL_MS) return undefined;

  const id = pickCoin(await get("/api/v3/search", { query: key }), key);
  if (id) {
    coinIdHits.set(key, id);
    coinIdMisses.delete(key);
  } else {
    coinIdMisses.set(key, Date.now());
  }
  return id;
}

/**
 * Pure parser for /api/v3/coins/{id}, split out so the response shape can be
 * tested without touching the network - it is the one piece of this flow
 * that cannot be checked against the live service from here.
 */
export function parseCoinResponse(
  body: unknown,
  symbol: string,
  platforms: Map<string, AssetPlatform>
): TokenInfo | undefined {
  const coin = body as { symbol?: unknown; name?: unknown; platforms?: unknown } | undefined;
  if (!coin || typeof coin !== "object") return undefined;

  const evm: TokenPlatform[] = [];
  const other: OtherPlatform[] = [];
  const seen = new Set<string>();

  const entries = coin.platforms && typeof coin.platforms === "object" ? coin.platforms : {};
  for (const [platformId, rawAddress] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof rawAddress !== "string") continue;
    const address = rawAddress.trim();
    if (!address) continue;

    const platform = platforms.get(platformId);
    const name = platform?.name ?? platformId;
    const dedupe = `${platformId}:${address.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    if (isAddress(address, { strict: false })) {
      evm.push({
        chainKey: resolveEvmPlatform(platform, platformId),
        platformName: name,
        tokenAddress: address as Address,
      });
      continue;
    }

    if (looksLikeAddress(address)) {
      other.push({
        chainKey: resolveNonEvmPlatform(platform, platformId),
        platformName: name,
        tokenAddress: address,
      });
    }
  }

  return {
    symbol: String(coin.symbol ?? symbol).toUpperCase(),
    name: String(coin.name ?? symbol),
    platforms: evm,
    otherPlatforms: other,
  };
}

/* ------------------------------------------------------------------ */

export interface KeyStatus {
  /** Whether a key is configured at all. */
  configured: boolean;
  /** Its length, never its value: a truncated paste is the usual fault. */
  keyLength: number;
  /** Whether the pasted value carries stray whitespace, the other usual fault. */
  untrimmed: boolean;
  base: string;
  header: string;
  /** Whether the service answered at all. */
  reachable: boolean;
  /** Whether the key was accepted, when there is one to accept. */
  accepted?: boolean;
  plan?: string;
  perMinute?: number;
  monthlyCredit?: number;
  monthlyUsed?: number;
  monthlyLeft?: number;
  /**
   * The key works, but this plan does not expose usage figures. A different
   * answer from "the key was refused", and the two arrive as the same 401.
   */
  quotaUnavailable?: boolean;
  error?: string;
}

/**
 * Reads /api/v3/key, which is what the Demo and Pro plans answer about
 * themselves. Kept pure so the shape can be checked offline, and defensive
 * about field names because they are not what this bot controls.
 */
export function parseKeyResponse(body: unknown): Partial<KeyStatus> {
  const b = (body ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  return {
    plan: typeof b.plan === "string" ? b.plan : undefined,
    perMinute: num(b.rate_limit_request_per_minute),
    monthlyCredit: num(b.monthly_call_credit),
    monthlyUsed: num(b.current_total_monthly_calls),
    monthlyLeft: num(b.current_remaining_monthly_calls),
  };
}

/**
 * Answers "is the key actually working" with a request rather than a guess.
 *
 * The key never appears in the answer - only its length and whether it was
 * pasted with whitespace, which are the two ways it usually goes wrong and
 * neither of which is visible in a hosting panel that masks the value.
 */
export async function checkKey(): Promise<KeyStatus> {
  const raw = env.coingeckoApiKey ?? "";
  const status: KeyStatus = {
    configured: raw.length > 0,
    keyLength: raw.length,
    untrimmed: raw !== raw.trim(),
    base: env.coingeckoApiBase,
    header: env.coingeckoApiBase.includes("pro-api") ? "x-cg-pro-api-key" : "x-cg-demo-api-key",
    reachable: false,
  };

  try {
    await get("/api/v3/ping");
    status.reachable = true;
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
    return status;
  }

  if (!status.configured) return status;

  // The usage endpoint first, because when it answers it answers everything:
  // the key was accepted and here is what is left of the quota.
  try {
    Object.assign(status, parseKeyResponse(await get("/api/v3/key")));
    status.accepted = true;
    return status;
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
  }

  // But its silence proves nothing about the key. /key is a plan feature,
  // and a plan that does not include it answers 401 - the same 401 as a key
  // that is wrong. So the key gets tested on the work the bot actually does:
  // if a real request carrying it succeeds, the key is good and only the
  // usage figures are out of reach.
  try {
    await get("/api/v3/search", { query: "bitcoin" });
    status.accepted = true;
    status.quotaUnavailable = true;
    return status;
  } catch (err) {
    // Both refused it. Now the key is genuinely the problem.
    status.accepted = false;
    status.error = err instanceof Error ? err.message : String(err);
    return status;
  }
}

/**
 * Looks a ticker up on CoinGecko and returns the token's contract address on
 * every network CoinGecko knows about.
 *
 * Note what this does NOT give us: the address of any bridge's custody
 * contract. CoinGecko only knows the token itself, which is why the bridge
 * side is resolved separately in src/bridges.
 */
export async function lookupToken(symbol: string): Promise<TokenInfo | undefined> {
  const id = await coinIdFor(symbol);
  // An unknown ticker is a normal answer, not a failure.
  if (!id) return undefined;

  // The platform list is a convenience, not a prerequisite. Losing it to a
  // rate limit must not lose the token as well: without it a network is
  // resolved by the slug's own spelling instead of by its chain id, which
  // is worse but is not nothing - and reporting a bridged token as
  // unbridged because a second request was throttled would be a lie.
  const [platforms, coin] = await Promise.all([
    assetPlatforms().catch((err) => {
      console.error("[coingecko] список сетей недоступен, сопоставляем по названиям:", err);
      return new Map<string, AssetPlatform>();
    }),
    get(`/api/v3/coins/${encodeURIComponent(id)}`, {
      localization: "false",
      tickers: "false",
      market_data: "false",
      community_data: "false",
      developer_data: "false",
      sparkline: "false",
    }),
  ]);

  return parseCoinResponse(coin, symbol, platforms);
}
