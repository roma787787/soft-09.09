import type { Telegraf, Context } from "telegraf";
import { CCIP_SOLANA } from "../../protocols/addresses/ccip.generated";
import { ccipPoolCandidates, checkCcipCandidates, holdsCollateral, SOLANA_KEY } from "../../bridges/ccipSvm";
import { lookupToken } from "../../services/coingecko";
import { formatAmount } from "../../services/balances";
import { capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Shows, derivation by derivation, how CCIP's custody account on Solana was
 * arrived at - or why none was found.
 *
 * On Solana the pool is a program and the collateral sits in an account
 * derived from it, so a missing balance has two completely different causes:
 * the pool does not exist for this token, or the derivation is wrong. From a
 * report they look identical. Every other Solana reader here got a command
 * like this while it was being built, and each time it turned several rounds
 * of guessing into one round of looking.
 */
export function registerCcipSvmCommand(bot: Telegraf) {
  bot.command("ccipsvm", async (ctx: Context) => {
    const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
    const argument = text.trim().split(/\s+/)[1];
    if (!argument) {
      await ctx.reply("Укажите тикер или минт. Пример: <code>/ccipsvm USDC</code>", { parse_mode: "HTML" });
      return;
    }

    await ctx.sendChatAction("typing");

    if (!CCIP_SOLANA) {
      await ctx.reply("В справочнике Chainlink нет развёртывания CCIP на Solana — читать нечего.");
      return;
    }

    const lines: string[] = [
      `<b>CCIP на Solana — ${esc(argument)}</b>`,
      `Роутер: <code>${esc(CCIP_SOLANA.router)}</code>`,
      `Программы пулов: ${Object.keys(CCIP_SOLANA.poolPrograms).join(", ")}`,
      "",
    ];

    // A mint may be given outright; otherwise the price API's listing for
    // Solana is what names it, the same way the report gets it.
    let mint = argument;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(argument)) {
      try {
        const token = await lookupToken(argument.toUpperCase());
        const listed = token?.otherPlatforms.find((p) => p.chainKey === SOLANA_KEY)?.tokenAddress;
        if (!listed) {
          lines.push(`CoinGecko не знает адреса <b>${esc(argument.toUpperCase())}</b> на Solana — спрашивать не о чем.`);
          await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
          return;
        }
        mint = listed;
      } catch (err) {
        lines.push(`Не удалось спросить CoinGecko: <code>${esc(err instanceof Error ? err.message : String(err))}</code>`);
        await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
        return;
      }
    }
    lines.push(`Минт: <code>${esc(mint)}</code>`, "");

    const candidates = ccipPoolCandidates(mint);
    if (candidates.length === 0) {
      lines.push("Ни один вариант адреса не вывелся — минт не разобрался как ключ Solana.");
      await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
      return;
    }

    const checks = await checkCcipCandidates(mint, candidates);
    const hits = checks.filter((c) => c.ok);

    // The hits first and in full: that is the line anyone is reading this
    // for. The misses are grouped, because eighteen "аккаунта нет" lines
    // push the useful part off the end of the message.
    if (hits.length > 0) {
      lines.push("<b>Подтверждено сетью</b>");
      for (const hit of hits) {
        const amount = hit.amount !== undefined && hit.decimals !== undefined
          ? formatAmount(hit.amount, hit.decimals)
          : hit.outcome;
        lines.push(
          `✅ ${esc(hit.poolType)} — ${esc(hit.how)}`,
          `   <code>${esc(hit.address)}</code>`,
          `   ${esc(amount)}${holdsCollateral(hit.poolType) ? "" : " — этот пул чеканит, держать он и не должен"}`
        );
      }
      lines.push("");
    } else {
      lines.push("Ни один выведенный адрес не оказался токен-аккаунтом этого минта.", "");
    }

    const byOutcome = new Map<string, number>();
    for (const check of checks) {
      if (check.ok) continue;
      const reason = check.outcome.startsWith("другой минт") ? "другой минт" : check.outcome;
      byOutcome.set(reason, (byOutcome.get(reason) ?? 0) + 1);
    }
    if (byOutcome.size > 0) {
      lines.push("<b>Остальные варианты</b>");
      for (const [reason, n] of [...byOutcome].sort((a, b) => b[1] - a[1])) {
        lines.push(`❌ ${esc(reason)} — ${n}`);
      }
      lines.push("");
    }

    lines.push(
      `Проверено вариантов: ${checks.length}. Адреса выводятся из программы пула и минта; ` +
        "верным считается только тот, про который сеть сама сказала, что это токен-аккаунт этого минта."
    );

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
