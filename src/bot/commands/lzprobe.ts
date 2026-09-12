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
/**
 * What the registry holds for one chain, across every ticker in it.
 *
 * Raw, and deliberately unfiltered: the point is to see the shape of an
 * address and the wording of a type on a chain the reader currently throws
 * away, which is exactly the information a filter would remove.
 */
export function deploymentsOnChain(
  data: Record<string, unknown>,
  chainQuery: string
): { chainKeys: string[]; found: number; rows: string[] } {
  const wanted = chainQuery.toLowerCase().replace(/[^a-z0-9]/g, "");
  const chainKeys = new Set<string>();
  const rows: string[] = [];
  let found = 0;

  for (const [ticker, entries] of Object.entries(data)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Array<{ deployments?: Record<string, { address?: unknown; type?: unknown }> }>) {
      for (const [chainKey, deployment] of Object.entries(entry?.deployments ?? {})) {
        const normalised = chainKey.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!normalised.includes(wanted)) continue;
        chainKeys.add(chainKey);
        found++;
        if (rows.length < 12) {
          rows.push(`${ticker} @ ${chainKey}\n  type: ${String(deployment?.type ?? "?")}\n  addr: ${String(deployment?.address ?? "?")}`);
        }
      }
    }
  }
  return { chainKeys: [...chainKeys], found, rows };
}

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

      // A word that is not a ticker is read as a chain name, and the registry
      // is scanned for what it says about that chain instead.
      //
      // This exists because the reader drops what it cannot use without
      // saying so: deployments are kept only when the address is hex and the
      // chain resolves to an EVM one, so a TON or Sui deployment vanishes
      // before anyone sees its shape. Building a reader for a chain means
      // first seeing what the registry actually holds for it, and every
      // non-EVM family here was built that way.
      // Whether the chain scan ran, so the reply can say what was tried. A
      // word that is neither a ticker nor a chain got "SUI is not in the
      // registry" and a sample of some other token - and the fact that
      // mattered, that the registry holds nothing on Sui at all, was the one
      // thing the answer did not say.
      let scannedAsChain = false;
      if (wanted && data[wanted] === undefined) {
        scannedAsChain = true;
        const sample = deploymentsOnChain(data, wanted);
        if (sample.found > 0) {
          const shownRows = sample.rows.slice(0, 12).join("\n");
          await ctx.reply(
            `🔬 Реестр OFT LayerZero — сеть <b>${esc(wanted)}</b>\n\n` +
              `Ключей сети, похожих на запрос: ${esc(sample.chainKeys.join(", "))}\n` +
              `Деплоев на ней: ${sample.found}\n\n` +
              `<pre>${esc(shownRows)}</pre>\n\n` +
              `Пришлите это — по адресам и типам я пойму, как читать эту сеть.`,
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
          );
          return;
        }
      }

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
          `Показан: <b>${esc(pick!)}</b>${
            wanted && !data[wanted]
              ? ` (${esc(wanted)} в реестре нет${scannedAsChain ? " — ни как тикера, ни как сети: деплоев там ноль" : ""})`
              : ""
          }\n\n` +
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
