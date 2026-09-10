import type { Telegraf, Context } from "telegraf";
import { lookupToken } from "../../services/cmc";
import {
  findSolanaHyperlaneRoutes,
  hyperlaneEscrowCandidates,
  wormholeCustodyCandidates,
  checkCandidates,
  solanaTokenBridge,
} from "../../bridges/svm";
import { capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Works out where a token's collateral sits on Solana, showing every
 * candidate address and what the chain said about it.
 *
 * On Solana the custody account's address is derived rather than published,
 * and a wrong derivation returns an account that does not exist - which
 * looks exactly like a bridge holding nothing. This is what tells those
 * apart, and what the real reader will be built on once the chain has
 * answered.
 */
export function registerSvmCommand(bot: Telegraf) {
  bot.command("svm", async (ctx: Context) => {
    const arg = ((ctx.message as any)?.text ?? "").trim().split(/\s+/)[1];
    if (!arg) {
      await ctx.reply("Укажите тикер. Пример: <code>/svm USDC</code>", { parse_mode: "HTML" });
      return;
    }

    const symbol = arg.replace(/^\$/, "").slice(0, 32).toUpperCase();
    await ctx.sendChatAction("typing");

    const lines = [`<b>Solana — ${esc(symbol)}</b>`, ""];

    const routes = findSolanaHyperlaneRoutes(symbol);
    lines.push(`<b>Hyperlane</b>: маршрутов с залогом — ${routes.length}`);

    for (const route of routes.slice(0, 2)) {
      lines.push("", `<i>${esc(route.routeId)}</i> (${esc(route.standard)})`, `  минт: <code>${esc(route.mint)}</code>`);
      const checks = await checkCandidates(
        "solanamainnet",
        route.mint,
        hyperlaneEscrowCandidates(route.programId, route.mint)
      );
      for (const c of checks) {
        lines.push(`  ${c.ok ? "✅" : "❌"} ${esc(c.how)}: ${esc(c.outcome)}`);
      }
    }

    // Wormhole locks Solana-native tokens in an account derived from the
    // mint, so it needs the token's own mint rather than a route.
    const token = await lookupToken(symbol);
    const solanaMint = token?.otherPlatforms.find((p) => p.chainKey === "solanamainnet")?.tokenAddress;
    lines.push("", `<b>Wormhole</b>: программа <code>${esc(solanaTokenBridge() ?? "неизвестна")}</code>`);

    if (!solanaMint) {
      lines.push("  CoinMarketCap не знает этот токен на Solana — минта нет, выводить нечего.");
    } else {
      lines.push(`  минт: <code>${esc(solanaMint)}</code>`);
      const checks = await checkCandidates("solanamainnet", solanaMint, wormholeCustodyCandidates(solanaMint));
      for (const c of checks) {
        lines.push(`  ${c.ok ? "✅" : "❌"} ${esc(c.how)}: ${esc(c.outcome)}`);
      }
    }

    lines.push("", "Отмеченное ✅ — настоящий токен-аккаунт этого минта; по нему и будет читаться баланс.");

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
