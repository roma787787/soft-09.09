import type { Telegraf, Context } from "telegraf";
import { parseAddressChainArgs } from "../parse";
import { detectOnChain, type DetectionOutcome } from "../../protocols/registry";
import { getClient } from "../../services/rpcClient";
import { addTracked } from "../../services/db";
import { CHAINS, getChain } from "../../config/chains";
import { PROTOCOL_LABELS, type DetectionResult } from "../../protocols/types";
import { isUnreachable } from "../../services/rpcHealth";
import { mapWithConcurrency } from "../../services/concurrency";

/**
 * Chains asked at once when an address is checked against all of them.
 * Each chain costs one getCode before anything heavier, so this is about
 * not stampeding the nodes rather than about the work itself.
 */
const CHAIN_SCAN_CONCURRENCY = 24;

/**
 * How long one chain gets before the scan moves on.
 *
 * A chain whose endpoints are all dead costs six timeouts before getCode so
 * much as returns an error, and the table has grown from forty chains to two
 * hundred and fifty since this scan was written. Without a deadline the
 * first person to type /track without a network waits minutes and then gets
 * the generic error - the same failure /diag had, for the same reason.
 */
const CHAIN_DEADLINE_MS = 8_000;

/** The whole sweep, so the reply always arrives while someone is looking. */
const TOTAL_BUDGET_MS = 90_000;

/** Runs a probe under a deadline; a chain that overruns is not an answer. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
      //
      // Chains already known to answer nothing are not asked. That is where
      // the time went: today's /diag found seventeen of them, and each was
      // costing the scan six timeouts to re-learn what the last sweep
      // already recorded.
      const reachable = CHAINS.filter((c) => !isUnreachable(c.key));
      const started = Date.now();
      let skipped = 0;

      const perChain = await mapWithConcurrency(reachable, CHAIN_SCAN_CONCURRENCY, async (c) => {
        if (Date.now() - started > TOTAL_BUDGET_MS) {
          skipped++;
          return { chain: c.key, outcome: { results: [] } as DetectionOutcome };
        }
        const outcome = await withDeadline(detectOnChain(c.key, address), CHAIN_DEADLINE_MS);
        if (!outcome) skipped++;
        return { chain: c.key, outcome: outcome ?? ({ results: [] } as DetectionOutcome) };
      });
      const withHits = perChain.filter((p) => p.outcome.results.length > 0);

      // Said out loud whenever the sweep was not complete: "not found" and
      // "not looked at" are different answers, and only one of them means
      // the address is not there.
      const partial =
        skipped > 0 || reachable.length < CHAINS.length
          ? `\n\nПросмотрено ${reachable.length - skipped} сетей из ${CHAINS.length}: ` +
            `${CHAINS.length - reachable.length} не отвечают совсем, ${skipped} не уложились в отведённое время. ` +
            "Если сеть известна, укажите её явно — это и быстрее, и точнее."
          : "";
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
            " arbitrum</code>" +
            partial,
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
