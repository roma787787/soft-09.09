import type { Telegraf, Context } from "telegraf";
import { getChain, resolveChain, resolveAnyChain, chainMeta } from "../../config/chains";
import { getSvmChain } from "../../config/svmChains";
import { getCosmosChain } from "../../config/cosmosChains";
import { getOtherChain } from "../../config/otherChains";
import {
  lookupToken,
  TokenSourceNotConfiguredError,
  TokenSourceRequestError,
} from "../../services/coingecko";
import { resolveCustodians, dedupeCustodians, tokenByChainFrom } from "../../bridges";
import { findVaultCustodians } from "../../bridges/vaults";
import { findCcipCustodians } from "../../bridges/ccip";
import { findStargateCustodians } from "../../bridges/stargate";
import { findSvmBalances } from "../../bridges/svm";
import { findCosmosBalances, findNativeModuleBalances } from "../../bridges/cosmos";
import { findOtherBalances } from "../../bridges/others";
import { findPortalNonEvmBalances } from "../../bridges/portalNonEvm";
import { findTonBalances } from "../../bridges/ton";
import type { NonEvmReadResult } from "../../bridges/types";
import { TON_CHAIN } from "../../config/tonChain";
import { getPortalChain } from "../../config/portalChains";
import { BRIDGE_ORDER, type BridgeProtocol } from "../../bridges/types";
import {
  probeLayerZeroToken,
  findLayerZeroRegistryDeployments,
  readAdapterUnderlying,
  symbolLooksRight,
  expandLayerZeroMesh,
  type RegistryDeploymentInfo,
} from "../../bridges/layerzero";
import { findSyntheticHyperlaneChains } from "../../bridges/hyperlane";
import type { Custodian } from "../../bridges/types";
import type { TokenPlatform } from "../../services/coingecko";
import type { Address } from "viem";
import { readChainSupplies, readCustodianBalances, type BalanceRow } from "../../services/balances";
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
  /**
   * Which ones were skipped and why. Two rounds of debugging went into
   * "16 adapters skipped" with no way to see which sixteen or on what
   * grounds; a count alone cannot tell an over-strict rule from a registry
   * full of other projects.
   */
  rejected: Array<{ chainKey: string; address: Address; reason: string }>;
}

/**
 * Turns LayerZero registry entries into custody contracts.
 *
 * Split out of the command so the two decisions it makes are covered by
 * tests rather than only by a live registry: a plain OFT holds nothing and
 * must not be reported as empty custody, and an adapter that locks a
 * contract other than the one CoinGecko lists for this ticker belongs to
 * a different project that happens to share the symbol.
 */
export async function resolveRegistryDeployments(
  deployments: RegistryDeploymentInfo[],
  platforms: TokenPlatform[],
  alreadyConfigured: Set<string>,
  symbol: string,
  readUnderlying: (chainKey: string, address: Address) => Promise<Address | undefined> = readAdapterUnderlying,
  checkSymbol: (chainKey: string, token: Address, symbol: string) => Promise<boolean> = symbolLooksRight
): Promise<RegistryResolution> {
  const custodians: Custodian[] = [];
  const nativeOftChains = new Set<string>();
  const rejected: RegistryResolution["rejected"] = [];
  let mismatchedAdapters = 0;

  const reject = (d: RegistryDeploymentInfo, reason: string) => {
    mismatchedAdapters++;
    rejected.push({ chainKey: d.chainKey, address: d.address, reason });
  };

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
    // listed address would let any similarly named project's adapter in,
    // which is the whole risk of widening the search.
    if (deployment.viaAlias) {
      // An alias candidate must say what it locks; there is no falling back
      // to the listed address for one, since guessing is the only thing
      // that could put another project's balance under this ticker.
      if (!onChain) {
        reject(deployment, "не сказал, что блокирует");
        continue;
      }
      // Then either proof is enough. CoinGecko's address for that chain
      // is the strongest, but a bridged deployment routinely locks its own
      // variant - USDT0 beside USDT - and reaches chains CoinGecko never
      // lists at all. Both are the same asset to anyone asking whether their
      // transfer can be withdrawn, so the locked ERC-20's own symbol proves
      // it too. Demanding the address alone rejected sixteen of USDT's
      // twenty-three real deployments.
      const matchesListed = !!listed && onChain.toLowerCase() === listed.toLowerCase();
      if (!matchesListed && !(await checkSymbol(deployment.chainKey, onChain, symbol))) {
        reject(deployment, `блокирует ${onChain}, тикер не совпал`);
        continue;
      }

      custodians.push({
        protocol: "layerzero",
        chainKey: deployment.chainKey,
        custodyAddress: deployment.address,
        tokenAddress: onChain,
        note: deployment.viaAlias,
      });
      continue;
    }

    const underlying = onChain ?? listed;
    if (!underlying) continue;

    // An exact-ticker deployment locking something else is a different
    // project sharing the symbol, and reading its balance under this ticker
    // would be worse than omitting it.
    if (listed && underlying.toLowerCase() !== listed.toLowerCase()) {
      reject(deployment, `блокирует ${underlying}, а CoinGecko указал ${listed}`);
      continue;
    }

    custodians.push({
      protocol: "layerzero",
      chainKey: deployment.chainKey,
      custodyAddress: deployment.address,
      tokenAddress: underlying,
      note: "реестр",
    });
  }

  return { custodians, nativeOftChains: [...nativeOftChains], mismatchedAdapters, rejected };
}

function countByProtocol(
  custodians: Custodian[],
  extra: Array<{ protocol: BridgeProtocol }> = []
): Partial<Record<BridgeProtocol, number>> {
  const counts: Partial<Record<BridgeProtocol, number>> = {};
  for (const p of BRIDGE_ORDER) {
    const n = custodians.filter((c) => c.protocol === p).length + extra.filter((c) => c.protocol === p).length;
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
    return `Тикер <b>${esc(symbol)}</b> не найден на CoinGecko. Проверьте написание.`;
  }

  const custodians = resolveCustodians(symbol, token.platforms);

  const alreadyConfigured = new Set(
    custodians.filter((c) => c.protocol === "layerzero").map((c) => c.chainKey)
  );

  // LayerZero is resolved before deciding there is nothing to report: a token
  // bridged only by LayerZero has no Wormhole or Hyperlane custodian, and
  // giving up here would skip the very registry that covers it.
  const deployments = await findLayerZeroRegistryDeployments(symbol);
  const registry = await resolveRegistryDeployments(deployments, token.platforms, alreadyConfigured, symbol);

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
        note: probe.version === "v1" ? "V1" : "по контракту",
      });
    }
  }

  // One OFT names its counterparts on every chain it talks to, so a single
  // hit anywhere unfolds into the whole deployment - including chains no
  // registry lists and CoinGecko never mentioned.
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

  // Solana is read on its own terms: the balance there is not at the
  // contract's address, so it comes back already read rather than as a
  // custodian to look up later. Fetched before the "nothing found" decision
  // for the same reason the LayerZero registry is - a token bridged only to
  // Solana would otherwise be reported as not bridged at all.
  const solanaMint = token.otherPlatforms.find((p) => p.chainKey === "solanamainnet")?.tokenAddress;
  const empty = { rows: [], attempts: {}, failures: {} };
  // Near and Aptos have no warp route, no pool and no shared vault - only
  // Wormhole's Token Bridge, which holds everything it ever carried. So the
  // question there is which token to ask it about, and the answer comes from
  // the price API's own listing for those chains.
  const portalTokens = token.otherPlatforms
    .filter((p) => p.chainKey && !!getPortalChain(p.chainKey))
    .map((p) => ({ chainKey: p.chainKey!, tokenAddress: p.tokenAddress }));

  const [svmRead, cosmosRead, nativeRead, otherRead, portalRead, tonRead] = await Promise.all([
    !chainFilter || !!getSvmChain(chainFilter) ? findSvmBalances(symbol, solanaMint) : empty,
    !chainFilter || !!getCosmosChain(chainFilter) ? findCosmosBalances(symbol) : empty,
    !chainFilter || !!getCosmosChain(chainFilter) ? findNativeModuleBalances(symbol) : empty,
    !chainFilter || !!getOtherChain(chainFilter) ? findOtherBalances(symbol) : empty,
    !chainFilter || !!getPortalChain(chainFilter)
      ? findPortalNonEvmBalances(portalTokens)
      : empty,
    !chainFilter || chainFilter === TON_CHAIN.key ? findTonBalances(symbol) : empty,
  ]);

  // Typed as the rows a report renders, not as any one reader's own row:
  // each family names the bridge it read, and they are different bridges.
  const nonEvmReads: Array<NonEvmReadResult<BalanceRow>> = [
    svmRead,
    cosmosRead,
    nativeRead,
    otherRead,
    portalRead,
    tonRead,
  ];
  const nonEvmAll: BalanceRow[] = nonEvmReads.flatMap((r) => r.rows);

  // A chain that could not be reached must be named, not silently absent:
  // Radix's gateways are nine days behind, and a report that just omits the
  // row says "this bridge holds nothing" about a bridge nobody could ask.
  const nonEvmAttempts: Record<string, number> = {};
  const nonEvmFailures: Record<string, number> = {};
  for (const read of nonEvmReads) {
    for (const [chainKey, n] of Object.entries(read.attempts)) {
      nonEvmAttempts[chainKey] = (nonEvmAttempts[chainKey] ?? 0) + n;
    }
    for (const [chainKey, n] of Object.entries(read.failures)) {
      nonEvmFailures[chainKey] = (nonEvmFailures[chainKey] ?? 0) + n;
    }
  }
  const solanaRows = chainFilter ? nonEvmAll.filter((r) => r.chainKey === chainFilter) : nonEvmAll;
  const solanaHasSomething = solanaRows.length > 0 || Object.keys(nonEvmFailures).length > 0;

  const all = dedupeCustodians([...custodians, ...found, ...vaults, ...ccip, ...stargate]);

  if (all.length === 0 && !solanaHasSomething) {
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
  // Solana rows are counted here too: narrowing to Solana finds nothing
  // among the EVM custodians by definition, and saying "nothing here" while
  // holding its balances would be the report contradicting itself.
  if (chainFilter && scoped.length === 0 && solanaRows.length === 0) {
    const label = chainMeta(chainFilter)?.label ?? chainFilter;
    return (
      `<b>${esc(token.name)} (${esc(token.symbol)})</b>\n\n` +
      `В сети ${esc(label)} контрактов-хранилищ по этому токену не найдено.\n\n` +
      `Без указания сети: <code>/info ${esc(token.symbol)}</code>`
    );
  }

  const { balances, failuresByChain, attemptsByChain, notReadableByChain } =
    await readCustodianBalances(scoped);

  // The chains the token lives on that produced no custody contract at all.
  // Until now they produced no row and no mention either, so "we checked and
  // no bridge is there" was indistinguishable from "we did not check" - and
  // telling those two apart is the entire job. Asking the token itself how
  // much of it exists there turns the silence into an answer.
  const withCustody = new Set(scoped.map((c) => c.chainKey));
  const supplyTargets = token.platforms
    .filter(
      (p) =>
        p.chainKey &&
        // A report narrowed to one chain must not start explaining the
        // others: /info USDC base would have listed the supply on every
        // chain it did not ask about.
        (!chainFilter || p.chainKey === chainFilter) &&
        !withCustody.has(p.chainKey) &&
        !nativeOftChains.has(p.chainKey)
    )
    .map((p) => ({ chainKey: p.chainKey!, tokenAddress: p.tokenAddress }));
  const supplyOnly = supplyTargets.length > 0 ? await readChainSupplies(supplyTargets) : [];

  // Solana now counts as a chain the bot checks, so it belongs with the
  // supported ones rather than in the "not checked" footer.
  const solanaLabel = [...new Set(nonEvmAll.map((r) => chainMeta(r.chainKey)?.label ?? r.chainKey))];
  const supportedChains = [
    ...new Set(token.platforms.filter((p) => p.chainKey).map((p) => getChain(p.chainKey!)?.label ?? p.chainKey!)),
  ];
  const unsupportedPlatforms = [
    ...new Set([
      ...token.platforms.filter((p) => !p.chainKey).map((p) => p.platformName),
      ...token.otherPlatforms.filter((p) => !p.chainKey).map((p) => p.platformName),
    ]),
  ];

  return renderLiquidityReport({
    symbol: token.symbol,
    name: token.name,
    balances: [...balances, ...solanaRows],
    checkedCount: scoped.length + solanaRows.length,
    failuresByChain: { ...failuresByChain, ...nonEvmFailures },
    attemptsByChain: { ...attemptsByChain, ...nonEvmAttempts },
    notReadableByChain,
    nativeOftChains: [...nativeOftChains],
    mismatchedAdapters,
    syntheticHyperlaneChains: findSyntheticHyperlaneChains(symbol),
    supplyOnly,
    scope: {
      supportedChains: [...supportedChains, ...solanaLabel],
      unsupportedPlatforms,
      byProtocol: countByProtocol(scoped, solanaRows),
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
    await replyWithLiquidity(ctx, arg, resolveAnyChain(parts[2] ?? "")?.key);
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
    if (err instanceof TokenSourceNotConfiguredError) {
      await ctx.reply(
        "Поиск по тикеру не настроен.\n\n" +
          "CoinGecko отвечает и без ключа, но лимит общий на IP, а хостинг делит адрес " +
          "с чужими ботами. Бесплатный ключ снимает это: coingecko.com → API → Demo, " +
          "затем переменная <code>COINGECKO_API_KEY</code> в настройках хостинга.",
        { parse_mode: "HTML" }
      );
      return;
    }
    if (err instanceof TokenSourceRequestError) {
      await ctx.reply(`Не удалось получить данные от CoinGecko: ${esc(err.message)}`, {
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
