import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { getClient } from "../../services/rpcClient";
import { hasCustomRpc } from "../../config/env";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface ChainHealth {
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
    return { label, ok: true, blockNumber, ms: Date.now() - started, custom };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const firstLine = message.split("\n")[0].trim();
    return {
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
    if (okCount < health.length) {
      footer =
        `\n\nСети с ❌ сейчас не проверяются командой /info. ` +
        `Публичные ноды часто отказывают серверам хостинга. ` +
        `Лечится своим ключом: заведи бесплатный на alchemy.com и добавь в переменные ` +
        `<code>ETHEREUM_RPC_URL</code> и аналогичные для нужных сетей.`;
    }

    await ctx.reply(header + lines.join("\n") + footer, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
