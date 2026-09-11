import type { Telegraf, Context } from "telegraf";
import { PORTAL_CHAINS, portalCustodyAddress } from "../../config/portalChains";
import { findPortalNonEvmBalances } from "../../bridges/portalNonEvm";
import { lookupToken } from "../../services/coingecko";
import { formatAmount } from "../../services/balances";
import { capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The name a person would recognise, not the key the code files it under. */
function labelOf(chainKey: string): string {
  return PORTAL_CHAINS.find((c) => c.key === chainKey)?.label ?? chainKey;
}

/**
 * Shows, step by step, how a balance on Near or Aptos was arrived at.
 *
 * These two are read over protocols nothing else here uses, against
 * contracts nobody can eyeball from a phone. Every other non-EVM family got
 * a command like this while it was being built, and each time it turned
 * three rounds of guessing into one round of looking.
 */
export function registerPortalCommand(bot: Telegraf) {
  bot.command("portal", async (ctx: Context) => {
    const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
    const symbol = text.trim().split(/\s+/)[1]?.toUpperCase();
    if (!symbol) {
      await ctx.reply("Укажите тикер. Пример: <code>/portal USDT</code>", { parse_mode: "HTML" });
      return;
    }

    await ctx.sendChatAction("typing");

    const lines: string[] = [
      `<b>Portal на Near и Aptos — ${esc(symbol)}</b>`,
      `Сетей: ${PORTAL_CHAINS.map((c) => c.label).join(", ")}`,
      "",
    ];

    for (const chain of PORTAL_CHAINS) {
      lines.push(`<b>${esc(chain.label)}</b> — хранилище <code>${esc(portalCustodyAddress(chain.key) ?? "нет")}</code>`);
    }
    lines.push("");

    const token = await lookupToken(symbol);
    if (!token) {
      lines.push(`Тикер не найден на CoinGecko — спрашивать нечего.`);
      await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
      return;
    }

    // The token address is the whole question on these chains: the Token
    // Bridge is one contract holding everything it ever carried, so what
    // decides the answer is which token it is asked about.
    const targets = token.otherPlatforms
      .filter((p) => p.chainKey && PORTAL_CHAINS.some((c) => c.key === p.chainKey))
      .map((p) => ({ chainKey: p.chainKey!, tokenAddress: p.tokenAddress }));

    if (targets.length === 0) {
      lines.push(
        "CoinGecko не знает этот токен ни на одной из этих сетей — адреса, о котором спрашивать хранилище, нет.",
        "",
        `Что CoinGecko знает: ${esc(
          [...token.platforms, ...token.otherPlatforms].map((p) => p.platformName).join(", ") || "ничего"
        )}.`
      );
      await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
      return;
    }

    for (const t of targets) {
      lines.push(`Адрес токена на ${esc(labelOf(t.chainKey))}: <code>${esc(t.tokenAddress)}</code>`);
    }
    lines.push("");

    const { rows, failures } = await findPortalNonEvmBalances(targets);
    for (const row of rows) {
      lines.push(
        `✅ ${esc(labelOf(row.chainKey))}: <b>${esc(formatAmount(row.amount, row.decimals))}</b> ${esc(symbol)} ` +
          `<i>(${row.decimals} знаков)</i>`
      );
    }
    for (const chainKey of Object.keys(failures)) {
      // Named as unread rather than left out: an unanswered chain holds an
      // unknown amount, and silence would read as zero.
      lines.push(`❌ ${esc(labelOf(chainKey))}: прочитать не удалось — ни один узел не ответил по делу.`);
    }

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
