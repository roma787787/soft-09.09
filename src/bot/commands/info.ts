import type { Telegraf, Context } from "telegraf";
import { parseAddressChainArgs } from "../parse";
import { formatInfoCard } from "../format";
import { detectOnChain } from "../../protocols/registry";
import { CHAINS } from "../../config/chains";

export function registerInfoCommand(bot: Telegraf) {
  bot.command("info", async (ctx: Context) => {
    const text = (ctx.message as any)?.text ?? "";
    const parsed = parseAddressChainArgs(text);
    if (parsed.error || !parsed.address) {
      await ctx.reply(
        `${parsed.error ?? "Неверные аргументы."}\n\nПример: <code>/info 0x1234...abcd arbitrum</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const { address, chainKey } = parsed;
    await ctx.sendChatAction("typing");

    if (chainKey) {
      const results = await detectOnChain(chainKey, address);
      await ctx.reply(formatInfoCard(chainKey, address, results), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      return;
    }

    // No chain given - scan every configured chain in parallel.
    const perChain = await Promise.all(
      CHAINS.map(async (c) => ({ chain: c.key, results: await detectOnChain(c.key, address) }))
    );
    const withHits = perChain.filter((p) => p.results.length > 0);

    if (withHits.length === 0) {
      const chainNames = CHAINS.map((c) => c.label).join(", ");
      await ctx.reply(
        `🔎 <code>${address}</code>\n\n` +
          `Не удалось распознать этот адрес как контракт LayerZero / Hyperlane / Transporter (CCIP или CCTP) / Portal ни на одной из проверенных сетей (${chainNames}).\n\n` +
          "Возможно, это не мост, не контракт, либо сеть не входит в список поддерживаемых.",
        { parse_mode: "HTML" }
      );
      return;
    }

    for (const hit of withHits) {
      await ctx.reply(formatInfoCard(hit.chain, address, hit.results), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
  });
}
