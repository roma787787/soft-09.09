import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { discoverChains, lastDiscovery } from "../../services/chainDiscovery";
import { capToTelegramLimit, plural } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Shows which networks the bot added on its own, and which it refused.
 *
 * The refusals are the point. "The bot supports 200 chains" is a claim; this
 * says which ones the token API listed, which of those no registry could
 * describe, and which had no node that would confirm its own chain id -
 * so a chain missing from a report can be traced to a reason instead of
 * guessed at.
 */
export function registerChainsCommand(bot: Telegraf) {
  bot.command("chains", async (ctx: Context) => {
    await ctx.sendChatAction("typing");

    const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
    const rescan = /\s(обнови|refresh|scan)\b/i.test(text);
    const detailed = /\s(подробно|full|detail)\b/i.test(text);
    const report = rescan || !lastDiscovery() ? await discoverChains() : lastDiscovery()!;

    const lines: string[] = [`🌐 <b>Сети</b>: ${CHAINS.length} EVM в таблице`];

    if (report.error) {
      lines.push(
        "",
        `Список сетей у CoinGecko получить не удалось: <code>${esc(report.error)}</code>`,
        "Таблица работает, просто без пополнения."
      );
      await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
      return;
    }

    lines.push(
      `CoinGecko перечисляет ${report.listed} EVM-сетей: ${report.known} уже были, ` +
        `${report.added.length} ${plural(report.added.length, "добавлена", "добавлено", "добавлено")}, ` +
        `${report.rejected.length} не подошли.`,
      ""
    );

    // Compact, and the refusals before the additions. A line and a URL per
    // added chain filled the message on its own - sixty-one of them - and
    // what fell off the end was the part that says why the others are
    // missing, which is the only part anyone can act on.
    if (report.rejected.length > 0) {
      const byReason = new Map<string, string[]>();
      for (const chain of report.rejected) {
        const group = byReason.get(chain.reason);
        if (group) group.push(chain.label);
        else byReason.set(chain.reason, [chain.label]);
      }
      lines.push("<b>Не подошли</b>");
      for (const [reason, labels] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`❌ ${esc(reason)} — ${labels.length}\n   ${esc(labels.join(", "))}`);
      }
      lines.push("");
    }

    if (report.added.length > 0) {
      lines.push("<b>Бот добавил сам</b>");
      if (detailed) {
        for (const chain of report.added) {
          lines.push(`✅ ${esc(chain.label)} <i>(id ${chain.chainId})</i>\n   <code>${esc(chain.rpcUrl)}</code>`);
        }
      } else {
        lines.push(`✅ ${esc(report.added.map((c) => c.label).join(", "))}`);
        lines.push("<i>С адресами узлов: /chains подробно</i>");
      }
      lines.push("");
    }

    lines.push(
      `Проверено ${report.at.toLocaleString("ru-RU", { timeZone: "UTC" })} UTC. ` +
        `Пересчёт раз в сутки; <code>/chains обнови</code> — прямо сейчас.`
    );

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
