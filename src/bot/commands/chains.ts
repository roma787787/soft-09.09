import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { discoverChains, lastDiscovery, type RejectedChain } from "../../services/chainDiscovery";
import { capToTelegramLimit, plural } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The kind of problem a rejection is, for grouping.
 *
 * Each class needs a different response, and that is the only reason to
 * split them: a testnet is working as intended, a server refusing this IP is
 * opened by a key, a chain nobody describes is out of the bot's hands, and a
 * dead endpoint needs another address. The exact sentence - which host, which
 * errno - stays on the row and is shown in full by /chains подробно.
 */
export function reasonClass(reason: string): string {
  if (/тестов|устаревш/i.test(reason)) return "тестовая или устаревшая сеть — и не должна быть в таблице";
  if (/отказывают этому серверу/i.test(reason)) return "узлы живы, но отказывают этому серверу — лечится своим RPC";
  if (/нет публичных узлов/i.test(reason)) return "нет публичных узлов";
  if (/ни один реестр/i.test(reason)) return "ни один реестр её не описывает";
  if (/отдаёт сеть/i.test(reason)) return "узел отдаёт другую сеть — адрес в реестре неверный";
  return "узлы не отвечают — нужен другой адрес ноды";
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

    // Every candidate accounted for, and the arithmetic shown. The counts
    // stopped adding up once - 120 known plus 0 added plus 68 refused, out
    // of 275 - and that discrepancy was the only visible sign that eighty-
    // seven chains had passed every check and then been dropped in silence.
    const accounted =
      report.known + report.added.length + report.rejected.length + report.duplicates;
    lines.push(
      `Источники называют ${report.listed} EVM-сетей: ${report.known} уже были, ` +
        `${report.added.length} ${plural(report.added.length, "добавлена", "добавлено", "добавлено")}, ` +
        `${report.rejected.length} не подошли` +
        `${report.duplicates > 0 ? `, ${report.duplicates} уже успели добавиться` : ""}.`
    );
    // Counted separately because it answers a different question. The price
    // API lists the chains worth pricing tokens on; Sanko, Glue and Apex
    // Fusion Nexus carry Stargate pools and interest nobody as a venue for
    // quotes, so only the bridge registry ever names them.
    if (report.fromBridges > 0) {
      lines.push(`Из них ${report.fromBridges} знает только реестр моста, а CoinGecko — нет.`);
    }
    // The other half of what the bridge metadata is good for, and the half
    // that helps chains already in the table: a chain whose only listed node
    // refuses this server drops out of every report, and a missing chain
    // reads as "no liquidity here" rather than as nobody being able to ask.
    if (report.learnedEndpoints > 0) {
      lines.push(`Плюс ${report.learnedEndpoints} запасных узлов для сетей, которые уже были в таблице.`);
    }
    if (accounted !== report.listed) {
      lines.push(`⚠️ Сходится ${accounted} из ${report.listed} — где-то теряются сети, это баг.`);
    }
    lines.push("");

    // Compact, and the refusals before the additions. A line and a URL per
    // added chain filled the message on its own - sixty-one of them - and
    // what fell off the end was the part that says why the others are
    // missing, which is the only part anyone can act on.
    if (report.rejected.length > 0) {
      // Grouped by what kind of problem it is, not by the exact sentence.
      // Naming the failing host made every reason unique, so forty-five
      // chains became forty-five groups and the message ran past Telegram's
      // limit - taking with it the part that says what the bot added, which
      // is the half nobody can reconstruct. The exact reasons are a word
      // away, in /chains подробно.
      const byClass = new Map<string, RejectedChain[]>();
      for (const chain of report.rejected) {
        const group = byClass.get(reasonClass(chain.reason));
        if (group) group.push(chain);
        else byClass.set(reasonClass(chain.reason), [chain]);
      }
      lines.push("<b>Не подошли</b>");
      for (const [reason, rejected] of [...byClass].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`❌ ${esc(reason)} — ${rejected.length}\n   ${esc(rejected.map((c) => c.label).join(", "))}`);
        if (detailed) {
          for (const chain of rejected) lines.push(`     ${esc(chain.label)}: ${esc(chain.reason)}`);
        }
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
        lines.push("<i>С адресами узлов и точными причинами отказов: /chains подробно</i>");
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
