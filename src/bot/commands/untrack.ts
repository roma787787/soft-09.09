import type { Telegraf, Context } from "telegraf";
import { parseAddressChainArgs } from "../parse";
import { removeTracked, listTrackedForChat } from "../../services/db";
import { getChain } from "../../config/chains";

export function registerUntrackCommand(bot: Telegraf) {
  bot.command("untrack", async (ctx: Context) => {
    const text = (ctx.message as any)?.text ?? "";
    const parsed = parseAddressChainArgs(text);
    const chatId = String(ctx.chat!.id);

    if (parsed.error || !parsed.address) {
      await ctx.reply(`${parsed.error ?? "Неверные аргументы."}\n\nПример: <code>/untrack 0x1234...abcd arbitrum</code>`, {
        parse_mode: "HTML",
      });
      return;
    }

    if (parsed.chainKey) {
      const ok = removeTracked(chatId, parsed.chainKey, parsed.address);
      await ctx.reply(ok ? "✅ Слежение остановлено." : "Такой отслеживаемый контракт не найден.");
      return;
    }

    // No chain given - remove from every chain this chat tracks that address on.
    const rows = listTrackedForChat(chatId).filter((r) => r.address.toLowerCase() === parsed.address!.toLowerCase());
    if (rows.length === 0) {
      await ctx.reply("Такой отслеживаемый контракт не найден.");
      return;
    }
    for (const row of rows) removeTracked(chatId, row.chain, row.address);
    await ctx.reply(`✅ Слежение остановлено на: ${rows.map((r) => getChain(r.chain)?.label ?? r.chain).join(", ")}`);
  });
}
