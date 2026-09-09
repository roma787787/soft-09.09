import type { Telegraf, Context } from "telegraf";
import { listTrackedForChat } from "../../services/db";
import { getChain } from "../../config/chains";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
      return `• <b>${esc(chain?.label ?? r.chain)}</b> <code>${esc(r.address)}</code>${r.label ? `\n  ${esc(r.label)}` : ""}`;
    });

    await ctx.reply(`📋 Отслеживаемые контракты (${rows.length}):\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
  });
}
