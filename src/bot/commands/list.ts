import type { Telegraf, Context } from "telegraf";
import { listTrackedForChat } from "../../services/db";
import { getChain } from "../../config/chains";
import { getAddress, type Address } from "viem";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The canonical spelling of a stored address.
 *
 * They are stored lowercased so /untrack finds them however they were typed,
 * but the checksummed form is what /track echoed back and what every
 * explorer shows - and a list that spells them differently reads as a list
 * of different addresses. Defensive because the column is only as clean as
 * whatever wrote it.
 */
function pretty(address: string): string {
  try {
    return getAddress(address as Address);
  } catch {
    return address;
  }
}

export function registerListCommand(bot: Telegraf) {
  bot.command("list", async (ctx: Context) => {
    const chatId = String(ctx.chat!.id);
    const rows = listTrackedForChat(chatId);

    if (rows.length === 0) {
      await ctx.reply("Вы пока ничего не отслеживаете. Используйте /track <адрес> [сеть].");
      return;
    }

    const lines = rows.map((r) => {
      const chain = getChain(r.chain);
      return `• <b>${esc(chain?.label ?? r.chain)}</b> <code>${esc(pretty(r.address))}</code>${r.label ? `\n  ${esc(r.label)}` : ""}`;
    });

    // Budgeted rather than sent whole. Nothing limits how much one chat can
    // track, and past Telegram's four thousand characters a message is
    // refused, not shortened - so the list would break exactly when it got
    // long, and it would take with it the addresses needed to /untrack
    // anything. The way out must not break along with the thing it fixes.
    const header = `📋 Отслеживаемые контракты (${rows.length}):\n\n`;
    const budget = 4096 - header.length - 120;
    const shown: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > budget) break;
      shown.push(line);
      used += line.length + 1;
    }

    const tail =
      shown.length < rows.length
        ? `\n\n… и ещё ${rows.length - shown.length}: не поместились в сообщение. ` +
          `Отпишитесь от ненужных через <code>/untrack &lt;адрес&gt;</code>, и покажутся остальные.`
        : "";

    await ctx.reply(header + shown.join("\n") + tail, { parse_mode: "HTML" });
  });
}
