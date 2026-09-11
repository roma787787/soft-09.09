import type { Telegraf, Context } from "telegraf";
import { TON_CHAIN, toTonAddress } from "../../config/tonChain";
import { findRegistryDeploymentsOnChain } from "../../bridges/layerzero";
import { findTonBalances, tonApiBase } from "../../bridges/ton";
import { env } from "../../config/env";
import { formatAmount } from "../../services/balances";
import { capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Shows how a TON balance was arrived at, step by step.
 *
 * Three things have to line up and none of them can be seen from a phone:
 * the registry has to list an adapter, its 32-byte hash has to become an
 * address, and the index has to name a jetton wallet under it. When a row is
 * missing, this says which of the three failed.
 */
export function registerTonCommand(bot: Telegraf) {
  bot.command("ton", async (ctx: Context) => {
    const symbol = ((ctx.message as { text?: string } | undefined)?.text ?? "")
      .trim()
      .split(/\s+/)[1]
      ?.toUpperCase();
    if (!symbol) {
      await ctx.reply("Укажите тикер. Пример: <code>/ton USDT</code>", { parse_mode: "HTML" });
      return;
    }

    await ctx.sendChatAction("typing");
    const lines: string[] = [
      `<b>TON — ${esc(symbol)}</b>`,
      // The address being asked, and whether a key is in play. A key pointed
      // at the wrong service, or an override pointed at the wrong host,
      // looks exactly like a chain holding nothing.
      `Индекс: <code>${esc(tonApiBase())}</code>, ключ ${env.tonApiKey ? "задан" : "не задан"}`,
      "",
    ];

    const deployments = await findRegistryDeploymentsOnChain(symbol, TON_CHAIN.key);
    lines.push(`<b>Реестр LayerZero</b>: деплоев на TON — ${deployments.length}`);
    for (const d of deployments) {
      const address = toTonAddress(d.address);
      lines.push(
        `  ${esc(d.rawType)}${d.viaAlias ? ` <i>(через ${esc(d.viaAlias)})</i>` : ""}` +
          `\n  ${address ? `<code>${esc(address)}</code>` : `адрес не похож на TON: <code>${esc(d.address)}</code>`}` +
          `\n  ${d.locksCollateral ? "держит залог — есть что мерить" : "чеканит — мерить нечего"}`
      );
    }

    if (deployments.length === 0) {
      lines.push("", "Этого тикера на TON реестр не знает.");
      await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
      return;
    }

    const { rows, failures, attempts, reasons } = await findTonBalances(symbol);
    lines.push("", `<b>Чтение</b>: спрошено ${attempts[TON_CHAIN.key] ?? 0}`);
    for (const row of rows) {
      lines.push(
        `✅ <b>${esc(formatAmount(row.amount, row.decimals))}</b> ${esc(symbol)} ` +
          `<i>(${row.decimals} знаков)</i>\n  джеттон <code>${esc(row.tokenAddress)}</code>`
      );
    }
    const failed = failures[TON_CHAIN.key] ?? 0;
    if (failed > 0) {
      // Named as unread rather than left out: an adapter nobody managed to
      // ask holds an unknown amount, and silence would read as zero.
      // The reader's own words, not a sentence written here. This command
      // exists to show what happened, and it was replacing that with a
      // guess - while the reason sat unread in the result it had just been
      // handed.
      const reason = reasons?.[TON_CHAIN.key];
      lines.push(
        `❌ ${failed} ${failed === 1 ? "адаптер" : "адаптеров"} прочитать не удалось` +
          (reason ? `\n  ${esc(reason)}` : " — причину читалка не назвала.")
      );
    }

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
