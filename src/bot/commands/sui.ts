import type { Telegraf, Context } from "telegraf";
import { lookupToken } from "../../services/coingecko";
import { findRegistryDeploymentsOnChain } from "../../bridges/layerzero";
import {
  lastSuiIndexStats,
  probeSuiHolder,
  probeSuiObject,
  readSuiSupply,
  readSuiWormholeCustodyDetailed,
  suiCoinMetadata,
  suiTokenBridge,
} from "../../bridges/sui";
import { SUI_CHAIN, isSuiCoinType } from "../../config/suiChain";
import { suiEndpoints } from "../../services/suiClient";
import { replyInParts } from "../reply";
import { formatAmount } from "../../services/balances";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * What Sui answers, verbatim, for one ticker.
 *
 * The report reads Sui's supply and says plainly that no bridge's custody
 * there is read yet. Closing that gap needs the shape of the thing holding
 * the collateral, and it cannot be had from a laptop: Sui keeps a bridge's
 * money inside its state object rather than at an address, so the only way
 * to know what to walk is to ask the chain and look. Every other non-EVM
 * family got a command like this while it was being built, and each time it
 * turned three rounds of guessing into one round of looking.
 */
export function registerSuiCommand(bot: Telegraf) {
  bot.command("sui", async (ctx: Context) => {
    const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
    const parts = text.trim().split(/\s+/);
    const symbol = parts[1]?.toUpperCase();
    // The object walk was scaffolding: it is how the registry's shape was
    // found, and the shape is encoded now. Kept behind a word rather than
    // deleted, because the day Wormhole upgrades its Sui package it is the
    // only thing that will say what moved - but it costs ten requests and
    // prints "notExists" for every table id, which is normal and reads as
    // broken.
    const raw = (parts[2] ?? "").toLowerCase() === "raw";
    if (!symbol) {
      await ctx.reply("Укажите тикер. Пример: <code>/sui USDC</code>", { parse_mode: "HTML" });
      return;
    }

    await ctx.sendChatAction("typing");

    const lines: string[] = [
      `<b>Sui — ${esc(symbol)}</b>`,
      `Узлы: ${esc(suiEndpoints().join(", "))}`,
      "",
    ];

    const token = await lookupToken(symbol);
    // A ticker nobody has heard of and a ticker that exists elsewhere are
    // different answers, and the second half of this reply - "here is what
    // CoinGecko does know" - is empty and puzzling for the first.
    if (!token) {
      lines.push(`Тикер <b>${esc(symbol)}</b> не найден на CoinGecko. Проверьте написание.`);
      await replyInParts(ctx, lines.join("\n"));
      return;
    }

    const coinType = token.otherPlatforms.find((p) => p.chainKey === SUI_CHAIN.key)?.tokenAddress;
    if (!coinType) {
      lines.push(
        "CoinGecko не знает этот токен на Sui — типа монеты, о котором спрашивать, нет.",
        "",
        `Что CoinGecko знает: ${esc(
          [...token.platforms, ...token.otherPlatforms].map((p) => p.platformName).join(", ") || "ничего"
        )}.`
      );
      await replyInParts(ctx, lines.join("\n"));
      return;
    }

    lines.push(`Тип монеты: <code>${esc(coinType)}</code>`);
    if (!isSuiCoinType(coinType)) {
      // CoinGecko files a Sui deployment under whichever of the two it has,
      // and a supply method asked about an address fails in a way that looks
      // like the chain being down.
      lines.push("Это не похоже на тип монеты Move — скорее адрес объекта, и выпуск по нему не спросить.");
    }

    const [supply, meta] = await Promise.all([readSuiSupply(coinType, symbol), suiCoinMetadata(coinType)]);
    lines.push(
      // Scaled, like every other amount this bot prints. Raw beside the
      // decimals made the reader do the division: TURBOS came back as
      // "Выпуск: 10000000000000000512 · знаков: 9", which is ten billion,
      // and nothing on the line said so. The raw integer stays visible
      // because this is a diagnostic and the exact value is the point.
      `Выпуск: <code>${esc(
        supply?.amount !== undefined && meta?.decimals !== undefined
          ? `${formatAmount(supply.amount, meta.decimals)} (${supply.amount.toString()})`
          : supply?.amount !== undefined
            ? supply.amount.toString()
            : "—"
      )}</code>` +
        ` · знаков: <code>${esc(meta?.decimals !== undefined ? String(meta.decimals) : "—")}</code>` +
        ` · тикер монеты: <code>${esc(meta?.symbol ?? "—")}</code>`
    );
    if (supply?.reason) lines.push(`  <i>${esc(supply.reason)}</i>`);

    // The walk the report actually runs, and its own account of itself.
    // "Not in the registry" and "the walk never got there" are the same
    // answer from outside, and they need opposite fixes.
    const { custody, reason: custodyReason } = await readSuiWormholeCustodyDetailed(coinType);
    const stats = lastSuiIndexStats();
    lines.push(
      "",
      "<b>Обход реестра Wormhole</b>",
      `  таблица: <code>${esc(stats.registryId ?? "не найдена")}</code>`,
      `  страниц: ${stats.pages} · записей: ${stats.entries} · из них залог: ${stats.native}, выпущено мостом: ${stats.wrapped}`,
      `  обход дошёл до конца: ${stats.complete ? "да" : "нет"}`
    );
    if (stats.reason) lines.push(`  <i>${esc(stats.reason)}</i>`);
    if (custody) {
      // Scaled like the supply line above it. Left raw, the two amounts on
      // one screen were printed to different rules - one readable, one not.
      lines.push(
        `  ✅ найдено: <code>${esc(custody.objectId)}</code> — <code>${esc(
          meta?.decimals !== undefined
            ? `${formatAmount(custody.amount, meta.decimals)} (${custody.amount.toString()})`
            : custody.amount.toString()
        )}</code>`
      );
    } else if (custodyReason) {
      // Its own message. "Not among the collateral" wore this one's words for
      // a whole round, on the same screen that listed the coin as found.
      lines.push(`  ⚠️ запись нашлась, но баланс не прочитан\n     <i>${esc(custodyReason)}</i>`);
    } else {
      lines.push("  ❌ этой монеты среди залоговых записей нет");
      // Named, because "not among the collateral" is unfalsifiable on its
      // own: an index that found sixty assets and one that matched none of
      // them say the same thing, and the only way to tell is to go and ask
      // about one it did find.
      for (const held of stats.sample) lines.push(`  · залог есть под <code>${esc(held)}</code>`);
    }

    // The two candidates worth asking: Wormhole's own state object, and
    // whatever LayerZero's registry names on this chain.
    const holders: Array<{ what: string; address: string }> = [];
    const bridge = suiTokenBridge();
    if (bridge) holders.push({ what: "Wormhole Token Bridge", address: bridge });
    for (const deployment of await findRegistryDeploymentsOnChain(symbol, SUI_CHAIN.key)) {
      holders.push({ what: `LayerZero — ${deployment.rawType}`, address: deployment.address });
    }

    // Named whether or not the dump is asked for: LayerZero is deployed on
    // Sui and the bot does not read it, so a report saying "only Wormhole is
    // checked here" should be backed by a number rather than left as a
    // blanket caveat.
    const lzOnSui = holders.filter((h) => h.what.startsWith("LayerZero"));
    lines.push(
      "",
      lzOnSui.length === 0
        ? "Реестр LayerZero не называет по этому тикеру ничего на Sui."
        : `Реестр LayerZero называет на Sui ${lzOnSui.length} ${lzOnSui.length === 1 ? "контракт" : "контракта"} — бот их пока не читает:`
    );
    for (const holder of lzOnSui.slice(0, 3)) {
      lines.push(`  <code>${esc(holder.address)}</code> — ${esc(holder.what.replace(/^LayerZero — /, ""))}`);
    }

    if (!raw) {
      lines.push("", `Сырой обход объекта моста: <code>/sui ${esc(symbol)} raw</code>`);
    }
    for (const holder of raw ? holders.slice(0, 3) : []) {
      lines.push("", `<b>${esc(holder.what)}</b>`, `<code>${esc(holder.address)}</code>`);
      const probe = await probeSuiHolder(holder.address, coinType);
      lines.push(`  баланс: <code>${esc(probe.balance)}</code>`);
      if (probe.fieldsNote) lines.push(`  динамические поля: <i>${esc(probe.fieldsNote)}</i>`);
      for (const field of probe.fields.slice(0, 6)) {
        lines.push(`  · <code>${esc(field.objectType)}</code>\n    имя: <code>${esc(field.name)}</code>`);
      }

      // No dynamic fields on the object itself does not mean it holds
      // nothing: on Sui a registry is a field of the state and its table is
      // an object of its own, so what the walk needs is one level in.
      const shape = await probeSuiObject(holder.address);
      lines.push(`  тип: <code>${esc(shape.type)}</code>`);
      if (shape.note) lines.push(`  <i>${esc(shape.note)}</i>`);
      if (shape.fields.length > 0) lines.push(`  поля объекта: ${esc(shape.fields.join(", "))}`);

      // Every id, with the field it came from. The state carries three, and
      // a bare list made the emitter registry and the token registry
      // indistinguishable - the first walk followed the wrong one.
      for (const nested of shape.ids.slice(0, 8)) {
        const inner = await probeSuiObject(nested.id);
        const fields = await probeSuiHolder(nested.id, coinType);
        lines.push(
          `  ↳ <b>${esc(nested.path)}</b> <code>${esc(nested.id)}</code>`,
          `      тип: <code>${esc(inner.type)}</code>` + (inner.fields.length ? ` · поля: ${esc(inner.fields.join(", "))}` : ""),
          `      динамических полей: ${fields.fields.length}${fields.fieldsNote ? ` (${esc(fields.fieldsNote)})` : ""}`
        );
        if (inner.note) lines.push(`      <i>${esc(inner.note)}</i>`);
        for (const field of fields.fields.slice(0, 4)) {
          lines.push(`      · <code>${esc(field.objectType)}</code>\n        имя: <code>${esc(field.name)}</code>`);
        }
      }
    }

    await replyInParts(ctx, lines.join("\n"));
  });
}
