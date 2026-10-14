import type { Telegraf, Context } from "telegraf";
import { checkKey, traceTicker } from "../../services/coingecko";
import { replyInParts } from "../reply";

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
async function traceLines(symbol: string): Promise<string[]> {
  const t = await traceTicker(symbol);
  const lines = [`🦎 <b>Поиск тикера ${esc(t.symbol)}</b>`, ""];

  lines.push("<b>1. Поиск (/search)</b>");
  if (t.searchError) lines.push(`❌ ошибка: <code>${esc(t.searchError)}</code>`);
  else if (t.searchHits.length === 0) lines.push("ничего не вернул");
  else {
    for (const hit of t.searchHits) {
      const exact = hit.symbol.toUpperCase() === t.symbol ? " ✅ тикер совпал" : "";
      lines.push(
        `· <code>${esc(hit.id)}</code> — ${esc(hit.symbol.toUpperCase())}, ${esc(hit.name)}` +
          `${hit.rank !== undefined ? `, место ${hit.rank}` : ", без капитализации"}${exact}`
      );
    }
  }
  lines.push(t.searchPick ? `Выбор: <code>${esc(t.searchPick)}</code>` : "Выбора нет — ни одного точного совпадения.");

  if (t.fullListConsulted) {
    lines.push("", "<b>2. Полный список монет</b>");
    if (t.fullListError) lines.push(`❌ <code>${esc(t.fullListError)}</code>`);
    if (t.fullListSize !== undefined) lines.push(`В списке монет: ${t.fullListSize}`);
    if (t.fullListMatches.length === 0) lines.push("Совпадений по тикеру нет — CoinGecko такого тикера не знает.");
    for (const m of t.fullListMatches) {
      const rank = t.ranks?.find((r) => r.id === m.id)?.rank;
      lines.push(
        `· <code>${esc(m.id)}</code> — ${esc(m.name)}${rank !== undefined ? `, место ${rank}` : ", без капитализации"}`
      );
    }
  }

  lines.push("", "<b>Итог</b>");
  if (!t.pick) {
    lines.push("❌ Монета не выбрана — отчёт по этому тикеру построить не из чего.");
  } else {
    lines.push(`Монета: <code>${esc(t.pick)}</code>`);
    if (t.tokenError) lines.push(`❌ страница монеты не прочиталась: <code>${esc(t.tokenError)}</code>`);
    else if (t.tokenRead === false) lines.push("❌ страница монеты прочиталась, но токен из неё не собрался.");
    else lines.push(`✅ Сети: ${esc(t.platforms?.join(", ") || "ни одной")}`);
  }

  return lines;
}

export function registerGeckoCommand(bot: Telegraf) {
  bot.command("gecko", async (ctx: Context) => {
    await ctx.sendChatAction("typing");

    // With a ticker, the question is not about the key. "Тикер не найден"
    // covers five different failures and names none of them, so this walks
    // the same lookup the report walks and prints what each step answered.
    const asked = ((ctx.message as { text?: string } | undefined)?.text ?? "").trim().split(/\s+/)[1];
    if (asked) {
      await replyInParts(ctx, (await traceLines(asked)).join("\n"));
      return;
    }

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
      await replyInParts(ctx, lines.join("\n"));
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
      await replyInParts(ctx, lines.join("\n"));
      return;
    }

    if (!status.accepted) {
      lines.push(
        "",
        "❌ <b>Ключ не принят.</b>",
        "Отвергнут и на служебном запросе, и на рабочем — значит, дело именно в нём.",
        `<code>${esc(status.error ?? "без объяснения")}</code>`,
        "",
        "Чаще всего это несовпадение тарифа и адреса: ключ Demo работает только с " +
          "<code>api.coingecko.com</code>, ключ Pro — только с <code>pro-api.coingecko.com</code>. " +
          "При неверной паре CoinGecko не ругается, а молча игнорирует заголовок."
      );
      await replyInParts(ctx, lines.join("\n"));
      return;
    }

    lines.push("✅ <b>Ключ принят.</b>");
    if (status.quotaUnavailable) {
      // Proved by a real request, not by the usage endpoint - which this
      // plan does not carry, and whose 401 is indistinguishable from the
      // 401 of a key that is wrong.
      lines.push(
        "Проверено рабочим запросом с этим ключом.",
        "<i>Счётчик квоты этот тариф не отдаёт — на работу бота это не влияет.</i>"
      );
    }
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

    await replyInParts(ctx, lines.join("\n"));
  });
}
