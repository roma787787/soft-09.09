import type { Telegraf, Context } from "telegraf";
import { getChain } from "../../config/chains";
import { lookupToken, CmcNotConfiguredError, CmcRequestError } from "../../services/cmc";
import { resolveCustodians } from "../../bridges";
import { readCustodianBalances } from "../../services/balances";
import { renderLiquidityReport } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const REPLY_OPTS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

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

  return renderLiquidityReport({
    symbol: token.symbol,
    name: token.name,
    balances,
    checkedCount: custodians.length,
    failedChains: failedChains.map((c) => getChain(c)?.label ?? c),
  });
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
    const detail = err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err).slice(0, 200);
    await ctx.reply(
      `Не удалось собрать отчёт.\n\n<code>${esc(detail)}</code>\n\nПришлите этот текст, по нему видно причину.`,
      { parse_mode: "HTML" }
    );
  }
}
