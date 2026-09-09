import type { Telegraf, Context } from "telegraf";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The LayerZero OFT registry, confirmed live: an object keyed by ticker,
 * each holding one or more entries with name, sharedDecimals,
 * endpointVersion and deployments.
 *
 * The spec allowed automating LayerZero if a suitable source turned up.
 * This is it. The host is unreachable from the development environment, so
 * the deployed bot dumps one real entry and the parser is written against
 * that rather than against a guess. The URL is fixed in source; the bot
 * never fetches an address someone hands it.
 */
const OFT_LIST_URL = "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list";

/**
 * Dumps one ticker's entry in full so every field of `deployments` is
 * visible. Picks the smallest entry when no ticker is given, which keeps
 * the reply inside Telegram's limit while still showing the whole shape.
 */
export function registerLzProbeCommand(bot: Telegraf) {
  bot.command("lzprobe", async (ctx: Context) => {
    await ctx.sendChatAction("typing");

    const wanted = ((ctx.message as any)?.text ?? "").trim().split(/\s+/)[1]?.toUpperCase();

    try {
      const response = await fetch(OFT_LIST_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) {
        await ctx.reply(`❌ HTTP ${response.status} от реестра OFT`);
        return;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const keys = Object.keys(data);

      let pick = wanted && data[wanted] !== undefined ? wanted : undefined;
      if (!pick) {
        // Smallest entry: shows every field without risking the size cap.
        let best: { key: string; size: number } | undefined;
        for (const k of keys) {
          const size = JSON.stringify(data[k]).length;
          if (size > 200 && (!best || size < best.size)) best = { key: k, size };
        }
        pick = best?.key ?? keys[0];
      }

      const entry = JSON.stringify(data[pick!], null, 1);
      const shown = entry.length > 2600 ? `${entry.slice(0, 2600)}\n… обрезано` : entry;

      await ctx.reply(
        `🔬 Реестр OFT LayerZero\n\n` +
          `Тикеров всего: ${keys.length}\n` +
          `Показан: <b>${esc(pick!)}</b>${wanted && !data[wanted] ? ` (запрошенного ${esc(wanted)} в реестре нет)` : ""}\n\n` +
          `<pre>${esc(shown)}</pre>\n\n` +
          `Пришлите это — по структуре я напишу разбор. Другой тикер: /lzprobe USDT`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Не удалось получить реестр: ${esc(message.slice(0, 150))}`);
    }
  });
}
