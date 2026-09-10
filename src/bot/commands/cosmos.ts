import type { Telegraf, Context } from "telegraf";
import { COSMOS_CHAINS, getCosmosChain } from "../../config/cosmosChains";
import { findCosmosRoutes, findNativeModuleRoutes, probeNativeModule } from "../../bridges/cosmos";
import { capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Shows how a token's collateral is found on Cosmos chains, and - for the
 * routes still missing - what the chain answers to each way of asking.
 *
 * CosmWasm routes need nothing explained: a contract address and a bank
 * balance. Hyperlane's native module is the open question: its routes are
 * addressed by a hex router id, and rather than deriving an account for it,
 * this asks the module's own REST API. Which path answers is a fact the
 * chain can state, so it is asked rather than guessed.
 */
export function registerCosmosCommand(bot: Telegraf) {
  bot.command("cosmos", async (ctx: Context) => {
    const arg = ((ctx.message as any)?.text ?? "").trim().split(/\s+/)[1];
    if (!arg) {
      await ctx.reply("Укажите тикер. Пример: <code>/cosmos TIA</code>", { parse_mode: "HTML" });
      return;
    }

    const symbol = arg.replace(/^\$/, "").slice(0, 32).toUpperCase();
    await ctx.sendChatAction("typing");

    const lines = [`<b>Cosmos — ${esc(symbol)}</b>`, `Сетей подключено: ${COSMOS_CHAINS.length}`, ""];

    const routes = findCosmosRoutes(symbol);
    lines.push(`<b>CosmWasm</b>: маршрутов с залогом — ${routes.length}`);
    for (const route of routes.slice(0, 6)) {
      lines.push(
        `  ${esc(getCosmosChain(route.chainKey)?.label ?? route.chainKey)} — <code>${esc(route.denom)}</code>`
      );
    }

    const native = findNativeModuleRoutes(symbol);
    lines.push("", `<b>Нативный модуль Hyperlane</b>: маршрутов — ${native.length}`);
    if (native.length === 0) {
      lines.push("  по этому тикеру таких маршрутов нет");
    }

    for (const route of native.slice(0, 2)) {
      lines.push(
        "",
        `<i>${esc(route.routeId)}</i> — ${esc(route.chainKey)}`,
        `  id: <code>${esc(route.routerId)}</code>`
      );
      const attempts = await probeNativeModule(route.chainKey, route.routerId);
      for (const a of attempts) {
        lines.push(`  ${a.ok ? "✅" : "❌"} <code>${esc(a.path)}</code>: ${esc(a.outcome)}`);
      }
    }

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
