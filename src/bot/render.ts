import { getChain } from "../config/chains";
import {
  BRIDGE_LABELS,
  BRIDGE_ORDER,
  BRIDGE_SHORT_LABELS,
  BRIDGE_UNITS,
  type BridgeProtocol,
} from "../bridges/types";
import { formatAmount, type CustodianBalance } from "../services/balances";

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
  balances: CustodianBalance[];
  checkedCount: number;
  failuresByChain: Record<string, number>;
  attemptsByChain: Record<string, number>;
  /** Chains where the token itself is a LayerZero OFT that mints its supply. */
  nativeOftChains?: string[];
  /** Chains with a Hyperlane route that mints instead of locking. */
  syntheticHyperlaneChains?: string[];
  /** Registry adapters skipped because they lock a different contract. */
  mismatchedAdapters?: number;
  /** Where the check reached, so a small number is explained, not puzzling. */
  scope?: {
    /** Chains CoinMarketCap listed that this bot supports. */
    supportedChains: string[];
    /** Networks CoinMarketCap listed that this bot does not cover. */
    unsupportedPlatforms: string[];
    /** How many contracts each bridge contributed. */
    byProtocol: Partial<Record<BridgeProtocol, number>>;
  };
}

/**
 * Explains the size of the check. "Checked 2 contracts" invites the obvious
 * question of why only two, and the answer is always the same three inputs:
 * the chains CoinMarketCap knows the token on, the warp routes carrying that
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

  if (scope.supportedChains.length > 0) {
    lines.push(`CoinMarketCap знает токен в сетях: ${esc(scope.supportedChains.join(", "))}.`);
  }
  if (scope.unsupportedPlatforms.length > 0) {
    lines.push(
      `Ещё в этих сетях бот их не проверяет: ${esc(scope.unsupportedPlatforms.slice(0, 8).join(", "))}.`
    );
  }
  return lines;
}

function chainName(chainKey: string): string {
  return getChain(chainKey)?.label ?? chainKey;
}

/**
 * Splits chains with failed reads into the two cases that need different
 * wording: nothing came back at all, versus part of the chain came back and
 * is in the report above.
 */
function describeFailures(
  balances: CustodianBalance[],
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

function rank(b: CustodianBalance): bigint {
  return toCommonScale(b.amount, b.decimals);
}

/** Total of a group, on the common 18-decimal scale. */
function sumOf(rows: CustodianBalance[]): bigint {
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
    nativeOftChains = [],
    syntheticHyperlaneChains = [],
    mismatchedAdapters = 0,
    scope,
  } = input;
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
    const scopeText = scopeLines(scope);
    if (scopeText.length > 0) lines.push("", ...scopeText);
    return capToTelegramLimit(lines.join("\n"));
  }

  const byChain = new Map<string, CustodianBalance[]>();
  for (const b of withLiquidity) {
    if (!byChain.has(b.chainKey)) byChain.set(b.chainKey, []);
    byChain.get(b.chainKey)!.push(b);
  }

  const chains = [...byChain.entries()]
    .map(([chainKey, rows]) => ({
      chainKey,
      rows,
      top: rows.reduce((max, r) => (rank(r) > max ? rank(r) : max), 0n),
    }))
    .sort((a, b) => (b.top > a.top ? 1 : b.top < a.top ? -1 : 0));

  const notes: string[] = [];
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
    notes.push(`⚠️ Не ответили совсем: ${esc(unreachable.join(", "))}. Этих сетей в отчёте нет.`);
  }
  if (partial.length > 0) {
    notes.push(
      `⚠️ Ответили не полностью: ${esc(partial.join(", "))}. Эти сети в отчёте есть, но часть их контрактов пропущена.`
    );
  }
  if (mismatchedAdapters > 0) {
    notes.push(
      `Пропущено ${mismatchedAdapters} ${plural(mismatchedAdapters, "адаптер", "адаптера", "адаптеров")}` +
        " LayerZero: они блокируют не тот контракт, который CoinMarketCap указал для этого тикера."
    );
  }
  const closingNotes = [`Всего проверено контрактов: ${checkedCount}.`, ...scopeLines(scope)];

  // The closing notes are what explain a thin report - which chains failed,
  // what was skipped, how much was checked. Budgeting the body first and
  // appending them afterwards meant the cut landed on exactly the lines that
  // say why the report looks the way it does. So they are measured first and
  // the body gets what is left.
  const notesBudget = visibleLength([...notes, ...closingNotes].join("\n")) + 80;


  const lines: string[] = [header];
  let used = header.length;
  let omittedChains = 0;

  for (const { chainKey, rows } of chains) {
    const block: string[] = ["", `Сеть: <b>${esc(chainName(chainKey))}</b>`];

    const byProtocol = new Map<BridgeProtocol, CustodianBalance[]>();
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
        const explorer = getChain(chainKey)?.explorerAddressUrl(row.custodyAddress);
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
        block.push(` - ${esc(BRIDGE_LABELS[protocol])}: <b>${amount}</b>${link}`);
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

    const blockText = block.join("\n");
    if (used + visibleLength(blockText) > MAX_MESSAGE_CHARS - notesBudget) {
      omittedChains++;
      continue;
    }
    lines.push(blockText);
    used += visibleLength(blockText);
  }



  if (omittedChains > 0) {
    notes.push(
      `Ещё ${omittedChains} ${plural(omittedChains, "сеть не поместилась", "сети не поместились", "сетей не поместилось")} в сообщение.`
    );
  }

  return capToTelegramLimit([...lines, "", ...notes, ...closingNotes].join("\n"));
}
