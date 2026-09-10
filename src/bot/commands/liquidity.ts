import type { Telegraf, Context } from "telegraf";
import { getChain, resolveChain } from "../../config/chains";
import { lookupToken, CmcNotConfiguredError, CmcRequestError } from "../../services/cmc";
import { resolveCustodians, dedupeCustodians, tokenByChainFrom } from "../../bridges";
import { findVaultCustodians } from "../../bridges/vaults";
import { findCcipCustodians } from "../../bridges/ccip";
import { findStargateCustodians } from "../../bridges/stargate";
import { BRIDGE_ORDER, type BridgeProtocol } from "../../bridges/types";
import {
  probeLayerZeroToken,
  findLayerZeroRegistryDeployments,
  readAdapterUnderlying,
  expandLayerZeroMesh,
  type RegistryDeploymentInfo,
} from "../../bridges/layerzero";
import { findSyntheticHyperlaneChains } from "../../bridges/hyperlane";
import type { Custodian } from "../../bridges/types";
import type { TokenPlatform } from "../../services/cmc";
import type { Address } from "viem";
import { readCustodianBalances } from "../../services/balances";
import { renderLiquidityReport } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const REPLY_OPTS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

export interface RegistryResolution {
  custodians: Custodian[];
  /** Chains where the OFT mints its own supply, so no contract holds anything. */
  nativeOftChains: string[];
  /** Adapters skipped because they lock a different project's token. */
  mismatchedAdapters: number;
}

/**
 * Turns LayerZero registry entries into custody contracts.
 *
 * Split out of the command so the two decisions it makes are covered by
 * tests rather than only by a live registry: a plain OFT holds nothing and
 * must not be reported as empty custody, and an adapter that locks a
 * contract other than the one CoinMarketCap lists for this ticker belongs to
 * a different project that happens to share the symbol.
 */
export async function resolveRegistryDeployments(
  deployments: RegistryDeploymentInfo[],
  platforms: TokenPlatform[],
  alreadyConfigured: Set<string>,
  readUnderlying: (chainKey: string, address: Address) => Promise<Address | undefined> = readAdapterUnderlying
): Promise<RegistryResolution> {
  const custodians: Custodian[] = [];
  const nativeOftChains = new Set<string>();
  let mismatchedAdapters = 0;

  for (const deployment of deployments) {
    if (alreadyConfigured.has(deployment.chainKey)) continue;
    if (!deployment.locksCollateral) {
      nativeOftChains.add(deployment.chainKey);
      continue;
    }

    const listed = platforms.find((p) => p.chainKey === deployment.chainKey)?.tokenAddress;
    const onChain = await readUnderlying(deployment.chainKey, deployment.address);

    // A deployment found under a neighbouring ticker has to prove itself:
    // it is only this token if the contract says so. Falling back to the
    // listed address here would let any similarly named project's adapter
    // in, which is the whole risk of widening the search.
    if (deployment.viaAlias) {
      if (!onChain || !listed || onChain.toLowerCase() !== listed.toLowerCase()) {
        mismatchedAdapters++;
        continue;
      }
    }

    const underlying = onChain ?? listed;
    if (!underlying) continue;

    if (listed && underlying.toLowerCase() !== listed.toLowerCase()) {
      mismatchedAdapters++;
      continue;
    }

    custodians.push({
      protocol: "layerzero",
      chainKey: deployment.chainKey,
      custodyAddress: deployment.address,
      tokenAddress: underlying,
      note: deployment.viaAlias
        ? `из реестра LayerZero, тикер ${deployment.viaAlias} (${deployment.rawType})`
        : `из реестра LayerZero (${deployment.rawType})`,
    });
  }

  return { custodians, nativeOftChains: [...nativeOftChains], mismatchedAdapters };
}

function countByProtocol(custodians: Custodian[]): Partial<Record<BridgeProtocol, number>> {
  const counts: Partial<Record<BridgeProtocol, number>> = {};
  for (const p of BRIDGE_ORDER) {
    const n = custodians.filter((c) => c.protocol === p).length;
    if (n > 0) counts[p] = n;
  }
  return counts;
}

export async function buildLiquidityReport(rawSymbol: string, chainFilter?: string): Promise<string> {
  // Trimmed to a plausible ticker length: the "not found" reply quotes what
  // was asked for, and a 4000-character argument would push that reply past
  // Telegram's own limit, turning a clear answer into a send failure.
  const symbol = rawSymbol.trim().replace(/^\$/, "").slice(0, 32).toUpperCase();

  const token = await lookupToken(symbol);
  if (!token) {
    return `Тикер <b>${esc(symbol)}</b> не найден на CoinMarketCap. Проверьте написание.`;
  }

  const custodians = resolveCustodians(symbol, token.platforms);

  const alreadyConfigured = new Set(
    custodians.filter((c) => c.protocol === "layerzero").map((c) => c.chainKey)
  );

  // LayerZero is resolved before deciding there is nothing to report: a token
  // bridged only by LayerZero has no Wormhole or Hyperlane custodian, and
  // giving up here would skip the very registry that covers it.
  const deployments = await findLayerZeroRegistryDeployments(symbol);
  const registry = await resolveRegistryDeployments(deployments, token.platforms, alreadyConfigured);

  const nativeOftChains = new Set<string>(registry.nativeOftChains);
  const found: Custodian[] = [...registry.custodians];
  const mismatchedAdapters = registry.mismatchedAdapters;

  // Chains the registry did not cover: ask the token contracts themselves.
  const uncovered = token.platforms.filter(
    (p) => p.chainKey && !deployments.some((d) => d.chainKey === p.chainKey) && !alreadyConfigured.has(p.chainKey)
  );
  const probes = await Promise.all(uncovered.map((p) => probeLayerZeroToken(p.chainKey!, p.tokenAddress)));

  // Any OFT we can find is a way into the rest of the deployment, whether it
  // holds collateral or not, so plain OFTs are kept as seeds too.
  const seeds: Array<{ chainKey: string; oapp: Address }> = [
    ...deployments.map((d) => ({ chainKey: d.chainKey, oapp: d.address })),
    ...custodians
      .filter((c) => c.protocol === "layerzero")
      .map((c) => ({ chainKey: c.chainKey, oapp: c.custodyAddress })),
  ];

  for (const probe of probes) {
    if (!probe) continue;
    const platform = token.platforms.find((p) => p.chainKey === probe.chainKey);

    // Only V2 contracts are useful as seeds: the peer walk asks peers(eid),
    // which V1 does not implement. A V1 hit still contributes its own row.
    if (platform && probe.version === "v2") {
      seeds.push({ chainKey: probe.chainKey, oapp: platform.tokenAddress });
    }

    if (probe.kind === "native") {
      nativeOftChains.add(probe.chainKey);
      continue;
    }
    if (probe.wrappedToken && platform) {
      found.push({
        protocol: "layerzero",
        chainKey: probe.chainKey,
        custodyAddress: platform.tokenAddress,
        tokenAddress: probe.wrappedToken,
        note: probe.version === "v1" ? "адаптер LayerZero V1" : "адаптер определён по контракту",
      });
    }
  }

  // One OFT names its counterparts on every chain it talks to, so a single
  // hit anywhere unfolds into the whole deployment - including chains no
  // registry lists and CoinMarketCap never mentioned.
  const covered = new Set<string>([
    ...found.map((c) => c.chainKey),
    ...nativeOftChains,
    ...alreadyConfigured,
  ]);
  const mesh = await expandLayerZeroMesh(seeds, symbol, covered);
  found.push(...mesh.custodians);
  for (const chainKey of mesh.nativeChains) nativeOftChains.add(chainKey);

  // Shared vaults answer for any token at all - one contract per chain holds
  // everything that bridge carries - so they are asked regardless of whether
  // a registry happens to list this ticker.
  const tokenByChain = tokenByChainFrom(token.platforms);
  const [vaults, ccip, stargate] = await Promise.all([
    findVaultCustodians(tokenByChain),
    // CCIP keeps a pool per token, but the pool is found by asking the
    // contracts rather than by looking the ticker up in a list, so it needs
    // no registry of its own.
    findCcipCustodians(tokenByChain),
    // Stargate is LayerZero's own liquidity layer and holds the largest
    // balances here, but no registry maps a ticker to its pools.
    findStargateCustodians(symbol),
  ]);

  const all = dedupeCustodians([...custodians, ...found, ...vaults, ...ccip, ...stargate]);

  if (all.length === 0) {
    const lines = [`<b>${esc(token.name)} (${esc(token.symbol)})</b>`, "", "Контрактов-хранилищ по этому токену не найдено."];
    if (nativeOftChains.size > 0) {
      lines.push(
        "",
        `Это омничейн-токен LayerZero (OFT) в сетях: ${[...nativeOftChains].map((c) => getChain(c)?.label ?? c).join(", ")}.`,
        "У такого токена хранилища нет: он сжигается в одной сети и чеканится в другой."
      );
    } else {
      lines.push(
        "",
        "Адреса берутся из реестров Wormhole, Hyperlane и LayerZero — ни в одном из них этот тикер не встречается."
      );
    }
    return lines.join("\n");
  }

  // Narrowing to one chain is not a display option, it is the whole
  // question when you are about to bridge somewhere specific - and it is
  // also what keeps a widely bridged token from overflowing the message and
  // dropping the very chain that was being asked about.
  const scoped = chainFilter ? all.filter((c) => c.chainKey === chainFilter) : all;
  if (chainFilter && scoped.length === 0) {
    const label = getChain(chainFilter)?.label ?? chainFilter;
    return (
      `<b>${esc(token.name)} (${esc(token.symbol)})</b>\n\n` +
      `В сети ${esc(label)} контрактов-хранилищ по этому токену не найдено.\n\n` +
      `Без указания сети: <code>/info ${esc(token.symbol)}</code>`
    );
  }

  const { balances, failuresByChain, attemptsByChain, notReadableByChain } =
    await readCustodianBalances(scoped);

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
    checkedCount: scoped.length,
    failuresByChain,
    attemptsByChain,
    notReadableByChain,
    nativeOftChains: [...nativeOftChains],
    mismatchedAdapters,
    syntheticHyperlaneChains: findSyntheticHyperlaneChains(symbol),
    scope: {
      supportedChains,
      unsupportedPlatforms,
      byProtocol: countByProtocol(scoped),
    },
  });
}

export function registerLiquidityCommand(bot: Telegraf) {
  bot.command("liquidity", async (ctx: Context) => {
    const parts = ((ctx.message as any)?.text ?? "").trim().split(/\s+/);
    const arg = parts[1];
    if (!arg) {
      await ctx.reply("Укажите тикер. Пример: <code>/liquidity ARB</code>", { parse_mode: "HTML" });
      return;
    }
    await replyWithLiquidity(ctx, arg, resolveChain(parts[2] ?? "")?.key);
  });
}

/** Shared by /liquidity and by /info when its argument is a ticker. */
export async function replyWithLiquidity(
  ctx: Context,
  symbol: string,
  chainKey?: string
): Promise<void> {
  await ctx.sendChatAction("typing");
  try {
    await ctx.reply(await buildLiquidityReport(symbol, chainKey), REPLY_OPTS);
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
