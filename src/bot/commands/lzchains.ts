import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { getLzEidMap } from "../../services/idMaps";
import {
  fetchLzEidsFromMetadata,
  lzEidsNow,
  lastMetadataChainCount,
  explainMissing,
} from "../../bridges/lzMetadata";
import { replyInParts } from "../reply";

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

    const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
    const detailed = /\s(подробно|full|detail)\b/i.test(text);

    const [map] = await Promise.all([getLzEidMap(), fetchLzEidsFromMetadata()]);
    // Asked after both awaits, not taken from one of them: the chain table
    // fills in the background, and the seconds spent waiting here are
    // exactly when it grows.
    const metadata = lzEidsNow();

    const known: string[] = [];
    const missing: string[] = [];
    for (const chain of CHAINS) {
      // The fresh index first, the built map second. The map is assembled
      // over the chain table as it stood when the build began, and the build
      // is the slow part of this command - so right after a restart it
      // answers for a table of a hundred and forty while the report prints
      // against two hundred and fifty. The map still contributes the chains
      // whose eid came from asking the endpoint rather than from metadata.
      const eid = metadata.get(chain.key) ?? map.chainKeyToId.get(chain.key);
      if (eid === undefined) {
        // Naming the reason, not just the chain: absent from the source,
        // listed under a name we do not recognise, and deployed on V1 only
        // are three different situations, and only one is ours to fix.
        missing.push(`${chain.label} — ${explainMissing(chain.key, chain.viemChain.id)}`);
        continue;
      }
      // The endpoint answers directly where it sits at the usual address;
      // everything else was filled in from the published metadata.
      const source = metadata.get(chain.key) === eid ? "метаданные" : "узел";
      known.push(`${chain.label} — ${eid} <i>(${source})</i>`);
    }

    // The chains without an eid go first, and the ones with an eid are a
    // list rather than a hundred and three lines.
    //
    // This report is opened to find out where the peer walk cannot go, and
    // it was printing one line per resolved chain before getting to that -
    // so at a hundred and three chains the answer fell off the end and the
    // message said "обрезан". The same thing /chains was doing, for the same
    // reason, and the fix is the same: whichever half a person can act on
    // comes first.
    const lines = [
      `<b>Сети LayerZero: ${known.length} из ${CHAINS.length}</b>`,
      `В метаданных сетей: ${lastMetadataChainCount()}, из них сопоставлено с нашими: ${metadata.size}`,
    ];

    if (missing.length > 0) {
      // Grouped by what the answer means, because one answer means nothing
      // to do. A hundred and forty-eight lines, and a hundred and forty of
      // them said "LayerZero is not deployed there" - which is not a gap,
      // it is the ordinary state of most chains. The handful that say "we
      // have this chain under another name and failed to match it" are the
      // whole reason to open this report, and they were buried among them
      // and then cut off the end.
      const deployed: string[] = [];
      const notDeployed: string[] = [];
      for (const m of missing) {
        (/LayerZero туда не развёрнут/.test(m) ? notDeployed : deployed).push(m);
      }

      if (deployed.length > 0) {
        lines.push(
          "",
          `<b>Есть в метаданных, но eid не определился</b> — ${deployed.length}:`,
          ...deployed.map((m) => `❌ ${esc(m)}`)
        );
      }
      if (notDeployed.length > 0) {
        lines.push(
          "",
          `<b>LayerZero туда не развёрнут</b> — ${notDeployed.length}. Это не пробел, а обычное состояние большинства сетей:`,
          esc(notDeployed.map((m) => m.split(" — ")[0]).join(", "))
        );
      }
    }

    if (known.length > 0) {
      lines.push("", "<b>Известен eid</b>");
      if (detailed) {
        lines.push(
          ...known.map((k) => `✅ ${esc(k).replace(/&lt;i&gt;/g, "<i>").replace(/&lt;\/i&gt;/g, "</i>")}`)
        );
      } else {
        lines.push(esc(known.map((k) => k.split(" — ")[0]).join(", ")));
        lines.push("<i>С eid и источником: /lzchains подробно</i>");
      }
    }

    await replyInParts(ctx, lines.join("\n"));
  });
}
