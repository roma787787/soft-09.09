import type { Telegraf, Context } from "telegraf";
import { checkKey } from "../../services/coingecko";
import { capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Says whether the CoinGecko key is actually working.
 *
 * Asked with a request, not inferred from the variable being set: a key can
 * be present and still be refused - pasted short, pasted with a space, or
 * paired with the wrong base URL, which CoinGecko does not complain about
 * because it simply ignores the header it was not expecting. That failure
 * looks exactly like a key that does not work, and there was no way to tell
 * the two apart from a phone.
 */
export function registerGeckoCommand(bot: Telegraf) {
  bot.command("gecko", async (ctx: Context) => {
    await ctx.sendChatAction("typing");
    const status = await checkKey();

    const lines: string[] = ["🦎 <b>CoinGecko</b>", ""];

    // The key itself is never printed. Its length and its whitespace are,
    // because those are the two ways a paste goes wrong and neither is
    // visible in a hosting panel that masks the value.
    lines.push(
      status.configured
        ? `Ключ: задан, ${status.keyLength} ${status.keyLength === 1 ? "символ" : "символов"}`
        : "Ключ: <b>не задан</b>"
    );
    if (status.untrimmed) lines.push("⚠️ В ключе есть лишние пробелы по краям — их надо убрать.");
    lines.push(`База: <code>${esc(status.base)}</code>`);
    if (status.configured) lines.push(`Заголовок: <code>${esc(status.header)}</code>`);
    lines.push("");

    if (!status.reachable) {
      lines.push(
        "❌ <b>CoinGecko не отвечает вообще.</b>",
        `<code>${esc(status.error ?? "нет ответа")}</code>`,
        "",
        "Дело не в ключе — до сервиса не доходит сам запрос."
      );
      await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
      return;
    }

    lines.push("✅ Связь есть.");

    if (!status.configured) {
      lines.push(
        "",
        "Без ключа бот работает, но лимит считается на IP, а хостинг делит адрес " +
          "с чужими ботами — поэтому будут 429. Лечится бесплатным ключом: " +
          "coingecko.com → API → Demo, затем переменная <code>COINGECKO_API_KEY</code>."
      );
      await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
      return;
    }

    if (!status.accepted) {
      lines.push(
        "",
        "❌ <b>Ключ не принят.</b>",
        `<code>${esc(status.error ?? "без объяснения")}</code>`,
        "",
        "Чаще всего это несовпадение тарифа и адреса: ключ Demo работает только с " +
          "<code>api.coingecko.com</code>, ключ Pro — только с <code>pro-api.coingecko.com</code>. " +
          "При неверной паре CoinGecko не ругается, а молча игнорирует заголовок."
      );
      await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
      return;
    }

    lines.push("✅ <b>Ключ принят.</b>");
    if (status.plan) lines.push(`Тариф: ${esc(status.plan)}`);
    if (status.perMinute !== undefined) lines.push(`Лимит: ${status.perMinute} запросов в минуту`);
    if (status.monthlyCredit !== undefined) {
      const used = status.monthlyUsed ?? 0;
      const left = status.monthlyLeft ?? status.monthlyCredit - used;
      lines.push(`Квота за месяц: ${used} из ${status.monthlyCredit}, осталось ${left}`);
    }

    lines.push(
      "",
      "<i>Один /info тратит до трёх запросов: поиск монеты, её сети и — раз в 12 часов — список сетей.</i>"
    );

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
