import type { Telegraf, Context } from "telegraf";
import { getChain } from "../../config/chains";
import { lookupToken, CmcNotConfiguredError, CmcRequestError } from "../../services/cmc";
import { resolveCustodians } from "../../bridges";
import { readCustodianBalances, formatAmount, type CustodianBalance } from "../../services/balances";
import { BRIDGE_LABELS } from "../../bridges/types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const REPLY_OPTS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

/** Order chains by how much of the token they hold, biggest first. */
function groupByChain(balances: CustodianBalance[]): Array<[string, CustodianBalance[]]> {
  const byChain = new Map<string, CustodianBalance[]>();
  for (const b of balances) {
    if (!byChain.has(b.chainKey)) byChain.set(b.chainKey, []);
    byChain.get(b.chainKey)!.push(b);
  }

  const scored = [...byChain.entries()].map(([chainKey, rows]) => {
    const top = rows.reduce((max, r) => {
      const scale = 10n ** BigInt(Math.max(0, 18 - r.decimals));
      const normalised = r.amount * scale;
      return normalised > max ? normalised : max;
    }, 0n);
    return { chainKey, rows, top };
  });

  scored.sort((a, b) => (b.top > a.top ? 1 : b.top < a.top ? -1 : 0));
  return scored.map((s) => [s.chainKey, s.rows]);
}

export async function buildLiquidityReport(rawSymbol: string): Promise<string> {
  const symbol = rawSymbol.trim().replace(/^\$/, "").toUpperCase();

  const token = await lookupToken(symbol);
  if (!token) {
    return `Тикер <b>${esc(symbol)}</b> не найден на CoinMarketCap. Проверьте написание.`;
  }

  const custodians = resolveCustodians(symbol, token.platforms);
  if (custodians.length === 0) {
    return (
      `<b>${esc(token.name)} (${esc(token.symbol)})</b>\n\n` +
      "По этому токену нет данных о бридж-контрактах.\n\n" +
      "Wormhole и Hyperlane подтягиваются автоматически, а адаптеры LayerZero ведутся вручную: " +
      "добавьте адрес в <code>config/layerzero-lockboxes.json</code>."
    );
  }

  const { balances, failedChains } = await readCustodianBalances(custodians);
  const withLiquidity = balances.filter((b) => b.amount > 0n);

  const lines: string[] = [`Токен: <b>${esc(token.symbol)}</b> — ${esc(token.name)}`];

  if (withLiquidity.length === 0) {
    lines.push(
      "",
      `Проверено контрактов: ${balances.length}. Ни на одном из них токена сейчас нет.`,
      "Это значит, что через известные боту мосты этот токен не заведён."
    );
  } else {
    for (const [chainKey, rows] of groupByChain(withLiquidity)) {
      const chainName = getChain(chainKey)?.label ?? chainKey;
      lines.push("", `Сеть: <b>${esc(chainName)}</b>`);

      rows.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
      for (const row of rows) {
        const explorer = getChain(chainKey)?.explorerAddressUrl(row.custodyAddress);
        const amount = `${formatAmount(row.amount, row.decimals)} ${esc(token.symbol)}`;
        const link = explorer ? ` <a href="${explorer}">↗</a>` : "";
        lines.push(` - ${esc(BRIDGE_LABELS[row.protocol])}: <b>${amount}</b>${link}`);
      }
    }
  }

  if (failedChains.length > 0) {
    const names = failedChains.map((c) => getChain(c)?.label ?? c).join(", ");
    lines.push("", `⚠️ Часть сетей проверить не удалось: ${esc(names)}. Их данных в отчёте нет.`);
  }

  return lines.join("\n");
}

export function registerLiquidityCommand(bot: Telegraf) {
  bot.command("liquidity", async (ctx: Context) => {
    const text = (ctx.message as any)?.text ?? "";
    const arg = text.trim().split(/\s+/)[1];
    if (!arg) {
      await ctx.reply("Укажите тикер. Пример: <code>/liquidity ARB</code>", { parse_mode: "HTML" });
      return;
    }
    await replyWithLiquidity(ctx, arg);
  });
}

/** Shared by /liquidity and by /info when its argument is a ticker. */
export async function replyWithLiquidity(ctx: Context, symbol: string): Promise<void> {
  await ctx.sendChatAction("typing");
  try {
    await ctx.reply(await buildLiquidityReport(symbol), REPLY_OPTS);
  } catch (err) {
    if (err instanceof CmcNotConfiguredError) {
      await ctx.reply(
        "Поиск по тикеру не настроен: не задан ключ CoinMarketCap.\n\n" +
          "Добавьте переменную <code>CMC_API_KEY</code> в настройки хостинга.",
        { parse_mode: "HTML" }
      );
      return;
    }
    if (err instanceof CmcRequestError) {
      await ctx.reply(`Не удалось получить данные от CoinMarketCap: ${esc(err.message)}`, {
        parse_mode: "HTML",
      });
      return;
    }
    console.error("[liquidity] непредвиденная ошибка:", err);
    await ctx.reply("Произошла ошибка при сборе балансов. Попробуйте ещё раз.");
  }
}
