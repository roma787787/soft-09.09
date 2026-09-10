import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { getLzEidMap } from "../../services/idMaps";
import { fetchLzEidsFromMetadata } from "../../bridges/lzMetadata";
import { capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Which chains the bot can name to a LayerZero contract, and where each
 * number came from.
 *
 * The peer walk can only ask about a chain whose eid is known, so a missing
 * eid silently hides every deployment on that chain. Asking the endpoint
 * directly covers most chains but not the zk-rollups, where deterministic
 * deployment does not hold; this shows which source filled each gap, and
 * which chains are still unanswerable.
 */
export function registerLzChainsCommand(bot: Telegraf) {
  bot.command("lzchains", async (ctx: Context) => {
    await ctx.sendChatAction("typing");

    const [map, metadata] = await Promise.all([getLzEidMap(), fetchLzEidsFromMetadata()]);

    const known: string[] = [];
    const missing: string[] = [];
    for (const chain of CHAINS) {
      const eid = map.chainKeyToId.get(chain.key);
      if (eid === undefined) {
        missing.push(chain.label);
        continue;
      }
      // The endpoint answers directly where it sits at the usual address;
      // everything else was filled in from the published metadata.
      const source = metadata.get(chain.key) === eid ? "метаданные" : "узел";
      known.push(`${chain.label} — ${eid} <i>(${source})</i>`);
    }

    const lines = [
      `<b>Сети LayerZero: ${known.length} из ${CHAINS.length}</b>`,
      `Из метаданных получено: ${metadata.size}`,
      "",
      ...known.map((k) => `✅ ${esc(k).replace(/&lt;i&gt;/g, "<i>").replace(/&lt;\/i&gt;/g, "</i>")}`),
    ];
    if (missing.length > 0) {
      lines.push(
        "",
        `❌ Без eid: ${esc(missing.join(", "))}.`,
        "По этим сетям обход пиров не работает: спросить у контракта, кто его пир там, нечем."
      );
    }

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
