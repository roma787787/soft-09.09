import { getChain } from "../config/chains";
import { BRIDGE_LABELS, type BridgeProtocol } from "../bridges/types";
import { formatAmount, type CustodianBalance } from "../services/balances";

/** Telegram rejects anything past 4096; leave room for the closing notes. */
const MAX_MESSAGE_CHARS = 3600;

/** Rows shown per protocol per chain before the rest are summarised. */
const MAX_ROWS_PER_GROUP = 3;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
        "<b>Если он ходит через LayerZero</b>, у которого нет публичного реестра, адрес адаптера ищется так:",
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
    return lines.join("\n");
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
        const amount = `${formatAmount(row.amount, row.decimals)} ${esc(symbol)}`;
        const link = explorer ? ` <a href="${explorer}">↗</a>` : "";
        block.push(` - ${esc(BRIDGE_LABELS[protocol])}: <b>${amount}</b>${link}`);
      }

      if (rest.length > 0) {
        // Summed on the common scale, so formatted with its decimals.
        const total = formatAmount(sumOf(rest), 18);
        block.push(
          `   и ещё ${rest.length} ${protocol === "hyperlane" ? "маршрутов" : "контрактов"}` +
            ` поменьше, суммарно ${total} ${esc(symbol)}`
        );
      }
    }

    const blockText = block.join("\n");
    if (used + blockText.length > MAX_MESSAGE_CHARS) {
      omittedChains++;
      continue;
    }
    lines.push(blockText);
    used += blockText.length;
  }

  const notes: string[] = [];
  if (chains.some(({ rows }) => rows.filter((r) => r.protocol === "hyperlane").length > MAX_ROWS_PER_GROUP)) {
    notes.push(
      "Маршруты Hyperlane — это отдельные пулы, их балансы нельзя складывать: вывести можно только из того маршрута, через который заходили."
    );
  }
  if (omittedChains > 0) {
    notes.push(`Ещё ${omittedChains} сетей не поместились в сообщение.`);
  }
  if (unreachable.length > 0) {
    notes.push(`⚠️ Не ответили совсем: ${esc(unreachable.join(", "))}. Этих сетей в отчёте нет.`);
  }
  if (partial.length > 0) {
    notes.push(
      `⚠️ Ответили не полностью: ${esc(partial.join(", "))}. Эти сети в отчёте есть, но часть их контрактов пропущена.`
    );
  }
  notes.push(`Всего проверено контрактов: ${checkedCount}.`);

  return [...lines, "", ...notes].join("\n");
}
