import { getChain, chainMeta } from "../config/chains";
import {
  BRIDGE_LABELS,
  BRIDGE_ORDER,
  BRIDGE_SHORT_LABELS,
  BRIDGE_UNITS,
  type BridgeProtocol,
} from "../bridges/types";
import { formatAmount, type BalanceRow } from "../services/balances";

/**
 * Telegram counts a message "after entities parsing" - tags and entities do
 * not count toward the 4096 limit, only the text a person sees. Every row
 * here carries an explorer link, so the raw HTML runs several times longer
 * than the message does, and budgeting against the HTML threw away reports
 * that would have fitted with room to spare.
 */
function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#\d+);/g, "\u0001").length;
}

/** Telegram's own limit, with a margin for the notice appended on a cut. */
const MAX_MESSAGE_CHARS = 4000;

/** Rows shown per protocol per chain before the rest are summarised. */
const MAX_ROWS_PER_GROUP = 3;

/**
 * Re-closes tags left open by a cut. Telegram parses the whole message as
 * HTML and rejects it outright if a tag is unbalanced, so a careless
 * truncation produces the same generic failure the cap exists to avoid.
 */
function closeOpenTags(text: string): string {
  const open: string[] = [];
  const tag = /<(\/?)([a-zA-Z]+)[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(text))) {
    const name = m[2].toLowerCase();
    if (m[1]) {
      const at = open.lastIndexOf(name);
      if (at >= 0) open.splice(at, 1);
    } else {
      open.push(name);
    }
  }
  return text + open.reverse().map((name) => `</${name}>`).join("");
}

/**
 * Last-resort guard. The per-chain budget bounds the body, but the closing
 * notes grow with the number of chains, and a message Telegram refuses is
 * indistinguishable to the user from the bot being broken.
 *
 * Every line the report builds is self-contained markup, so a line boundary
 * is the safe place to cut. A single line longer than the budget has no such
 * boundary; there the cut is repaired instead - the half-written tag or HTML
 * entity is dropped and whatever it left open is closed.
 */
export function capToTelegramLimit(text: string): string {
  if (visibleLength(text) <= MAX_MESSAGE_CHARS) return text;

  const budget = MAX_MESSAGE_CHARS - 50;
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split("\n")) {
    const cost = visibleLength(line) + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }

  // A single line longer than the whole budget leaves no boundary to cut
  // on; there the half-written tag or entity is dropped instead.
  const cut =
    kept.length > 0
      ? kept.join("\n")
      : text.slice(0, budget).replace(/<[^>]*$/, "").replace(/&[^;\s]*$/, "");

  return `${closeOpenTags(cut)}\n\n… отчёт обрезан, чтобы уместиться в сообщение.`;
}

/** How many messages one report may spend before it starts leaving things out. */
const MAX_PARTS = 6;

/**
 * The report's own blocks, each ending with the blank line that follows it.
 *
 * Breaking between any two lines put a message boundary through the middle
 * of a chain: the next message opened with a bare " - Hyperlane (Warp
 * Route): 46 489 USDC", with no way to tell which network it belonged to,
 * and Telegram strips the leading spaces so it did not even read as a
 * continuation. A chain is one thing and has to arrive as one.
 */
function sectionsOf(text: string): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    current.push(line);
    if (line === "") {
      sections.push(current);
      current = [];
    }
  }
  if (current.length > 0) sections.push(current);
  return sections;
}

/**
 * Splits a report across messages instead of cutting it short.
 *
 * Telegram limits one message, not one reply, and the limit was being paid
 * for by the report: USDC checked 231 contracts and dropped twenty-two
 * networks to fit - more than it showed. Anyone reading that would conclude
 * the bot does not cover those chains, which is the exact complaint this
 * whole line of work started from, and by then it would be wrong.
 *
 * Every line the report builds is self-contained markup, so a line boundary
 * is a safe place to break and no tag needs repairing across parts.
 */
export function splitForTelegram(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let used = 0;

  const flush = () => {
    if (current.length > 0) parts.push(current.join("\n"));
    current = [];
    used = 0;
  };

  for (const section of sectionsOf(text)) {
    const cost = visibleLength(section.join("\n")) + 1;
    // A section longer than a whole message has no boundary of its own, so
    // it falls back to breaking between its lines.
    if (cost > MAX_MESSAGE_CHARS) {
      flush();
      for (const line of section) {
        const lineCost = visibleLength(line) + 1;
        if (used + lineCost > MAX_MESSAGE_CHARS && current.length > 0) flush();
        current.push(line);
        used += lineCost;
      }
      continue;
    }
    if (used + cost > MAX_MESSAGE_CHARS) flush();
    current.push(...section);
    used += cost;
  }
  flush();
  if (parts.length === 0) return [text];
  if (parts.length <= MAX_PARTS) return parts;

  // Still bounded: a hundred messages is its own kind of broken. What is left
  // out is counted rather than dropped in silence.
  const kept = parts.slice(0, MAX_PARTS);
  const dropped = parts.length - MAX_PARTS;
  kept[MAX_PARTS - 1] +=
    `\n\n… и ещё ${dropped} ${plural(dropped, "сообщение", "сообщения", "сообщений")} отчёта не поместилось. ` +
    "Спросите по одной сети: <code>/info &lt;тикер&gt; &lt;сеть&gt;</code>";
  return kept;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Russian noun agreement: 1 сеть, 2 сети, 5 сетей, with the 11-14 exception.
 * The whole interface is Russian, and "1 сетей" reads as a broken product.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export interface ReportInput {
  symbol: string;
  name: string;
  balances: BalanceRow[];
  checkedCount: number;
  failuresByChain: Record<string, number>;
  attemptsByChain: Record<string, number>;
  /** Chains where the token itself is a LayerZero OFT that mints its supply. */
  nativeOftChains?: string[];
  /** Chains with a Hyperlane route that mints instead of locking. */
  syntheticHyperlaneChains?: string[];
  /**
   * Bridges found on a chain that mint rather than hold, by bridge.
   *
   * Not the same statement as "the vault is empty", and the difference is
   * the whole point: an empty vault might fill, a mint-burn deployment never
   * holds anything at all. Reporting one as the other says the bridge is
   * here and out of stock about a bridge that was never carrying stock, and
   * sends someone looking for liquidity that cannot exist.
   */
  mintsOnly?: Array<{ chainKey: string; protocol: BridgeProtocol }>;
  /** Registry adapters skipped because they lock a different contract. */
  mismatchedAdapters?: number;
  /** Contracts that reverted rather than answering with a balance. */
  notReadableByChain?: Record<string, number>;
  /**
   * Why a chain could not be read, where the reader knows.
   *
   * "TON did not answer" and "TON's index refused on a rate limit" send the
   * reader to different places, and only one of them is a problem they can
   * do anything about.
   */
  failureReasons?: Record<string, string>;
  /**
   * Chains where the token exists but no tracked bridge holds any of it.
   *
   * The customer's question, verbatim: does the report say whether there are
   * tokens on Robinhood Chain or not? It did not - a chain with no custody
   * contract produced no row and no mention, so "checked, no bridge there"
   * looked exactly like "not checked".
   */
  supplyOnly?: Array<{ chainKey: string; amount?: bigint; decimals?: number; unreadable?: boolean }>;
  /** Where the check reached, so a small number is explained, not puzzling. */
  scope?: {
    /** Chains CoinGecko listed that this bot supports. */
    supportedChains: string[];
    /** Networks CoinGecko listed that this bot does not cover. */
    unsupportedPlatforms: string[];
    /** How many contracts each bridge contributed. */
    byProtocol: Partial<Record<BridgeProtocol, number>>;
    /**
     * Which bridges were actually consulted for this token.
     *
     * A bridge that contributed nothing was simply absent from the report,
     * so "asked Stargate, it has no pool for this ticker" looked exactly
     * like "Stargate is not implemented" - and that is the reading the bot
     * keeps getting back as a bug. Naming what was asked is the same rule
     * the rest of this report already follows for empty chains.
     */
    checkedProtocols?: BridgeProtocol[];
    /** Why a checked bridge found nothing, where the reason is known. */
    notFoundNotes?: Partial<Record<BridgeProtocol, string>>;
    /**
     * True while the chain table is still being built.
     *
     * Discovery runs in the background and adds most of the long tail, so a
     * report issued before it finishes lists chains as unchecked that the
     * next report covers. Saying "the bot does not check this network" is a
     * claim; while the list is incomplete it is one the bot cannot make.
     */
    chainListIncomplete?: boolean;
  };
}

/**
 * Explains the size of the check. "Checked 2 contracts" invites the obvious
 * question of why only two, and the answer is always the same three inputs:
 * the chains CoinGecko knows the token on, the warp routes carrying that
 * ticker, and the adapters someone entered by hand.
 */
function scopeLines(scope: ReportInput["scope"]): string[] {
  if (!scope) return [];
  // Each bridge names its own unit: a warp route, an adapter and a shared
  // vault are different things, and the difference is what explains why one
  // bridge contributes twelve rows and another contributes one.
  const parts = BRIDGE_ORDER.filter((p) => (scope.byProtocol[p] ?? 0) > 0).map((p) => {
    const n = scope.byProtocol[p] ?? 0;
    return `${BRIDGE_SHORT_LABELS[p]} — ${n} ${plural(n, ...BRIDGE_UNITS[p])}`;
  });
  const lines = parts.length > 0 ? [`Откуда взялись контракты: ${parts.join(", ")}.`] : [];

  const checked = new Set(scope.checkedProtocols ?? []);
  const notFound = BRIDGE_ORDER.filter((p) => checked.has(p) && (scope.byProtocol[p] ?? 0) === 0);
  if (notFound.length > 0) {
    lines.push(
      `Проверены, но хранилищ под этот тикер не нашлось: ${notFound.map((p) => BRIDGE_SHORT_LABELS[p]).join(", ")}.`
    );
    for (const p of notFound) {
      const note = scope.notFoundNotes?.[p];
      if (note) lines.push(`${BRIDGE_SHORT_LABELS[p]}: ${esc(note)}`);
    }
  }

  if (scope.supportedChains.length > 0) {
    lines.push(`CoinGecko знает токен в сетях: ${esc(scope.supportedChains.join(", "))}.`);
  }
  if (scope.unsupportedPlatforms.length > 0) {
    lines.push(
      scope.chainListIncomplete
        ? `Эти сети пока не в списке — он ещё достраивается, спросите через пару минут: ${esc(scope.unsupportedPlatforms.slice(0, 8).join(", "))}.`
        : `Ещё в этих сетях бот их не проверяет: ${esc(scope.unsupportedPlatforms.slice(0, 8).join(", "))}.`
    );
  }
  return lines;
}

/**
 * Names the chains where the token is, but the bridges are not.
 *
 * Two facts, kept apart on purpose: the token exists there, and nothing the
 * bot tracks holds it. Together they say the only useful thing - that it
 * reached that chain by some route this bot does not follow, so it cannot be
 * withdrawn through the ones it does. Separately, the first alone would read
 * as liquidity and the second alone as an oversight.
 */
function supplyOnlyLines(supplyOnly: ReportInput["supplyOnly"]): string[] {
  if (!supplyOnly || supplyOnly.length === 0) return [];

  const described = supplyOnly.map((s) => {
    const name = esc(chainName(s.chainKey));
    if (s.amount === undefined || s.decimals === undefined) {
      // Which of the two, because the report blames one of them out loud and
      // the fixes are different: a node needs an RPC, a contract needs
      // nothing at all.
      return s.unreadable ? `${name} (контракт не отдаёт выпуск)` : `${name} (узел не ответил)`;
    }
    if (s.amount === 0n) return `${name} (выпуска нет)`;
    return `${name} — выпущено ${esc(formatAmount(s.amount, s.decimals))}`;
  });

  return [
    `ℹ️ Токен есть в этих сетях, но ни один отслеживаемый мост там ничего не держит: ${described.join(", ")}.`,
    "Значит, он попал туда мостом, которого бот не знает, либо выпущен там сам — вывести его через мосты из этого отчёта нельзя.",
  ];
}

function chainName(chainKey: string): string {
  return chainMeta(chainKey)?.label ?? chainKey;
}

/**
 * Splits chains with failed reads into the two cases that need different
 * wording: nothing came back at all, versus part of the chain came back and
 * is in the report above.
 */
function describeFailures(
  balances: BalanceRow[],
  failuresByChain: Record<string, number>,
  attemptsByChain: Record<string, number>
): { unreachable: string[]; partial: string[] } {
  const succeededByChain: Record<string, number> = {};
  for (const b of balances) succeededByChain[b.chainKey] = (succeededByChain[b.chainKey] ?? 0) + 1;

  const unreachable: string[] = [];
  const partial: string[] = [];

  for (const [chainKey, failures] of Object.entries(failuresByChain)) {
    if (failures === 0) continue;
    const succeeded = succeededByChain[chainKey] ?? 0;
    if (succeeded === 0) {
      unreachable.push(chainName(chainKey));
    } else {
      partial.push(`${chainName(chainKey)} (${failures} из ${attemptsByChain[chainKey] ?? failures})`);
    }
  }

  return { unreachable, partial };
}

/**
 * Normalises an amount to 18 decimals.
 *
 * Routes under one ticker do not all hold the same contract, and those
 * contracts do not all use the same number of decimals. Comparing or adding
 * the raw integers then produces nonsense - an 18-decimal balance outranks
 * any 6-decimal one by a factor of a trillion regardless of its real value.
 * Every comparison and every total goes through this first.
 */
function toCommonScale(amount: bigint, decimals: number): bigint {
  const shift = 18 - decimals;
  return shift >= 0 ? amount * 10n ** BigInt(shift) : amount / 10n ** BigInt(-shift);
}

function rank(b: BalanceRow): bigint {
  return toCommonScale(b.amount, b.decimals);
}

/** Total of a group, on the common 18-decimal scale. */
function sumOf(rows: BalanceRow[]): bigint {
  return rows.reduce((total, r) => total + rank(r), 0n);
}

/**
 * Renders the liquidity report.
 *
 * A widely bridged token can have well over a hundred custody contracts -
 * USDC alone has more than a hundred Hyperlane routes - and printing them
 * all produces a message several times Telegram's limit, which fails to
 * send and surfaces as a useless error. So each chain shows its largest
 * holders and summarises the tail, and the whole thing is capped.
 *
 * Route balances are deliberately not added up into one number: each route
 * is a separate pool, and a withdrawal can only draw on the one it went
 * through. The tail total is shown as context, clearly labelled.
 */
export function renderLiquidityReport(input: ReportInput): string {
  const {
    symbol,
    name,
    balances,
    checkedCount,
    failuresByChain,
    attemptsByChain,
    nativeOftChains: claimedNativeOft = [],
    syntheticHyperlaneChains = [],
    mismatchedAdapters = 0,
    scope,
  } = input;
  // A chain where LayerZero was found holding something cannot also be a
  // chain where LayerZero holds nothing by construction. USDT's report said
  // both about Arbitrum One in one message - an OFT Adapter with 7.3 million
  // in it, and a line underneath explaining that there is no vault there.
  //
  // Both readings come from real contracts: the token's own address answers
  // like a native OFT while a separate adapter locks collateral. But the
  // claim is about the bridge on that chain, and the vault the report just
  // printed settles it.
  const chainsWithLayerZeroRow = new Set(
    balances.filter((b) => b.protocol === "layerzero").map((b) => b.chainKey)
  );
  const nativeOftChains = claimedNativeOft.filter((c) => !chainsWithLayerZeroRow.has(c));

  const withLiquidity = balances.filter((b) => b.amount > 0n);
  const { unreachable, partial } = describeFailures(balances, failuresByChain, attemptsByChain);

  const header = `Токен: <b>${esc(symbol)}</b> — ${esc(name)}`;

  if (withLiquidity.length === 0) {
    const lines = [header, "", `Проверено контрактов: ${checkedCount}. Ни на одном из них токена сейчас нет.`];
    // "No balance anywhere" and "bridged by a design that holds nothing" are
    // completely different answers, and only the first means the token is
    // not bridged. Saying so without checking would be plainly wrong.
    if (nativeOftChains.length > 0) {
      lines.push(
        "",
        `<b>Это омничейн-токен LayerZero (OFT)</b> в сетях: ${esc(nativeOftChains.map(chainName).join(", "))}.`,
        "У такого токена нет контракта-хранилища: при переводе он сжигается в одной сети и чеканится в другой. Мерить там нечего, и запас ликвидности ему не нужен.",
        "Ограничение на вывод задаёт не баланс, а настройки самого моста."
      );
    }
    if (syntheticHyperlaneChains.length > 0) {
      lines.push(
        "",
        `Есть маршруты Hyperlane в сетях ${esc(syntheticHyperlaneChains.map(chainName).join(", "))}, но они синтетические: тоже чеканят supply, а не блокируют его.`
      );
    }
    if (nativeOftChains.length === 0 && syntheticHyperlaneChains.length === 0 && unreachable.length === 0 && partial.length === 0) {
      lines.push(
        "Через известные боту мосты этот токен не заведён.",
        "",
        "<b>Если он ходит через LayerZero</b>, но в реестре OFT его нет, адрес адаптера ищется вручную:",
        "1. Открыть токен в эксплорере, вкладка Holders.",
        "2. Найти контракт с самым большим балансом — обычно это и есть адаптер, он держит заблокированный запас.",
        "3. Проверить его: <code>/info &lt;адрес&gt; &lt;сеть&gt;</code>. Бот подтвердит, что это OFT Adapter, и покажет связанные сети.",
        "4. Добавить адрес в <code>config/layerzero-lockboxes.json</code>.",
        "",
        "Альтернатива — layerzeroscan.com, раздел Applications, и документация самого проекта."
      );
    }
    if (unreachable.length > 0) {
      lines.push("", `⚠️ Сети, которые не ответили совсем: ${esc(unreachable.join(", "))}.`);
    }
    const supplyText = supplyOnlyLines(input.supplyOnly);
    if (supplyText.length > 0) lines.push("", ...supplyText);
    const scopeText = scopeLines(scope);
    if (scopeText.length > 0) lines.push("", ...scopeText);
    return capToTelegramLimit(lines.join("\n"));
  }

  const byChain = new Map<string, BalanceRow[]>();
  for (const b of withLiquidity) {
    if (!byChain.has(b.chainKey)) byChain.set(b.chainKey, []);
    byChain.get(b.chainKey)!.push(b);
  }

  // Bridges that answered with zero. For a report about whether funds can be
  // withdrawn, this is the single most useful answer there is - "this route
  // is empty, do not send here" - and hiding it made an empty route look
  // exactly like one that was never checked.
  const emptyByChain = new Map<string, Set<BridgeProtocol>>();
  for (const b of balances) {
    if (b.amount > 0n) continue;
    if (!emptyByChain.has(b.chainKey)) emptyByChain.set(b.chainKey, new Set());
    emptyByChain.get(b.chainKey)!.add(b.protocol);
  }

  const chains = [...byChain.entries()]
    .map(([chainKey, rows]) => ({
      chainKey,
      rows,
      top: rows.reduce((max, r) => (rank(r) > max ? rank(r) : max), 0n),
    }))
    .sort((a, b) => (b.top > a.top ? 1 : b.top < a.top ? -1 : 0));

  const notes: string[] = [];
  const notReadable = Object.values(input.notReadableByChain ?? {}).reduce((a, b) => a + b, 0);
  if (notReadable > 0) {
    // Named, but not as a warning: these are contracts that answered, just
    // not with a balance. Counting them among the connection failures made
    // the report blame a chain's node for a contract's own shape.
    notes.push(
      `${notReadable} ${plural(notReadable, "контракт ответил", "контракта ответили", "контрактов ответили")} отказом вместо баланса — ` +
        "это не сбой связи, а контракт, который не отдаёт баланс этого токена."
    );
  }
  if (balances.some((b) => b.readsNativeCoin)) {
    notes.push(
      "Строки с нативной монетой — это пул, который держит саму монету сети, а не её обёрнутую версию: выйдет из него именно монета."
    );
  }
  if (chains.some(({ rows }) => rows.filter((r) => r.protocol === "hyperlane").length > MAX_ROWS_PER_GROUP)) {
    notes.push(
      "Маршруты Hyperlane — это отдельные пулы, их балансы нельзя складывать: вывести можно только из того маршрута, через который заходили."
    );
  }
  if (unreachable.length > 0) {
    const explained = unreachable
      .map((name) => {
        const chainKey = Object.keys(input.failureReasons ?? {}).find((k) => chainName(k) === name);
        const reason = chainKey ? input.failureReasons?.[chainKey] : undefined;
        return reason ? `${name} — ${reason}` : name;
      })
      .join("; ");
    notes.push(`⚠️ Не ответили совсем: ${esc(explained)}. Этих сетей в отчёте нет.`);
  }
  if (partial.length > 0) {
    notes.push(
      `⚠️ Ответили не полностью: ${esc(partial.join(", "))}. Эти сети в отчёте есть, но часть их контрактов пропущена.`
    );
  }
  if (mismatchedAdapters > 0) {
    notes.push(
      `Пропущено ${mismatchedAdapters} ${plural(mismatchedAdapters, "адаптер", "адаптера", "адаптеров")}` +
        " LayerZero: они не подтвердили, что держат именно этот токен. Подробности: <code>/lzmesh</code>."
    );
  }

  // Chains whose every contract answered zero.
  //
  // They vanished: the blocks are built from the rows that have a balance, so
  // a chain with nothing left in it produced no block, and the "пусто" line
  // only ever printed inside a block that already existed. A PENGU report
  // said it had checked seven contracts and showed one - the other six were
  // on four chains that were read, came back empty, and were never named.
  // Asked plainly by the customer: does this say whether there are tokens on
  // Robinhood Chain or not? It did not, and it had the answer.
  //
  // For a report about whether funds can be withdrawn, this is the most
  // useful sentence available: the route is there, and it is empty.
  // Bridges that mint rather than hold. Said before the empty-vault line and
  // kept apart from it: "checked, the vault is empty" about a mint-burn
  // deployment is a wrong answer, not a partial one.
  const mintsOnly = new Map<string, Set<BridgeProtocol>>();
  for (const entry of input.mintsOnly ?? []) {
    if (byChain.has(entry.chainKey)) continue;
    if (!mintsOnly.has(entry.chainKey)) mintsOnly.set(entry.chainKey, new Set());
    mintsOnly.get(entry.chainKey)!.add(entry.protocol);
  }
  if (mintsOnly.size > 0) {
    const described = [...mintsOnly.entries()].map(
      ([chainKey, protocols]) =>
        `${esc(chainName(chainKey))} (${esc([...protocols].map((p) => BRIDGE_SHORT_LABELS[p]).join(", "))})`
    );
    notes.push(
      `Мост чеканит, а не держит: ${described.join(", ")}. ` +
        "Хранилища там нет и быть не может — токен сжигается на одной стороне и чеканится на другой."
    );
  }

  const emptyOnly = [...emptyByChain.entries()]
    .filter(([chainKey]) => !byChain.has(chainKey))
    .filter(([chainKey]) => !mintsOnly.has(chainKey));
  if (emptyOnly.length > 0) {
    const described = emptyOnly.map(
      ([chainKey, protocols]) =>
        `${esc(chainName(chainKey))} (${esc(
          [...protocols].map((p) => BRIDGE_SHORT_LABELS[p]).join(", ")
        )})`
    );
    notes.push(
      `Проверено, хранилища пусты: ${described.join(", ")}. ` +
        "Мост туда есть, токена в нём сейчас нет — выводить оттуда нечего."
    );
  }

  // And the chains where a custody contract cannot exist at all. Said here
  // as well as in the empty report, because a token can be locked on one
  // chain and minted on another, and the minted side was silently missing
  // from every report that found liquidity anywhere.
  if (nativeOftChains.length > 0) {
    // Said of LayerZero, not of the chain. The first wording claimed the
    // chain had no vault at all, while the line above it named vaults on the
    // same four chains - the report contradicting itself inside one message.
    // Both facts are true and they are about different bridges: PENGU is
    // minted by LayerZero there, and Across happens to hold none of it.
    const alsoEmpty = nativeOftChains.some((c) => emptyByChain.has(c) && !byChain.has(c));
    // Where the collateral for all that minting actually is. Saying only
    // "nothing is held here" about five chains at once reads as "this token
    // has no liquidity anywhere", when the whole of it sits in one account on
    // the chain the deployment is anchored to.
    const anchors = [
      ...new Set(
        balances
          .filter((b) => b.protocol === "layerzero" && b.amount > 0n && !nativeOftChains.includes(b.chainKey))
          .map((b) => b.chainKey)
      ),
    ];
    notes.push(
      `Через LayerZero этот токен омничейн (OFT) в сетях: ${esc(nativeOftChains.map(chainName).join(", "))}. ` +
        "У LayerZero там хранилища нет по устройству: при переводе токен сжигается в одной сети и чеканится в другой." +
        (anchors.length > 0
          ? ` Заблокированный запас LayerZero лежит в других сетях: ${esc(anchors.map(chainName).join(", "))} — строками выше.`
          : "") +
        (alsoEmpty ? " Остальные мосты на этих сетях проверены отдельно — строкой выше." : "")
    );
  }
  const closingNotes = [
    ...supplyOnlyLines(input.supplyOnly),
    `Всего проверено контрактов: ${checkedCount}.`,
    ...scopeLines(scope),
  ];

  // No budget any more: the report is rendered whole and split across
  // messages afterwards. Budgeting the body against one message meant the
  // largest tokens lost most of their content - USDC dropped twenty-two
  // networks, more than it printed.
  const lines: string[] = [header];

  for (const { chainKey, rows } of chains) {
    const block: string[] = ["", `Сеть: <b>${esc(chainName(chainKey))}</b>`];

    const byProtocol = new Map<BridgeProtocol, BalanceRow[]>();
    for (const r of rows) {
      if (!byProtocol.has(r.protocol)) byProtocol.set(r.protocol, []);
      byProtocol.get(r.protocol)!.push(r);
    }

    for (const [protocol, protocolRows] of byProtocol) {
      protocolRows.sort((a, b) => {
        const [ra, rb] = [rank(a), rank(b)];
        return rb > ra ? 1 : rb < ra ? -1 : 0;
      });
      const shown = protocolRows.slice(0, MAX_ROWS_PER_GROUP);
      const rest = protocolRows.slice(MAX_ROWS_PER_GROUP);

      for (const row of shown) {
        const explorer = chainMeta(chainKey)?.explorerAddressUrl(row.custodyAddress);
        // Escaped, not assumed safe: an amount is usually digits, but a
        // balance below the last shown decimal renders as "< 0,0001", and an
        // unescaped "<" makes Telegram reject the whole message as a broken
        // tag - the report is then lost entirely over one dust row.
        // A native pool holds the chain's coin, so a report on WETH shows its
        // rows in ETH. Printing the requested ticker there would be a small
        // lie about what actually comes out.
        const unit = row.readsNativeCoin
          ? getChain(chainKey)?.viemChain.nativeCurrency.symbol ?? symbol
          : symbol;
        const amount = `${esc(formatAmount(row.amount, row.decimals))} ${esc(unit)}`;
        const link = explorer ? ` <a href="${explorer}">↗</a>` : "";
        // One bridge can hold the same token in several contracts on one
        // chain - a live deployment beside a deprecated one, say - and three
        // identical labels in a row leave no way to tell which is which.
        // The note earns its place only then.
        const tag = protocolRows.length > 1 && row.note ? ` <i>${esc(row.note)}</i>` : "";
        block.push(` - ${esc(BRIDGE_LABELS[protocol])}${tag}: <b>${amount}</b>${link}`);
      }

      if (rest.length > 0) {
        // Summed on the common scale, so formatted with its decimals.
        const total = esc(formatAmount(sumOf(rest), 18));
        const noun =
          protocol === "hyperlane"
            ? plural(rest.length, "маршрут", "маршрута", "маршрутов")
            : plural(rest.length, "контракт", "контракта", "контрактов");
        block.push(`   и ещё ${rest.length} ${noun} поменьше, суммарно ${total} ${esc(symbol)}`);
      }
    }

    // Only bridges with nothing left in them, and only those that hold
    // something somewhere else on this chain would already be listed above.
    const empty = [...(emptyByChain.get(chainKey) ?? [])].filter(
      (p) => !rows.some((r) => r.protocol === p)
    );
    if (empty.length > 0) {
      block.push(`   <i>пусто: ${esc(empty.map((p) => BRIDGE_SHORT_LABELS[p]).join(", "))}</i>`);
    }

    lines.push(block.join("\n"));
  }

  return [...lines, "", ...notes, ...closingNotes].join("\n");
}
