import type { Telegraf, Context } from "telegraf";
import { parseAddressChainArgs } from "../parse";
import { detectOnChain } from "../../protocols/registry";
import { getClient } from "../../services/rpcClient";
import { addTracked } from "../../services/db";
import { CHAINS, getChain } from "../../config/chains";
import { PROTOCOL_LABELS, type DetectionResult } from "../../protocols/types";
import { mapWithConcurrency } from "../../services/concurrency";

/**
 * Chains asked at once when an address is checked against all of them.
 * Each chain costs one getCode before anything heavier, so this is about
 * not stampeding the nodes rather than about the work itself.
 */
const CHAIN_SCAN_CONCURRENCY = 24;

export function registerTrackCommand(bot: Telegraf) {
  bot.command("track", async (ctx: Context) => {
    const text = (ctx.message as any)?.text ?? "";
    const parsed = parseAddressChainArgs(text);
    if (parsed.error || !parsed.address) {
      await ctx.reply(
        `${parsed.error ?? "Неверные аргументы."}\n\nПример: <code>/track 0x1234...abcd arbitrum</code>\n\nСеть обязательна, если бот не может определить её однозначно (один и тот же адрес может существовать на нескольких сетях).`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const chatId = String(ctx.chat!.id);
    const { address } = parsed;
    let chainKey = parsed.chainKey;

    await ctx.sendChatAction("typing");

    // Reused when the chain was auto-detected, so we don't run detection twice.
    let detected: DetectionResult[] | undefined;

    if (!chainKey) {
      // Bounded, for the same reason as /info: the chain table is discovered
      // rather than typed and has passed two hundred, and a sweep of that
      // many at once measures the queue rather than the nodes.
      const perChain = await mapWithConcurrency(CHAINS, CHAIN_SCAN_CONCURRENCY, async (c) => ({
        chain: c.key,
        outcome: await detectOnChain(c.key, address),
      }));
      const withHits = perChain.filter((p) => p.outcome.results.length > 0);
      if (withHits.length === 1) {
        chainKey = withHits[0].chain;
        detected = withHits[0].outcome.results;
      } else if (withHits.length > 1) {
        await ctx.reply(
          `Этот адрес найден сразу на нескольких сетях (${withHits.map((h) => getChain(h.chain)?.label).join(", ")}). Укажите сеть явно: <code>/track ${address} arbitrum</code>`,
          { parse_mode: "HTML" }
        );
        return;
      } else {
        await ctx.reply(
          "Не удалось автоматически определить сеть и протокол моста для этого адреса. Укажите сеть явно, например: <code>/track " +
            address +
            " arbitrum</code>",
          { parse_mode: "HTML" }
        );
        return;
      }
    }

    const results = detected ?? (await detectOnChain(chainKey, address)).results;
    const client = getClient(chainKey);
    const currentBlock = await client.getBlockNumber();

    const top = results[0];
    addTracked({
      chatId,
      chain: chainKey,
      address,
      protocol: top?.protocol,
      role: top?.role,
      label: top ? `${PROTOCOL_LABELS[top.protocol]} — ${top.role}` : undefined,
      lastBlock: currentBlock,
    });

    const chain = getChain(chainKey)!;
    await ctx.reply(
      `✅ Слежение включено: <b>${chain.label}</b>\n<code>${address}</code>\n\n` +
        (top
          ? `Протокол: ${PROTOCOL_LABELS[top.protocol]} (${top.role})`
          : "Протокол не определён — слежение продолжится по любым событиям контракта.") +
        `\n\nОповещения о новых событиях будут приходить в этот чат.`,
      { parse_mode: "HTML" }
    );
  });
}
