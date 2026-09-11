import { TON_CHAIN, toTonAddress } from "../config/tonChain";
import { endpointsWithOverride, env } from "../config/env";
import { findRegistryDeploymentsOnChain } from "./layerzero";
import type { NonEvmReadResult } from "./types";

/**
 * What LayerZero's adapters hold on TON.
 *
 * TON keeps a jetton balance in a wallet contract owned by the holder, not
 * in the holder itself, so there is no balance to read at the adapter's own
 * address. The index knows which wallets an address owns and what is in
 * them, which turns the whole question into one request - the alternative
 * being to encode a get-method call into a cell and then derive the wallet
 * address from the jetton master, a lot of machinery for a number that is
 * already published.
 */

const TIMEOUT_MS = 12_000;

/**
 * Attempts per request, and how long to wait between them.
 *
 * The index allows about one request a second without a key, and a report
 * asks it several times in a row while doing everything else at once - so a
 * refusal here is routine rather than exceptional. /ton read this adapter
 * seconds before /info reported the chain as unanswered, which is the whole
 * problem in one sentence.
 */
const ATTEMPTS = 3;

/**
 * Above a second, because the limit being waited out is about one request a
 * second. Seven hundred milliseconds was a polite way of being refused
 * twice more.
 */
const BACKOFF_MS = 1_200;

/**
 * How long to leave between requests of one read, when there is no key.
 *
 * A read asks for the adapter's wallets and then for each jetton's
 * decimals. Fired together they are two requests in the same instant, which
 * is exactly one more than the keyless tier allows.
 *
 * With a key the limit is no longer the binding constraint, and the wait
 * would be a second of every report paid for nothing.
 */
const SPACING_MS = 1_100;

function spacing(): number {
  return env.tonApiKey ? 0 : SPACING_MS;
}

/** Jetton wallets read per adapter. An adapter normally owns one. */
const MAX_WALLETS = 20;

export interface TonBalanceRow {
  protocol: "layerzero";
  chainKey: string;
  custodyAddress: string;
  tokenAddress: string;
  note?: string;
  amount: bigint;
  decimals: number;
}

/** The last thing the index said, so a failure can explain itself. */
let lastFailure: string | undefined;

/**
 * A jetton's decimals and symbol, kept for the life of the process.
 *
 * They are a property of the token, not of the moment, and re-asking for
 * them is what spends a rate limit that has to cover the balance itself.
 */
const masterCache = new Map<string, { decimals: number; symbol?: string }>();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url: string): Promise<any | undefined> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // A free key raises the limit from roughly one request a second to
  // something a report can live with. Optional, because the index answers
  // without one and a bot nobody has configured should still work.
  if (env.tonApiKey) headers["X-API-Key"] = env.tonApiKey;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.ok) return await response.json();
      lastFailure =
        response.status === 429
          ? `индекс TON ответил 429 — лимит запросов${
              env.tonApiKey
                ? ", попробуйте через минуту"
                : ". Лечится бесплатным ключом: toncenter.com → API key, затем переменная TON_API_KEY"
            }`
          : `индекс TON ответил HTTP ${response.status}`;
      // Only a refusal is worth repeating. A 404 will be a 404 next time.
      if (response.status !== 429 && response.status < 500) return undefined;
    } catch (err) {
      // A timeout is worth one more try for the same reason a 429 is.
      lastFailure = `запрос к индексу TON не прошёл: ${
        (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 80)
      }`;
    }
    if (attempt < ATTEMPTS - 1) await wait(BACKOFF_MS * (attempt + 1));
  }
  return undefined;
}

interface JettonHolding {
  jetton: string;
  balance: bigint;
  wallet: string;
}

/**
 * Two ticker spellings, compared the way a person would.
 *
 * Tether writes the jetton's symbol with a tugrik - USD₮ - and stripping
 * everything but letters and digits leaves "USD", which does not begin with
 * "USDT0". So the wallets were found and then thrown away by the filter
 * meant to pick them. The EVM side already replaces that character; this
 * reader did not.
 *
 * Either may be a prefix of the other, because a bridged token is routinely
 * listed under a longer name than the jetton it locks - USDT0 against USD₮ -
 * and three characters at least before that counts, or short tickers start
 * matching each other.
 */
const MIN_SHARED_PREFIX = 3;

export function symbolsAgree(jettonSymbol: string | undefined, wanted: string): boolean {
  const clean = (value: string) =>
    value.replace(/₮/g, "T").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const a = clean(jettonSymbol ?? "");
  const b = clean(wanted);
  if (!a || !b) return false;
  if (a === b) return true;
  return Math.min(a.length, b.length) >= MIN_SHARED_PREFIX && (a.startsWith(b) || b.startsWith(a));
}

/**
 * A body in a few words, for a failure message.
 *
 * Enough to recognise an error object, a login page or an empty answer, and
 * short enough to sit in a chat message beside the chain it explains.
 */
export function describeBody(body: unknown): string {
  if (body === null || body === undefined) return "пусто";
  if (typeof body !== "object") return String(body).slice(0, 80);
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length === 0) return "пустой объект";
  const error = (body as { error?: unknown; detail?: unknown }).error ?? (body as { detail?: unknown }).detail;
  if (error !== undefined) return `ошибка «${String(error).slice(0, 80)}»`;
  return `поля: ${keys.slice(0, 6).join(", ")}`;
}

/** Parsed apart from the fetch, so the response shape is covered by a test. */
export function parseJettonWallets(body: unknown): JettonHolding[] {
  const wallets = (body as { jetton_wallets?: unknown })?.jetton_wallets;
  if (!Array.isArray(wallets)) return [];
  const held: JettonHolding[] = [];
  for (const w of wallets as Array<Record<string, unknown>>) {
    const jetton = typeof w.jetton === "string" ? w.jetton : undefined;
    const balance = typeof w.balance === "string" ? w.balance : undefined;
    const wallet = typeof w.address === "string" ? w.address : "";
    if (!jetton || !balance) continue;
    try {
      held.push({ jetton, balance: BigInt(balance), wallet });
    } catch {
      // A balance the index could not express as digits is not a balance.
    }
  }
  return held;
}

/** The same for a jetton's own metadata, which is where decimals live. */
export function parseJettonMaster(body: unknown): { decimals: number; symbol?: string } | undefined {
  const masters = (body as { jetton_masters?: unknown })?.jetton_masters;
  const first = Array.isArray(masters) ? (masters[0] as Record<string, any>) : undefined;
  // No entry means the index does not know this jetton, which is not the
  // same as a jetton that declares no decimals. Defaulting here would put a
  // number on a token nobody confirmed exists.
  if (!first) return undefined;
  const content = first.jetton_content;
  const raw = content?.decimals;
  // TON's metadata standard stores decimals as a string, and some jettons
  // omit it entirely - the standard's default is nine.
  const decimals = raw === undefined || raw === null ? 9 : Number(raw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return undefined;
  return { decimals, symbol: typeof content?.symbol === "string" ? content.symbol : undefined };
}

/** The index actually in use, for a diagnostic that has to name it. */
export function tonApiBase(): string {
  return bases()[0] ?? "нет адреса";
}

function bases(): string[] {
  return endpointsWithOverride(TON_CHAIN.rpcEnvVar, [...TON_CHAIN.apiUrls]).map((u) =>
    u.replace(/\/+$/, "")
  );
}

/**
 * Reads every LayerZero adapter on TON that carries this ticker.
 *
 * An adapter that turns out to hold nothing is still reported, as a zero
 * row: an empty vault is the most useful answer a liquidity report can give
 * about a route, and the one most often mistaken for an unchecked one.
 */
export async function findTonBalances(
  symbol: string,
  knownJetton?: string
): Promise<NonEvmReadResult<TonBalanceRow>> {
  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const reasons: Record<string, string> = {};
  lastFailure = undefined;

  const deployments = (await findRegistryDeploymentsOnChain(symbol, TON_CHAIN.key)).filter(
    (d) => d.locksCollateral
  );
  if (deployments.length === 0) return { rows: [], attempts, failures };

  attempts[TON_CHAIN.key] = deployments.length;
  const wanted = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const rows: TonBalanceRow[] = [];
  for (const deployment of deployments) {
    const owner = toTonAddress(deployment.address);
    if (!owner) {
      failures[TON_CHAIN.key] = (failures[TON_CHAIN.key] ?? 0) + 1;
      lastFailure = `адрес из реестра не похож на адрес TON: ${deployment.address.slice(0, 20)}…`;
      continue;
    }

    let holdings: JettonHolding[] = [];
    for (const base of bases()) {
      // Asked for the jetton wanted, when it is known, rather than listed
      // and filtered afterwards. Anyone can send a worthless jetton to any
      // address on TON, and a wallet appears under it: this adapter owns
      // eight, seven of them named SUR-3.5, NEC, KYU, AMD and the like.
      // Listing everything and guessing by symbol was answering a question
      // about spam. The address of the jetton is published - the price API
      // lists it for TON - and an address cannot be spoofed by naming.
      const filter = knownJetton ? `&jetton_address=${encodeURIComponent(knownJetton)}` : "";
      const url = `${base}/jetton/wallets?owner_address=${encodeURIComponent(owner)}${filter}&limit=${MAX_WALLETS}`;
      const body = await getJson(url);
      holdings = parseJettonWallets(body);
      if (holdings.length > 0) break;

      // Every way this can end has to say which way it was. A body that
      // arrived whole and held no wallets is a different fact from a
      // refusal, and an empty list is a different fact again - that one is
      // the index saying the adapter owns nothing, which may be true.
      // Reported identically, they are indistinguishable from each other
      // and from a key pointed at the wrong service, which answers 200 all
      // day long.
      if (body === undefined) continue;
      const listed = (body as { jetton_wallets?: unknown }).jetton_wallets;
      lastFailure = Array.isArray(listed)
        ? knownJetton
          ? `у адаптера нет кошелька этого джеттона — он ничего не держит`
          : `индекс вернул пустой список кошельков для этого адреса`
        : `индекс ответил без поля jetton_wallets: ${describeBody(body)}`;
    }

    if (holdings.length === 0) {
      // Unread, not empty: an adapter with no wallets listed is far more
      // likely an index that would not answer than a vault that holds
      // nothing, and the two must not be reported the same way.
      failures[TON_CHAIN.key] = (failures[TON_CHAIN.key] ?? 0) + 1;
      continue;
    }

    // Which jetton is the one asked about. An adapter normally owns exactly
    // one wallet, and then there is nothing to choose; where it owns several,
    // the jetton's own symbol decides, because picking the largest balance
    // would answer a different question than the one asked.
    // One at a time, with a gap. Asked together these are several requests
    // in the same instant, and the free tier allows about one a second - so
    // the parallel version spent its whole allowance on being refused.
    const known: Array<JettonHolding & { decimals: number; symbol?: string }> = [];
    for (const h of holdings) {
      const cached = masterCache.get(h.jetton);
      if (cached) {
        known.push({ ...h, ...cached });
        continue;
      }
      for (const base of bases()) {
        if (spacing() > 0) await wait(spacing());
        const meta = parseJettonMaster(
          await getJson(`${base}/jetton/masters?address=${encodeURIComponent(h.jetton)}&limit=1`)
        );
        if (meta) {
          masterCache.set(h.jetton, meta);
          known.push({ ...h, ...meta });
          break;
        }
      }
    }

    if (known.length === 0) {
      // Wallets were listed and none of their jettons could be described,
      // which is a different failure from finding no wallets at all.
      failures[TON_CHAIN.key] = (failures[TON_CHAIN.key] ?? 0) + 1;
      lastFailure = lastFailure ?? "кошельки нашлись, но метаданные джеттонов индекс не отдал";
      continue;
    }

    // With the jetton named, the index already returned only its wallet and
    // there is nothing left to choose. Without it, the symbol is all there
    // is - and on a chain where anyone can mint a name, that is a guess.
    const matching = knownJetton || known.length === 1 ? known : known.filter((k) => symbolsAgree(k.symbol, wanted));

    if (matching.length === 0) {
      failures[TON_CHAIN.key] = (failures[TON_CHAIN.key] ?? 0) + 1;
      lastFailure =
        `адрес джеттона неизвестен, а из ${known.length} кошельков адаптера ни один ` +
        `не назвался похоже на ${wanted}: ` +
        known.map((k) => k.symbol ?? "без символа").slice(0, 5).join(", ") +
        ". Похоже на спам-джеттоны — под любой адрес TON их может прислать кто угодно.";
      continue;
    }

    for (const held of matching) {
      rows.push({
        protocol: "layerzero" as const,
        chainKey: TON_CHAIN.key,
        custodyAddress: owner,
        tokenAddress: held.jetton,
        note: deployment.viaAlias ?? deployment.rawType,
        amount: held.balance,
        decimals: held.decimals,
      });
    }
  }

  if (failures[TON_CHAIN.key] && lastFailure) reasons[TON_CHAIN.key] = lastFailure;
  return { rows, attempts, failures, reasons };
}
