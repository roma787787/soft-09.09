import type { Telegraf, Context } from "telegraf";
import { parseAddressChainArgs } from "../parse";
import { formatInfoCard } from "../format";
import { detectOnChain } from "../../protocols/registry";
import { CHAINS, getChain } from "../../config/chains";

const REPLY_OPTS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

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

    // --- one chain, named explicitly ---
    if (chainKey) {
      const outcome = await detectOnChain(chainKey, address);
      const chainName = getChain(chainKey)?.label ?? chainKey;

      if (outcome.rpcError) {
        await ctx.reply(
          `⚠️ Не удалось получить ответ от ноды сети <b>${chainName}</b>, поэтому проверить адрес не вышло.\n\n` +
            `<code>${outcome.rpcError}</code>\n\n` +
            `Это проблема доступа к сети, а не самого адреса. Обычно помогает свой RPC-ключ. ` +
            `Проверить все сети разом: /diag`,
          REPLY_OPTS
        );
        return;
      }

      if (outcome.noContract) {
        await ctx.reply(
          `🔎 <b>${chainName}</b>\n<code>${address}</code>\n\n` +
            `По этому адресу в сети ${chainName} нет контракта: это либо обычный кошелёк, либо контракт развёрнут в другой сети.\n\n` +
            `Попробуйте без указания сети, бот проверит все: <code>/info ${address}</code>`,
          REPLY_OPTS
        );
        return;
      }

      await ctx.reply(formatInfoCard(chainKey, address, outcome.results), REPLY_OPTS);
      return;
    }

    // --- no chain given: scan every configured chain ---
    const perChain = await Promise.all(
      CHAINS.map(async (c) => ({ chain: c.key, outcome: await detectOnChain(c.key, address) }))
    );

    const withHits = perChain.filter((p) => p.outcome.results.length > 0);
    if (withHits.length > 0) {
      for (const hit of withHits) {
        await ctx.reply(formatInfoCard(hit.chain, address, hit.outcome.results), REPLY_OPTS);
      }
      return;
    }

    const failed = perChain.filter((p) => p.outcome.rpcError);
    const contractFoundOn = perChain
      .filter((p) => !p.outcome.rpcError && !p.outcome.noContract)
      .map((p) => getChain(p.chain)?.label ?? p.chain);

    // Every chain we could actually reach came back empty - but say so only
    // about the chains that answered.
    if (failed.length === CHAINS.length) {
      await ctx.reply(
        `⚠️ Ни одна из сетей не ответила, проверить адрес не вышло.\n\n` +
          `<code>${failed[0].outcome.rpcError}</code>\n\n` +
          `Похоже на проблему с доступом к нодам. Подробности по каждой сети: /diag`,
        REPLY_OPTS
      );
      return;
    }

    const checked = perChain
      .filter((p) => !p.outcome.rpcError)
      .map((p) => getChain(p.chain)?.label ?? p.chain);

    let message =
      `🔎 <code>${address}</code>\n\n` +
      `Не удалось распознать этот адрес как контракт LayerZero / Hyperlane / Transporter (CCIP или CCTP) / Portal.\n\n` +
      `Проверено: ${checked.join(", ")}.`;

    if (contractFoundOn.length > 0) {
      message +=
        `\n\nКонтракт по этому адресу есть (${contractFoundOn.join(", ")}), но он не похож ни на один из поддерживаемых мостов.`;
    }

    if (failed.length > 0) {
      const failedNames = failed.map((p) => getChain(p.chain)?.label ?? p.chain);
      message += `\n\n⚠️ Не ответили и остались непроверенными: ${failedNames.join(", ")}. Подробности: /diag`;
    }

    await ctx.reply(message, REPLY_OPTS);
  });
}
