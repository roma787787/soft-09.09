import type { Telegraf, Context } from "telegraf";
import { getChain } from "../../config/chains";
import { lookupToken, CmcNotConfiguredError, CmcRequestError } from "../../services/cmc";
import { resolveCustodians } from "../../bridges";
import {
  probeLayerZeroToken,
  findLayerZeroRegistryDeployments,
  readAdapterUnderlying,
} from "../../bridges/layerzero";
import { findSyntheticHyperlaneChains } from "../../bridges/hyperlane";
import type { Custodian } from "../../bridges/types";
import { readCustodianBalances } from "../../services/balances";
import { renderLiquidityReport } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const REPLY_OPTS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

export async function buildLiquidityReport(rawSymbol: string): Promise<string> {
  const symbol = rawSymbol.trim().replace(/^\$/, "").toUpperCase();

  const token = await lookupToken(symbol);
  if (!token) {
    return `Тикер <b>${esc(symbol)}</b> не найден на CoinMarketCap. Проверьте написание.`;
  }

  const custodians = resolveCustodians(symbol, token.platforms);
  if (custodians.length === 0) {
    return (
      `<b>${esc(token.name)} (${esc(token.symbol)})</b>\n\n` +
      "По этому токену нет данных о бридж-контрактах.\n\n" +
      "Wormhole и Hyperlane подтягиваются автоматически, а адаптеры LayerZero ведутся вручную: " +
      "добавьте адрес в <code>config/layerzero-lockboxes.json</code>."
    );
  }

  const nativeOftChains = new Set<string>();
  const found: Custodian[] = [];
  const alreadyConfigured = new Set(
    custodians.filter((c) => c.protocol === "layerzero").map((c) => c.chainKey)
  );

  // LayerZero's own registry, keyed by ticker. An adapter there locks a real
  // token and is exactly the custody contract this report is about; a plain
  // OFT holds nothing anywhere, which is why an empty result for it must not
  // read as "not bridged". A chain already covered by the manual config is
  // left alone: a hand-entered address is a deliberate override.
  const deployments = await findLayerZeroRegistryDeployments(symbol);
  for (const deployment of deployments) {
    if (alreadyConfigured.has(deployment.chainKey)) continue;
    if (!deployment.locksCollateral) {
      nativeOftChains.add(deployment.chainKey);
      continue;
    }

    const underlying =
      (await readAdapterUnderlying(deployment.chainKey, deployment.address)) ??
      token.platforms.find((p) => p.chainKey === deployment.chainKey)?.tokenAddress;
    if (!underlying) continue;

    found.push({
      protocol: "layerzero",
      chainKey: deployment.chainKey,
      custodyAddress: deployment.address,
      tokenAddress: underlying,
      note: `из реестра LayerZero (${deployment.rawType})`,
    });
  }

  // Fall back to asking the token contracts directly for chains the registry
  // did not cover - it lists 358 tickers, not every token in existence.
  const uncovered = token.platforms.filter(
    (p) => p.chainKey && !deployments.some((d) => d.chainKey === p.chainKey) && !alreadyConfigured.has(p.chainKey)
  );
  const probes = await Promise.all(uncovered.map((p) => probeLayerZeroToken(p.chainKey!, p.tokenAddress)));
  for (const probe of probes) {
    if (!probe) continue;
    if (probe.kind === "native") {
      nativeOftChains.add(probe.chainKey);
      continue;
    }
    const platform = token.platforms.find((p) => p.chainKey === probe.chainKey);
    if (probe.wrappedToken && platform) {
      found.push({
        protocol: "layerzero",
        chainKey: probe.chainKey,
        custodyAddress: platform.tokenAddress,
        tokenAddress: probe.wrappedToken,
        note: "адаптер определён по контракту",
      });
    }
  }

  const all = found.length > 0 ? [...custodians, ...found] : custodians;

  const { balances, failuresByChain, attemptsByChain } = await readCustodianBalances(all);

  const supportedChains = [
    ...new Set(token.platforms.filter((p) => p.chainKey).map((p) => getChain(p.chainKey!)?.label ?? p.chainKey!)),
  ];
  const unsupportedPlatforms = [
    ...new Set(token.platforms.filter((p) => !p.chainKey).map((p) => p.platformName)),
  ];

  return renderLiquidityReport({
    symbol: token.symbol,
    name: token.name,
    balances,
    checkedCount: all.length,
    failuresByChain,
    attemptsByChain,
    nativeOftChains: [...nativeOftChains],
    syntheticHyperlaneChains: findSyntheticHyperlaneChains(symbol),
    scope: {
      supportedChains,
      unsupportedPlatforms,
      wormhole: all.filter((c) => c.protocol === "wormhole").length,
      hyperlane: all.filter((c) => c.protocol === "hyperlane").length,
      layerzero: all.filter((c) => c.protocol === "layerzero").length,
    },
  });
}

export function registerLiquidityCommand(bot: Telegraf) {
  bot.command("liquidity", async (ctx: Context) => {
    const text = (ctx.message as any)?.text ?? "";
    const arg = text.trim().split(/\s+/)[1];
    if (!arg) {
      await ctx.reply("Укажите тикер. Пример: <code>/liquidity ARB</code>", { parse_mode: "HTML" });
      return;
    }
    await replyWithLiquidity(ctx, arg);
  });
}

/** Shared by /liquidity and by /info when its argument is a ticker. */
export async function replyWithLiquidity(ctx: Context, symbol: string): Promise<void> {
  await ctx.sendChatAction("typing");
  try {
    await ctx.reply(await buildLiquidityReport(symbol), REPLY_OPTS);
  } catch (err) {
    if (err instanceof CmcNotConfiguredError) {
      await ctx.reply(
        "Поиск по тикеру не настроен: не задан ключ CoinMarketCap.\n\n" +
          "Добавьте переменную <code>CMC_API_KEY</code> в настройки хостинга.",
        { parse_mode: "HTML" }
      );
      return;
    }
    if (err instanceof CmcRequestError) {
      await ctx.reply(`Не удалось получить данные от CoinMarketCap: ${esc(err.message)}`, {
        parse_mode: "HTML",
      });
      return;
    }
    console.error("[liquidity] непредвиденная ошибка:", err);
    const detail = err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err).slice(0, 200);
    await ctx.reply(
      `Не удалось собрать отчёт.\n\n<code>${esc(detail)}</code>\n\nПришлите этот текст, по нему видно причину.`,
      { parse_mode: "HTML" }
    );
  }
}
