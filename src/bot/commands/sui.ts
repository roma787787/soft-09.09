import type { Telegraf, Context } from "telegraf";
import { lookupToken } from "../../services/coingecko";
import { findRegistryDeploymentsOnChain } from "../../bridges/layerzero";
import { probeSuiHolder, probeSuiObject, readSuiSupply, suiCoinMetadata, suiTokenBridge } from "../../bridges/sui";
import { SUI_CHAIN, isSuiCoinType } from "../../config/suiChain";
import { suiEndpoints } from "../../services/suiClient";
import { capToTelegramLimit } from "../render";

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
    const symbol = text.trim().split(/\s+/)[1]?.toUpperCase();
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
    const coinType = token?.otherPlatforms.find((p) => p.chainKey === SUI_CHAIN.key)?.tokenAddress;
    if (!coinType) {
      lines.push(
        "CoinGecko не знает этот токен на Sui — типа монеты, о котором спрашивать, нет.",
        "",
        `Что CoinGecko знает: ${esc(
          [...(token?.platforms ?? []), ...(token?.otherPlatforms ?? [])].map((p) => p.platformName).join(", ") ||
            "ничего"
        )}.`
      );
      await ctx.reply(capToTelegramLimit(lines.join("\n")), { parse_mode: "HTML" });
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
      `Выпуск: <code>${esc(supply?.amount !== undefined ? supply.amount.toString() : "—")}</code>` +
        ` · знаков: <code>${esc(meta?.decimals !== undefined ? String(meta.decimals) : "—")}</code>` +
        ` · тикер монеты: <code>${esc(meta?.symbol ?? "—")}</code>`
    );
    if (supply?.reason) lines.push(`  <i>${esc(supply.reason)}</i>`);

    // The two candidates worth asking: Wormhole's own state object, and
    // whatever LayerZero's registry names on this chain.
    const holders: Array<{ what: string; address: string }> = [];
    const bridge = suiTokenBridge();
    if (bridge) holders.push({ what: "Wormhole Token Bridge", address: bridge });
    for (const deployment of await findRegistryDeploymentsOnChain(symbol, SUI_CHAIN.key)) {
      holders.push({ what: `LayerZero — ${deployment.rawType}`, address: deployment.address });
    }

    if (holders.length === 0) {
      lines.push("", "Ни один реестр не называет держателя на Sui.");
    }

    for (const holder of holders.slice(0, 3)) {
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

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
