import type { Telegraf, Context } from "telegraf";
import { getChain, resolveChain } from "../../config/chains";
import { findTokenAdminRegistry } from "../../bridges/ccip";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Shows each step of the CCIP walk on one chain.
 *
 * The walk asks live contracts four questions in a row, and when a chain
 * stops resolving the useful thing to know is which question went
 * unanswered. Without this, the only visible symptom is a report quietly
 * missing its CCIP rows, which looks exactly like a token that CCIP does
 * not carry.
 */
export function registerCcipCommand(bot: Telegraf) {
  bot.command("ccip", async (ctx: Context) => {
    const text = (ctx.message as any)?.text ?? "";
    const arg = text.trim().split(/\s+/)[1];
    if (!arg) {
      await ctx.reply("Укажите сеть. Пример: <code>/ccip ethereum</code>", { parse_mode: "HTML" });
      return;
    }

    const chain = resolveChain(arg) ?? (getChain(arg) ? getChain(arg) : undefined);
    if (!chain) {
      await ctx.reply(`Сеть <b>${esc(arg)}</b> не подключена.`, { parse_mode: "HTML" });
      return;
    }

    await ctx.sendChatAction("typing");
    const { registry, steps } = await findTokenAdminRegistry(chain.key);

    const lines = [`<b>CCIP — ${esc(chain.label)}</b>`, ""];
    for (const step of steps) {
      lines.push(`${step.ok ? "✅" : "❌"} <b>${esc(step.name)}</b>: <code>${esc(step.detail)}</code>`);
    }
    lines.push(
      "",
      registry
        ? "Реестр найден: пулы по любому токену теперь ищутся автоматически."
        : "Реестр не найден — строк CCIP по этой сети в отчёте не будет."
    );

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
}
