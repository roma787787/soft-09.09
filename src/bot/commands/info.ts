import type { Telegraf, Context } from "telegraf";
import { parseAddressChainArgs } from "../parse";
import { formatInfoCard } from "../format";
import { detectOnChain } from "../../protocols/registry";
import { scanAccounting, scanChainsForAddress } from "../../services/chainScan";
import { getChain, resolveChain, resolveAnyChain } from "../../config/chains";
import { isAddress } from "viem";
import { replyWithLiquidity } from "./liquidity";
import { plural } from "../render";
import { replyInParts } from "../reply";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Reply for "the contract is there, but it is none of the four bridges".
 * Reports what the probe did learn instead of leaving a dead end, and never
 * repeats the old claim that the address might not be a contract - by this
 * point we have read its bytecode.
 */
function notABridgeMessage(chainKey: string, address: string, profile: Array<[string, string]> | undefined): string {
  const chain = getChain(chainKey);
  const chainName = chain?.label ?? chainKey;
  const link = chain ? `<a href="${chain.explorerAddressUrl(address)}">${esc(address)}</a>` : `<code>${esc(address)}</code>`;

  const lines = [
    `🔎 <b>${esc(chainName)}</b>`,
    link,
    "",
    "Контракт по этому адресу есть, но он не относится ни к LayerZero, ни к Hyperlane, ни к Transporter, ни к Portal.",
  ];

  if (profile && profile.length > 0) {
    lines.push("", "<b>Что удалось узнать:</b>");
    for (const [k, v] of profile) lines.push(`• ${esc(k)}: <code>${esc(v)}</code>`);
  }

  // The most common reason for landing here: the address is the token, but
  // for a token that already existed the bridge is a SEPARATE contract (an
  // OFT Adapter or a Warp Route) that locks it. The token itself knows
  // nothing about bridging, so no probe on it can ever succeed.
  if (profile?.some(([k]) => k.startsWith("Похож на токен"))) {
    lines.push(
      "",
      "<b>Это обычный токен, а не мост.</b> Если токен ходит между сетями, за это отвечает отдельный контракт рядом с ним: OFT Adapter у LayerZero или Warp Route у Hyperlane. Он блокирует токен у себя, а сам токен о мостах ничего не знает.",
      "",
      "Найти его можно так: открой токен в эксплорере, вкладка Holders. Адрес контракта с самым большим балансом обычно и есть тот самый мост. Его и проверяй командой /info."
    );
  }

  lines.push(
    "",
    "Бот распознаёт только эти четыре протокола. Мосты вроде Across, Celer, Symbiosis, Meson и обычные токены он не определяет."
  );

  if (profile?.some(([k]) => k.startsWith("Это прокси"))) {
    lines.push(
      "",
      "Контракт обновляемый: администратор прокси может заменить его логику. Проверять адрес реализации отдельно смысла нет, вызовы через прокси и так исполняют её код."
    );
  }

  return lines.join("\n");
}

const REPLY_OPTS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

export function registerInfoCommand(bot: Telegraf) {
  bot.command("info", async (ctx: Context) => {
    const text = (ctx.message as any)?.text ?? "";

    // /info takes a ticker (liquidity across bridges). An address argument
    // keeps working and runs the contract identification instead, since
    // that is a different question about a different kind of input.
    const parts = text.trim().split(/\s+/);
    const firstArg = parts[1];
    if (firstArg && !isAddress(firstArg, { strict: false })) {
      // A second word narrows the report to one chain: "/info USDC base"
      // answers the question actually being asked before a transfer.
      const chain = parts[2] ? resolveAnyChain(parts[2]) : undefined;
      if (parts[2] && !chain) {
        await ctx.reply(`Сеть <b>${esc(parts[2])}</b> не подключена. Список: <code>/diag</code>`, REPLY_OPTS);
        return;
      }
      await replyWithLiquidity(ctx, firstArg, chain?.key);
      return;
    }

    const parsed = parseAddressChainArgs(text);
    if (parsed.error || !parsed.address) {
      await ctx.reply(
        "Укажите тикер токена или адрес контракта.\n\n" +
          "<code>/info ARB</code> — сколько ARB лежит в хранилищах мостов\n" +
          "<code>/info 0x1234...abcd arbitrum</code> — что это за контракт",
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

      if (outcome.results.length === 0) {
        await ctx.reply(notABridgeMessage(chainKey, address, outcome.profile), REPLY_OPTS);
        return;
      }

      const card = formatInfoCard(chainKey, address, outcome.results);
      const warning = outcome.degraded
        ? "\n\n⚠️ Часть запросов к ноде не прошла, поэтому данных в карточке может не хватать. Повторите команду или проверьте сети через /diag."
        : "";
      await ctx.reply(card + warning, REPLY_OPTS);
      return;
    }

    // --- no chain given: scan every configured chain ---
    const scan = await scanChainsForAddress(address);
    const perChain = scan.perChain;

    const withHits = perChain.filter((p) => p.outcome.results.length > 0);
    if (withHits.length > 0) {
      for (const hit of withHits) {
        await ctx.reply(formatInfoCard(hit.chain, address, hit.outcome.results), REPLY_OPTS);
      }
      return;
    }

    const failed = perChain.filter((p) => p.outcome.rpcError);
    // Kept as chain keys, not labels: the example command below has to name
    // one of them, and a label is not what /info takes.
    const contractFoundOn = perChain
      .filter((p) => !p.outcome.rpcError && !p.outcome.noContract)
      .map((p) => p.chain);

    // Every chain we could actually reach came back empty - but say so only
    // about the chains that answered.
    if (failed.length === scan.reachable) {
      await ctx.reply(
        `⚠️ Ни одна из сетей не ответила, проверить адрес не вышло.\n\n` +
          `<code>${failed[0].outcome.rpcError}</code>\n\n` +
          `Похоже на проблему с доступом к нодам. Подробности по каждой сети: /diag`,
        REPLY_OPTS
      );
      return;
    }

    // Both numbers from one object, so they cannot come from two moments.
    const coverage = scanAccounting(scan, failed.map((p) => p.chain));

    // A count, not two hundred and twenty-nine names. The list was written
    // when the table held forty-two chains and it was reassuring; at this
    // size it is most of the message, and it pushed the part that matters -
    // which chains could not be reached - past Telegram's limit.
    let message =
      `🔎 <code>${address}</code>\n\n` +
      `Ни на одной сети этот адрес не относится к LayerZero, Hyperlane, Transporter или Portal.\n\n` +
      `Проверено ${coverage.checked} ${plural(coverage.checked, "сеть", "сети", "сетей")} из ${coverage.total}.`;

    if (contractFoundOn.length > 0) {
      message +=
        `\n\nКонтракт по этому адресу есть (${contractFoundOn
          .map((key) => getChain(key)?.label ?? key)
          .join(", ")}). ` +
        // The example names a chain the contract was actually found on.
        // It used to say "bsc" whenever there was more than one - so a
        // report that had just listed Ethereum and PulseChain went on to
        // suggest a third network, which is where the reader would have
        // found nothing.
        `Чтобы посмотреть, что это, укажите сеть явно: <code>/info ${address} ${contractFoundOn[0]}</code>`;
    }

    // Everything the scan did not finish, in one list rather than in a count
    // beside it. A second summary sentence said "0 не отвечают совсем" on a
    // report that went on to name twenty-two chains which had not answered,
    // and put 249 next to 229 in adjacent lines. Three ways of not being
    // checked - the node refused, the deadline ran out, the chain was known
    // silent before the sweep began - are one fact to whoever is reading:
    // this address was not looked for there.
    if (coverage.unchecked.length > 0) {
      const named = coverage.unchecked.map((key) => getChain(key)?.label ?? key);
      message += `\n\n⚠️ Не ответили и остались непроверенными: ${named.join(", ")}. Подробности: /diag`;
    }

    // Capped, which it never was: this is the one report that grew with the
    // chain table, and a message Telegram refuses looks from the phone
    // exactly like a bot that is down.
    await replyInParts(ctx, message, REPLY_OPTS);
  });
}
