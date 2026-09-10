import type { Telegraf, Context } from "telegraf";
import type { Address } from "viem";
import { getChain } from "../../config/chains";
import { lookupToken } from "../../services/cmc";
import {
  findLayerZeroRegistryDeployments,
  probeLayerZeroToken,
  expandLayerZeroMesh,
} from "../../bridges/layerzero";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const chainName = (key: string) => getChain(key)?.label ?? key;

/**
 * Shows how far LayerZero coverage reaches for one ticker, and where it came
 * from: the registry, the token contract itself, or the peer walk.
 *
 * LayerZero has no complete public registry, so its coverage is assembled
 * from several partial sources. When a report looks thin the question is
 * which of them found nothing, and that is not visible from the report
 * itself.
 */
export function registerLzMeshCommand(bot: Telegraf) {
  bot.command("lzmesh", async (ctx: Context) => {
    const text = (ctx.message as any)?.text ?? "";
    const arg = text.trim().split(/\s+/)[1];
    if (!arg) {
      await ctx.reply("Укажите тикер. Пример: <code>/lzmesh USDT</code>", { parse_mode: "HTML" });
      return;
    }

    const symbol = arg.replace(/^\$/, "").slice(0, 32).toUpperCase();
    await ctx.sendChatAction("typing");

    const token = await lookupToken(symbol);
    if (!token) {
      await ctx.reply(`Тикер <b>${esc(symbol)}</b> не найден на CoinMarketCap.`, { parse_mode: "HTML" });
      return;
    }

    const deployments = await findLayerZeroRegistryDeployments(symbol);
    const seeds: Array<{ chainKey: string; oapp: Address }> = deployments.map((d) => ({
      chainKey: d.chainKey,
      oapp: d.address,
    }));

    const probes = await Promise.all(
      token.platforms
        .filter((p) => p.chainKey && !deployments.some((d) => d.chainKey === p.chainKey))
        .map(async (p) => ({ platform: p, probe: await probeLayerZeroToken(p.chainKey!, p.tokenAddress) }))
    );
    const probed = probes.filter((r) => r.probe);
    for (const { platform } of probed) {
      seeds.push({ chainKey: platform.chainKey!, oapp: platform.tokenAddress });
    }

    const lines = [`<b>LayerZero — ${esc(token.symbol)}</b>`, ""];

    lines.push(`<b>Реестр OFT</b>: ${deployments.length === 0 ? "тикера нет" : `${deployments.length}`}`);
    for (const d of deployments.slice(0, 8)) {
      lines.push(
        `  ${esc(chainName(d.chainKey))} — <code>${esc(d.rawType)}</code>${d.locksCollateral ? " (держит залог)" : " (чеканит)"}`
      );
    }

    lines.push("", `<b>Опрос контрактов токена</b>: ${probed.length === 0 ? "OFT не найден" : `${probed.length}`}`);
    for (const { platform, probe } of probed.slice(0, 8)) {
      lines.push(`  ${esc(chainName(platform.chainKey!))} — ${probe!.kind === "adapter" ? "адаптер" : "обычный OFT"}`);
    }

    if (seeds.length === 0) {
      lines.push("", "Зацепиться не за что: ни реестр, ни контракты токена не дали ни одного OFT.");
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      return;
    }

    const covered = new Set([...deployments.map((d) => d.chainKey), ...probed.map((r) => r.platform.chainKey!)]);
    const mesh = await expandLayerZeroMesh(seeds, symbol, covered);

    lines.push("", `<b>Сеть пиров</b>: дошли до ${mesh.reached.length} новых сетей`);
    for (const c of mesh.custodians.slice(0, 10)) {
      lines.push(`  ${esc(chainName(c.chainKey))} — адаптер <code>${esc(c.custodyAddress)}</code>`);
    }
    for (const chainKey of mesh.nativeChains.slice(0, 10)) {
      lines.push(`  ${esc(chainName(chainKey))} — чеканит, хранилища нет`);
    }
    if (mesh.reached.length === 0) {
      lines.push("  ничего нового: все пиры уже были найдены раньше");
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
}
