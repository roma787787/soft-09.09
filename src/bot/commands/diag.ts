import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { getClient } from "../../services/rpcClient";
import { hasCustomRpc } from "../../config/env";
import { plural, capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface ChainHealth {
  chainKey: string;
  label: string;
  ok: boolean;
  blockNumber?: bigint;
  ms?: number;
  error?: string;
  custom: boolean;
}

async function checkChain(chainKey: string, label: string): Promise<ChainHealth> {
  const custom = hasCustomRpc(chainKey);
  const started = Date.now();
  try {
    const blockNumber = await getClient(chainKey).getBlockNumber();
    return { chainKey, label, ok: true, blockNumber, ms: Date.now() - started, custom };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const firstLine = message.split("\n")[0].trim();
    return {
      chainKey,
      label,
      ok: false,
      error: firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine,
      custom,
    };
  }
}

/**
 * Reports whether each chain's RPC actually answers. Without this, an
 * unreachable node is indistinguishable from "the address is not a bridge",
 * and there is no way to tell them apart from a phone.
 */
export function registerDiagCommand(bot: Telegraf) {
  bot.command("diag", async (ctx: Context) => {
    await ctx.sendChatAction("typing");

    const health = await Promise.all(CHAINS.map((c) => checkChain(c.key, c.label)));

    const lines = health.map((h) => {
      const source = h.custom ? "свой RPC" : "публичный";
      if (h.ok) {
        return `✅ <b>${esc(h.label)}</b> — блок ${h.blockNumber}, ${h.ms} мс <i>(${source})</i>`;
      }
      return `❌ <b>${esc(h.label)}</b> <i>(${source})</i>\n   <code>${esc(h.error ?? "нет ответа")}</code>`;
    });

    const okCount = health.filter((h) => h.ok).length;
    const header = `🩺 Связь с сетями: ${okCount} из ${health.length}\n\n`;

    let footer = "";
    const failed = health.filter((h) => !h.ok);
    if (failed.length > 0) {
      // Naming the variables outright: deriving SWELL_RPC_URL from
      // "Swellchain" is a small step at a desk and an annoying one on a
      // phone, which is where this bot is actually operated from.
      const vars = failed
        .map((h) => CHAINS.find((c) => c.key === h.chainKey)?.rpcEnvVar)
        .filter((v): v is string => !!v)
        .map((v) => `<code>${esc(v)}</code>`)
        .join(", ");
      footer =
        `\n\nСети с ❌ сейчас не проверяются командой /info. ` +
        `Публичные ноды часто отказывают серверам хостинга. ` +
        `Лечится своим RPC — пропиши его в ${vars}.`;
    }

    const thin = CHAINS.filter((c) => c.defaultRpcUrls.length === 1 && !hasCustomRpc(c.key)).length;
    if (thin > 0) {
      // A chain with one endpoint is not broken, it is one refusal away from
      // being broken - and a chain that drops out of a report reads as "no
      // liquidity here" rather than as a node that said no.
      footer += `\n\nУ ${thin} ${plural(thin, "сети", "сетей", "сетей")} только один публичный узел: ` +
        `сегодня отвечает, но запасного у него нет.`;
    }

    // Forty-two chains is close enough to the message limit that a few
    // multi-line failures would push it over, and a report Telegram refuses
    // looks to the user exactly like a bot that is down.
    await ctx.reply(capToTelegramLimit(header + lines.join("\n") + footer), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
