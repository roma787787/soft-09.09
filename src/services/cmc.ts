import type { Address } from "viem";
import { isAddress } from "viem";
import { env } from "../config/env";
import { CHAINS } from "../config/chains";
import { SVM_CHAINS } from "../config/svmChains";

export class CmcNotConfiguredError extends Error {}
export class CmcRequestError extends Error {}

export interface TokenPlatform {
  /** Our internal chain key, when the platform is one we support. */
  chainKey?: string;
  /** CoinMarketCap's own name for the network, kept for unsupported chains. */
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
  /** Base58 on Solana, and whatever the chain uses elsewhere. */
  tokenAddress: string;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  platforms: TokenPlatform[];
  /** Deployments on non-EVM chains, which have addresses of another shape. */
  otherPlatforms: OtherPlatform[];
}

/**
 * CoinMarketCap names networks in its own way ("BNB Smart Chain (BEP20)"),
 * so each chain declares the spellings it answers to. Matching is done on a
 * normalised string to survive punctuation and casing changes.
 */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolvePlatform(platformName: string, slug: string | undefined): string | undefined {
  const candidates = [normalise(platformName), slug ? normalise(slug) : ""].filter(Boolean);
  for (const chain of CHAINS) {
    const names = [chain.key, chain.label, ...(chain.cmcPlatformNames ?? [])].map(normalise);
    if (candidates.some((c) => names.includes(c))) return chain.key;
  }
  return undefined;
}

/** The same, for the chains the bot reads without viem. */
function resolveSvmPlatform(platformName: string, slug: string | undefined): string | undefined {
  const candidates = [normalise(platformName), slug ? normalise(slug) : ""].filter(Boolean);
  for (const chain of SVM_CHAINS) {
    const names = [chain.key, chain.label, ...(chain.cmcPlatformNames ?? [])].map(normalise);
    if (candidates.some((c) => names.includes(c))) return chain.key;
  }
  return undefined;
}

/**
 * Solana and its relatives use base58, not hex. Loose on purpose: this only
 * decides whether an address is worth keeping, and every use of it is
 * verified against the chain afterwards.
 */
function looksLikeBase58Address(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/**
 * Looks a ticker up on CoinMarketCap and returns the token's contract
 * address on every network CMC knows about.
 *
 * Note what this does NOT give us: the address of any bridge's custody
 * contract. CMC only knows the token itself, which is why the bridge side
 * is resolved separately in src/bridges.
 */
export async function lookupToken(symbol: string): Promise<TokenInfo | undefined> {
  if (!env.cmcApiKey) {
    throw new CmcNotConfiguredError("CMC_API_KEY не задан");
  }

  const url = new URL("/v2/cryptocurrency/info", env.cmcApiBase);
  url.searchParams.set("symbol", symbol.toUpperCase());
  url.searchParams.set("aux", "platform");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "X-CMC_PRO_API_KEY": env.cmcApiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new CmcRequestError(err instanceof Error ? err.message : String(err));
  }

  // Read the body before judging the status: CoinMarketCap explains itself
  // in status.error_code / error_message, and a rejection has several very
  // different causes that the HTTP code alone cannot tell apart.
  const body = (await response.json().catch(() => undefined)) as any;
  const cmcCode: number | undefined = body?.status?.error_code || undefined;
  const cmcMessage: string | undefined = body?.status?.error_message || undefined;

  if (!response.ok || cmcCode) {
    // An unknown ticker is a normal answer, not a failure.
    if (response.status === 400 && !isKeyOrPlanProblem(cmcCode)) return undefined;
    throw new CmcRequestError(describeCmcFailure(response.status, cmcCode, cmcMessage));
  }

  if (!body) throw new CmcRequestError("CoinMarketCap вернул неразборчивый ответ");

  return parseCmcInfoResponse(body, symbol);
}


/** Codes that mean the key itself, or the plan behind it, is the problem. */
function isKeyOrPlanProblem(code: number | undefined): boolean {
  return code !== undefined && [1001, 1002, 1006, 1010, 1011].includes(code);
}

/**
 * Turns a CoinMarketCap rejection into something actionable. The same HTTP
 * status covers "your key is wrong" and "your plan does not include this
 * endpoint", which need completely different fixes, so the reply always
 * carries CMC's own code and text.
 */
function describeCmcFailure(httpStatus: number, code: number | undefined, message: string | undefined): string {
  const detail = [code ? `код ${code}` : undefined, message].filter(Boolean).join(", ");
  const suffix = detail ? `\n\nОтвет CoinMarketCap: ${detail}` : `\n\nHTTP ${httpStatus}`;

  switch (code) {
    case 1001:
    case 1002:
      return `ключ API не принят. Проверьте, что в переменную CMC_API_KEY попал ключ целиком, без пробелов и без звёздочек из маскировки.${suffix}`;
    case 1006:
      return `тариф не даёт доступ к этому эндпоинту. Нужен доступ к /v2/cryptocurrency/info.${suffix}`;
    case 1010:
      return `ключ отключён в кабинете CoinMarketCap.${suffix}`;
    case 1011:
      return `тариф требует оплаты или продления.${suffix}`;
    case 1008:
    case 1009:
      return `превышен лимит запросов, попробуйте через минуту.${suffix}`;
    default:
      if (httpStatus === 401 || httpStatus === 403) {
        return `доступ отклонён. Обычно это неверный ключ либо тариф без нужного эндпоинта.${suffix}`;
      }
      if (httpStatus === 429) return `превышен лимит запросов.${suffix}`;
      return `запрос не прошёл.${suffix}`;
  }
}

/**
 * Pure parser for the /v2/cryptocurrency/info payload, split out so the
 * response shape can be tested without an API key - it is the one piece of
 * this flow that cannot be checked against the live service here.
 */
export function parseCmcInfoResponse(body: any, symbol: string): TokenInfo | undefined {
  const entries = body.data?.[symbol.toUpperCase()];
  const coin = Array.isArray(entries) ? entries[0] : entries;
  if (!coin) return undefined;

  const platforms: TokenPlatform[] = [];
  const otherPlatforms: OtherPlatform[] = [];
  const seen = new Set<string>();

  const push = (rawAddress: unknown, platformName: unknown, slug?: unknown) => {
    if (typeof rawAddress !== "string") return;
    const name = typeof platformName === "string" ? platformName : "неизвестная сеть";
    const key = `${normalise(name)}:${rawAddress.toLowerCase()}`;
    if (seen.has(key)) return;
    const slugText = typeof slug === "string" ? slug : undefined;

    if (isAddress(rawAddress, { strict: false })) {
      seen.add(key);
      platforms.push({
        chainKey: resolvePlatform(name, slugText),
        platformName: name,
        tokenAddress: rawAddress as Address,
      });
      return;
    }

    // Not hex, so not EVM. Dropping these outright is what hid every
    // non-EVM deployment - Solana included - long before anything got a
    // chance to look at it.
    if (looksLikeBase58Address(rawAddress)) {
      seen.add(key);
      otherPlatforms.push({
        chainKey: resolveSvmPlatform(name, slugText),
        platformName: name,
        tokenAddress: rawAddress,
      });
    }
  };

  // Newer responses carry every deployment in contract_address[];
  // older ones only carry the single `platform` object.
  if (Array.isArray(coin.contract_address)) {
    for (const entry of coin.contract_address) {
      push(entry?.contract_address, entry?.platform?.name, entry?.platform?.coin?.slug);
    }
  }
  if (coin.platform) {
    push(coin.platform.token_address, coin.platform.name, coin.platform.slug);
  }

  return {
    symbol: String(coin.symbol ?? symbol).toUpperCase(),
    name: String(coin.name ?? symbol),
    platforms,
    otherPlatforms,
  };
}
