import type { Telegraf, Context } from "telegraf";
import { OTHER_CHAINS } from "../../config/otherChains";
import { findOtherRoutes, probeOtherRoute } from "../../bridges/others";
import { capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Shows what Starknet, Radix and Aleo actually answer for a token's routes.
 *
 * "No rows" is the same output whether the endpoint refused, the entry point
 * is named differently, or the contract holds nothing - and those need
 * different fixes. This prints the reply.
 */
export function registerOtherCommand(bot: Telegraf) {
  bot.command("other", async (ctx: Context) => {
    const arg = ((ctx.message as any)?.text ?? "").trim().split(/\s+/)[1];
    if (!arg) {
      await ctx.reply("Укажите тикер. Пример: <code>/other XRD</code>", { parse_mode: "HTML" });
      return;
    }

    const symbol = arg.replace(/^\$/, "").slice(0, 32).toUpperCase();
    await ctx.sendChatAction("typing");

    const routes = findOtherRoutes(symbol);
    const lines = [
      `<b>${esc(symbol)} — Starknet / Radix / Aleo</b>`,
      `Сетей: ${OTHER_CHAINS.map((c) => c.label).join(", ")}`,
      "",
      `Маршрутов с залогом: ${routes.length}`,
    ];

    for (const route of routes.slice(0, 3)) {
      lines.push(
        "",
        `<i>${esc(route.routeId)}</i> — ${esc(route.chainKey)} (${esc(route.standard)})`,
        `  контракт: <code>${esc(route.address)}</code>`,
        `  залог: <code>${esc(route.collateral ?? "своя монета сети")}</code>`
      );
      for (const step of await probeOtherRoute(route)) {
        lines.push(`  ${step.ok ? "✅" : "❌"} ${esc(step.step)}: ${esc(step.outcome)}`);
      }
    }

    if (routes.length === 0) lines.push("По этому тикеру маршрутов на этих сетях нет.");

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
