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
  failedChains: string[];
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
  const { symbol, name, balances, checkedCount, failedChains } = input;
  const withLiquidity = balances.filter((b) => b.amount > 0n);

  const header = `Токен: <b>${esc(symbol)}</b> — ${esc(name)}`;

  if (withLiquidity.length === 0) {
    const lines = [header, "", `Проверено контрактов: ${checkedCount}. Ни на одном из них токена сейчас нет.`];
    if (failedChains.length === 0) {
      lines.push("Через известные боту мосты этот токен не заведён.");
    }
    if (failedChains.length > 0) {
      lines.push("", `⚠️ Часть сетей проверить не удалось: ${esc(failedChains.join(", "))}.`);
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
    const chainName = getChain(chainKey)?.label ?? chainKey;
    const block: string[] = ["", `Сеть: <b>${esc(chainName)}</b>`];

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
  if (failedChains.length > 0) {
    notes.push(`⚠️ Часть сетей проверить не удалось: ${esc(failedChains.join(", "))}. Их данных в отчёте нет.`);
  }
  notes.push(`Всего проверено контрактов: ${checkedCount}.`);

  return [...lines, "", ...notes].join("\n");
}
