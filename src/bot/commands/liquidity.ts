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
import { resolveCustodians, dedupeCustodians, tokenByChainFrom, withCustodianTokens } from "../../bridges";
import { findVaultCustodians } from "../../bridges/vaults";
import { findCcipCustodians } from "../../bridges/ccip";
import { findStargateCustodians, stargateCoverage } from "../../bridges/stargate";
import { findSvmBalances, findLayerZeroSvmBalances } from "../../bridges/svm";
import { findLayerZeroAptosBalances } from "../../bridges/lzAptos";
import { findCosmosBalances, findNativeModuleBalances } from "../../bridges/cosmos";
import { findOtherBalances } from "../../bridges/others";
import { findPortalNonEvmBalances } from "../../bridges/portalNonEvm";
import { findPortalCosmosBalances } from "../../bridges/portalCosmos";
import { findCcipSvmBalances, SOLANA_KEY } from "../../bridges/ccipSvm";
import { readSuiSupply, readSuiWormholeCustody, suiCoinMetadata } from "../../bridges/sui";
import { SUI_CHAIN } from "../../config/suiChain";
import { portalCosmosChain } from "../../config/portalCosmosChains";
import { findTonBalances } from "../../bridges/ton";
import type { NonEvmReadResult } from "../../bridges/types";
import { TON_CHAIN } from "../../config/tonChain";
import { getPortalChain } from "../../config/portalChains";
import { BRIDGE_ORDER, BRIDGE_SHORT_LABELS, type BridgeProtocol } from "../../bridges/types";
import {
  probeLayerZeroToken,
  findLayerZeroRegistryDeployments,
  readAdapterUnderlying,
  symbolLooksRight,
  expandLayerZeroMesh,
  type RegistryDeploymentInfo,
} from "../../bridges/layerzero";
import { findSyntheticHyperlaneChains } from "../../bridges/hyperlane";
import { lastDiscovery } from "../../services/chainDiscovery";
import type { Custodian } from "../../bridges/types";
import type { TokenInfo, TokenPlatform } from "../../services/coingecko";
import type { Address } from "viem";
import { formatAmount, readChainSupplies, readCustodianBalances, type BalanceRow } from "../../services/balances";
import { plural, renderLiquidityReport, splitForTelegram } from "../render";

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
  /**
   * Every registry entry, sorted into the bucket that swallowed it.
   *
   * `nativeOftChains` is a set of CHAINS, so two minting deployments on one
   * chain collapse into one entry and the deployments cannot be counted back
   * out of it. Two more exits - an entry on a chain the manual config already
   * covers, and an adapter with nothing to lock - left no trace at all. So
   * /lzmesh reported "28 in the registry, 24 accepted, 1 rejected" and three
   * entries had simply vanished between the two numbers, which is the exact
   * shape of every real bug this report has turned up.
   */
  accounting: {
    /** Entries whose deployment mints its supply, so there is no vault. */
    minting: number;
    /** Entries on a chain the manual config already answers for. */
    preconfigured: number;
    /** Adapters that named nothing to lock and had no listed address either. */
    unresolved: number;
  };
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
  let minting = 0;
  let unresolved = 0;

  const reject = (d: RegistryDeploymentInfo, reason: string) => {
    mismatchedAdapters++;
    rejected.push({ chainKey: d.chainKey, address: d.address, reason });
  };

  // Asked all at once. Every deployment is now read whatever the registry
  // called it, and a widely bridged token has thirty of them - one at a time
  // that is thirty round trips stacked end to end.
  const pending = deployments.filter((d) => !alreadyConfigured.has(d.chainKey));
  const underlyings = await Promise.all(pending.map((d) => readUnderlying(d.chainKey, d.address)));

  for (const [i, deployment] of pending.entries()) {
    const listed = platforms.find((p) => p.chainKey === deployment.chainKey)?.tokenAddress;
    const onChain = underlyings[i];

    // The registry's type field is not evidence, it is a label. On Aptos it
    // called three minting deployments adapters; the same field calling an
    // adapter an OFT would hide real collateral, and nothing downstream
    // would ever ask - the contract probe skips chains the registry already
    // named, and the peer walk skips whatever landed here.
    //
    // So the contract decides. An OFT's token() returns itself and readUnderlying
    // answers nothing; an adapter names what it locks. Only when both the
    // label and the contract say "holds nothing" is the chain mint-only.
    //
    // Except when the registry says mint-burn outright. Such an adapter does
    // name a separate ERC-20 - it was granted mint and burn on one - so
    // token() reads it exactly like a locking adapter and the balance comes
    // back zero, which is then reported as a vault standing empty.
    //
    // The label is taken at its word here because it is the cheapest
    // evidence available and the registry states it plainly. Where there is
    // no registry entry to read - every chain the peer walk reaches - the
    // contract is asked approvalRequired() instead, which distinguishes the
    // two on-chain.
    if (deployment.mintsAndBurns || (!onChain && !deployment.locksCollateral)) {
      nativeOftChains.add(deployment.chainKey);
      minting++;
      continue;
    }

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

    const locked = onChain ?? listed;
    if (!locked) {
      unresolved++;
      continue;
    }

    // An exact-ticker deployment locking something else is a different
    // project sharing the symbol, and reading its balance under this ticker
    // would be worse than omitting it.
    if (listed && locked.toLowerCase() !== listed.toLowerCase()) {
      reject(deployment, `блокирует ${locked}, а CoinGecko указал ${listed}`);
      continue;
    }

    custodians.push({
      protocol: "layerzero",
      chainKey: deployment.chainKey,
      custodyAddress: deployment.address,
      tokenAddress: locked,
      // Worth saying when the contract overruled the registry: that row
      // exists only because the label was not believed.
      note: deployment.locksCollateral ? "реестр" : "реестр звал OFT, контракт блокирует",
    });
  }

  return {
    custodians,
    nativeOftChains: [...nativeOftChains],
    mismatchedAdapters,
    rejected,
    accounting: {
      minting,
      preconfigured: deployments.length - pending.length,
      unresolved,
    },
  };
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

/**
 * Why a report can come back without a Stargate row.
 *
 * Stargate's site moves far more tickers than Stargate the liquidity layer
 * has pools for: everything else it routes through the token's own LayerZero
 * contracts. So "I can send this on Stargate" and "Stargate holds some of
 * this" are different statements, and the report kept getting read as broken
 * for telling them apart silently.
 */
/**
 * What to say about Stargate when it has no pool of its own for a ticker.
 *
 * "Checked, nothing found" was read as "Stargate does not carry this token",
 * and for PENGU that reading is wrong in a way that matters: stargate.finance
 * does carry it, through the token's own LayerZero contract - which is the
 * row already in the report, holding two and a half billion of it. The
 * customer saw PENGU on Stargate's site, saw Stargate in the not-found list,
 * and concluded the bot was missing a bridge.
 *
 * So where a LayerZero row exists, it is named outright, with the chain and
 * the amount, and said to be the same money rather than more of it. Pointing
 * at the row is the whole job: the number was never missing, only unlabelled.
 */
export function stargateNote(balances: BalanceRow[] = []): string {
  const assets = stargateCoverage().assets.join(", ");
  const own = `своих пулов у Stargate под этот тикер нет — они есть только под ${assets}.`;

  const viaLayerZero = balances.filter((b) => b.protocol === "layerzero" && b.amount > 0n);
  if (viaLayerZero.length === 0) {
    // Careful not to point at a row that is not there. "They come under the
    // LayerZero line" is help when there is a LayerZero line and a puzzle
    // when there is not - and there is not, on a token nothing found.
    return (
      `${own} Остальные токены его сайт возит контрактом LayerZero самого токена, ` +
      "а такого контракта под этот тикер бот не нашёл — значит, и возить Stargate тут нечем."
    );
  }

  // The biggest row, because that is the one a person is deciding against.
  const biggest = viaLayerZero.reduce((max, b) => (b.amount > max.amount ? b : max));
  const where = chainMeta(biggest.chainKey)?.label ?? biggest.chainKey;
  return (
    `${own} Но токен он возит — контрактом LayerZero самого токена, и это уже в отчёте: ` +
    `строка LayerZero, ${formatAmount(biggest.amount, biggest.decimals)} в сети ${where}. ` +
    "Отдельной ликвидности у Stargate тут не существует: это те же деньги, а не ещё одни."
  );
}

/**
 * The chains the price API listed and this bot can read - both halves of its
 * answer, the EVM addresses and the others.
 *
 * The non-EVM half used to be stood in for by the chains rows were found on,
 * which is a different fact wearing the same sentence. ETH is listed by
 * nobody: its report found a Hyperlane route on Paradex and then said
 * "CoinGecko знает токен в сетях: Paradex", attributing to the price API a
 * claim it never made. A row found through a bridge's own registry is
 * already in the report above; this line is only about who listed what.
 */
export function listedChains(token: Pick<TokenInfo, "platforms" | "otherPlatforms">): string[] {
  return [
    ...new Set([
      ...token.platforms.filter((p) => p.chainKey).map((p) => getChain(p.chainKey!)?.label ?? p.chainKey!),
      ...token.otherPlatforms.filter((p) => p.chainKey).map((p) => chainMeta(p.chainKey!)?.label ?? p.chainKey!),
    ]),
  ];
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

    // Both generations seed the walk. This used to admit V2 only, on the
    // grounds that V1 does not implement peers(eid) - true, but the walk
    // stopped depending on it: it asks a V1 seed trustedRemoteLookup with
    // the eid converted to a V1 chain id. Registry deployments were already
    // seeded regardless of generation, so the restriction only ever silenced
    // the probe path, and a token whose live deployment is V1 and absent
    // from the registry never seeded the walk at all.
    if (platform) {
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
  // Aptos decides this from the module the object carries rather than from
  // the registry's type field, which calls USDe's minting deployment there
  // an adapter.

  // Shared vaults answer for any token at all - one contract per chain holds
  // everything that bridge carries - so they are asked regardless of whether
  // a registry happens to list this ticker.
  // Stargate first, because it names the token it holds on each of its
  // chains and those names widen the search below.
  const stargate = await findStargateCustodians(symbol);

  // Every chain where something has already confirmed this token's address,
  // not only the ones the price API listed. For USDT the price API lists
  // five EVM chains, so Across was being asked on two of the twenty-seven it
  // is deployed on - and the USDT it holds on Arbitrum, Base, Optimism and
  // Polygon never reached the report.
  const listedTokens = tokenByChainFrom(token.platforms);
  const fromBridges = new Map<string, Address>();
  for (const custodian of [...custodians, ...found, ...stargate]) {
    if (!custodian.chainKey || !custodian.tokenAddress) continue;
    if (listedTokens.has(custodian.chainKey) || fromBridges.has(custodian.chainKey)) continue;
    fromBridges.set(custodian.chainKey, custodian.tokenAddress);
  }

  // Each one asked what it is before it widens anything.
  //
  // A bridge's own row can carry an unvouched address and still be honest:
  // it says this bridge holds so much of what it locks, and it names the
  // bridge. A shared vault cannot. It holds every token its bridge carries,
  // so handed the wrong address it answers with a real balance of the wrong
  // token, printed under the ticker somebody asked about, with no bridge in
  // the sentence to give the game away. On exactly the chains this widening
  // is for - the ones the price API never listed - nothing else checks.
  //
  // A contract that will not answer symbol() is still accepted, the same
  // decision the peer walk makes and for the same reason: the registry entry
  // is already strong evidence, and refusing here would hide real liquidity,
  // which is the thing this whole change exists to stop.
  const vouched = await Promise.all(
    [...fromBridges].map(async ([chainKey, tokenAddress]) =>
      (await symbolLooksRight(chainKey, tokenAddress, symbol)) ? { chainKey, tokenAddress } : undefined
    )
  );
  const tokenByChain = withCustodianTokens(
    listedTokens,
    vouched.filter((v): v is { chainKey: string; tokenAddress: Address } => v !== undefined)
  );

  const [vaults, ccip] = await Promise.all([
    findVaultCustodians(tokenByChain),
    // CCIP keeps a pool per token, but the pool is found by asking the
    // contracts rather than by looking the ticker up in a list, so it needs
    // no registry of its own.
    findCcipCustodians(tokenByChain),
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

  // The same map the Token Bridge read uses: on Aptos the question is which
  // token to ask about, and the price API is what answers it.
  const portalTokenByChain = new Map(portalTokens.map((p) => [p.chainKey, p.tokenAddress]));

  // Wormhole on Cosmos asks the same question Near and Aptos do - which of
  // that chain's own assets the Token Bridge is holding - and the price
  // API's listing for the chain is again what names the asset.
  const portalCosmosTokens = token.otherPlatforms
    .filter((p) => p.chainKey && !!portalCosmosChain(p.chainKey))
    .map((p) => ({ chainKey: p.chainKey!, tokenAddress: p.tokenAddress }));

  const [
    svmRead,
    lzSvmRead,
    lzAptosRead,
    cosmosRead,
    nativeRead,
    otherRead,
    portalRead,
    portalCosmosRead,
    ccipSvmRead,
    tonRead,
  ] = await Promise.all([
    !chainFilter || !!getSvmChain(chainFilter) ? findSvmBalances(symbol, solanaMint) : empty,
    // The registry names both the mint and the escrow account, so this needs
    // nothing from CoinGecko - and works on an SVM chain it never listed.
    !chainFilter || !!getSvmChain(chainFilter) ? findLayerZeroSvmBalances(symbol) : empty,
    // Four adapters on Aptos lock collateral, and until now the only reader
    // that chain had was Wormhole's.
    !chainFilter || !!getPortalChain(chainFilter)
      ? findLayerZeroAptosBalances(symbol, portalTokenByChain)
      : { ...empty, mints: false },
    !chainFilter || !!getCosmosChain(chainFilter) ? findCosmosBalances(symbol) : empty,
    !chainFilter || !!getCosmosChain(chainFilter) ? findNativeModuleBalances(symbol) : empty,
    !chainFilter || !!getOtherChain(chainFilter) ? findOtherBalances(symbol) : empty,
    !chainFilter || !!getPortalChain(chainFilter)
      ? findPortalNonEvmBalances(portalTokens)
      : empty,
    !chainFilter || !!portalCosmosChain(chainFilter)
      ? findPortalCosmosBalances(portalCosmosTokens)
      : empty,
    // CCIP on Solana. The pool is a program, so there is no contract to walk
    // to the way the EVM side does - the custody account is derived from the
    // program and the mint, and the chain confirms which derivation is right.
    !chainFilter || chainFilter === SOLANA_KEY
      ? findCcipSvmBalances(solanaMint)
      : { ...empty, mints: false },
    !chainFilter || chainFilter === TON_CHAIN.key
      ? findTonBalances(symbol, token.otherPlatforms.find((p) => p.chainKey === TON_CHAIN.key)?.tokenAddress)
      : empty,
  ]);

  // Typed as the rows a report renders, not as any one reader's own row:
  // each family names the bridge it read, and they are different bridges.
  const nonEvmReads: Array<NonEvmReadResult<BalanceRow>> = [
    svmRead,
    lzSvmRead,
    lzAptosRead,
    cosmosRead,
    nativeRead,
    otherRead,
    portalRead,
    portalCosmosRead,
    ccipSvmRead,
    tonRead,
  ];
  const nonEvmAll: BalanceRow[] = nonEvmReads.flatMap((r) => r.rows);

  // A chain that could not be reached must be named, not silently absent:
  // Radix's gateways are nine days behind, and a report that just omits the
  // row says "this bridge holds nothing" about a bridge nobody could ask.
  const nonEvmAttempts: Record<string, number> = {};
  const nonEvmFailures: Record<string, number> = {};
  const nonEvmReasons: Record<string, string> = {};
  for (const read of nonEvmReads) {
    for (const [chainKey, reason] of Object.entries(read.reasons ?? {})) {
      nonEvmReasons[chainKey] = reason;
    }
    for (const [chainKey, n] of Object.entries(read.attempts)) {
      nonEvmAttempts[chainKey] = (nonEvmAttempts[chainKey] ?? 0) + n;
    }
    for (const [chainKey, n] of Object.entries(read.failures)) {
      nonEvmFailures[chainKey] = (nonEvmFailures[chainKey] ?? 0) + n;
    }
  }
  if (lzAptosRead.mints) nativeOftChains.add("aptos");

  const solanaRows = chainFilter ? nonEvmAll.filter((r) => r.chainKey === chainFilter) : nonEvmAll;

  /** Chains this report is allowed to talk about: all of them, or the one asked for. */
  const inScope = (chains: Iterable<string>) =>
    chainFilter ? [...chains].filter((c) => c === chainFilter) : [...chains];
  const solanaHasSomething = solanaRows.length > 0 || Object.keys(nonEvmFailures).length > 0;

  const all = dedupeCustodians([...custodians, ...found, ...vaults, ...ccip, ...stargate]);

  // Read before the two short replies below, not after them. Both return
  // early on "nothing found", and Sui's custody is not among the custodians
  // they count - so a token whose only vault is on Sui was answered "no
  // custody contracts found" while the balance sat there unread, and
  // /info SUI sui said the same about the one chain it was asked about.
  //
  // Wormhole's custody is a balance, and a balance outranks a supply. What
  // the registry types NativeAsset<C> is collateral locked on Sui;
  // WrappedAsset<C> is a coin minted here against collateral elsewhere, and
  // is deliberately not counted as custody.
  const suiPlatform = token.otherPlatforms.find((p) => p.chainKey === SUI_CHAIN.key);
  const suiInScope = !!suiPlatform && (!chainFilter || chainFilter === SUI_CHAIN.key);
  const suiRows: BalanceRow[] = [];
  if (suiInScope) {
    const custody = await readSuiWormholeCustody(suiPlatform!.tokenAddress);
    const meta = custody ? await suiCoinMetadata(suiPlatform!.tokenAddress) : undefined;
    if (custody && meta?.decimals !== undefined) {
      suiRows.push({
        protocol: "wormhole",
        chainKey: SUI_CHAIN.key,
        custodyAddress: custody.objectId,
        tokenAddress: custody.coinType,
        note: "реестр токенов",
        amount: custody.amount,
        decimals: meta.decimals,
      });
    }
  }

  // "Nothing was found" is a claim, and a truncated walk cannot support it.
  // Both short replies below end the report before the scope section that
  // would have said so, so they carry the caveat themselves.
  // Counted the same way the rest of the report is narrowed, so a reply
  // about one chain never quotes a number covering all of them.
  const meshCaveat = (unasked: string[]): string =>
    unasked.length === 0
      ? ""
      : `\n\nНо обход пиров LayerZero не успел спросить ${unasked.length} ${plural(unasked.length, "сеть", "сети", "сетей")} — узел зацепки отвечал слишком медленно. Повторите команду, ответ может оказаться другим.`;

  if (all.length === 0 && !solanaHasSomething && suiRows.length === 0) {
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
        `Проверены все мосты, которые бот знает: ${BRIDGE_ORDER.map((p) => BRIDGE_SHORT_LABELS[p]).join(", ")} — ` +
          "ни один из них не держит контракта под этот тикер.",
        // Labelled like every other bridge's note. Unlabelled it started a
        // line with a lowercase "своих пулов", reading as a sentence the
        // report had lost the beginning of.
        `Stargate: ${stargateNote()}`
      );
    }
    return lines.join("\n") + meshCaveat(inScope(mesh.unasked));
  }

  // Narrowing to one chain is not a display option, it is the whole
  // question when you are about to bridge somewhere specific - and it is
  // also what keeps a widely bridged token from overflowing the message and
  // dropping the very chain that was being asked about.
  const scoped = chainFilter ? all.filter((c) => c.chainKey === chainFilter) : all;
  // Solana rows are counted here too: narrowing to Solana finds nothing
  // among the EVM custodians by definition, and saying "nothing here" while
  // holding its balances would be the report contradicting itself.
  if (chainFilter && scoped.length === 0 && solanaRows.length === 0 && suiRows.length === 0) {
    const label = chainMeta(chainFilter)?.label ?? chainFilter;
    return (
      `<b>${esc(token.name)} (${esc(token.symbol)})</b>\n\n` +
      `В сети ${esc(label)} контрактов-хранилищ по этому токену не найдено.` +
      // On Sui there is no such thing to find yet, and saying "not found"
      // without that reads as a checked, empty chain. This reply returns
      // before the supply is ever read, so it carries the caveat itself.
      (chainFilter === SUI_CHAIN.key
        ? " Из мостов на Sui проверен только Wormhole — этой монеты в его реестре нет; остальные там устроены иначе и пока не читаются."
        : "") +
      meshCaveat(inScope(mesh.unasked)) +
      `\n\nБез указания сети: <code>/info ${esc(token.symbol)}</code>`
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

  // Sui asked separately, because its deployment arrives as a Move coin type
  // rather than an address and so lives in otherPlatforms, which the loop
  // above never looks at. No bridge on Sui is readable yet - the Wormhole
  // custody sits in a dynamic field of the bridge's own state object, not at
  // an address - so what can be said is how much of the coin exists there.
  // For a token issued on Sui, which USDC is, that IS the answer: no
  // collateral is locked behind it anywhere, and the supply line says so.
  // Sui's supply answers the other question - how much of the coin is on Sui
  // at all - and for one issued there, which USDC is, that is the whole
  // answer: no bridge holds collateral behind it anywhere.
  if (suiInScope && suiRows.length === 0 && !withCustody.has(SUI_CHAIN.key)) {
    const read = await readSuiSupply(suiPlatform!.tokenAddress, symbol);
    if (read) supplyOnly.push(read);
  }

  const supportedChains = listedChains(token);
  const unsupportedPlatforms = [
    ...new Set([
      ...token.platforms.filter((p) => !p.chainKey).map((p) => p.platformName),
      ...token.otherPlatforms.filter((p) => !p.chainKey).map((p) => p.platformName),
    ]),
  ];

  return renderLiquidityReport({
    symbol: token.symbol,
    name: token.name,
    balances: [...balances, ...solanaRows, ...suiRows],
    checkedCount: scoped.length + solanaRows.length + suiRows.length,
    failuresByChain: { ...failuresByChain, ...nonEvmFailures },
    attemptsByChain: { ...attemptsByChain, ...nonEvmAttempts },
    notReadableByChain,
    failureReasons: nonEvmReasons,
    // Every list of chains is narrowed the way the balances already are.
    //
    // A report asked about one network is about that network. Left whole,
    // these said things about the others - and worse than merely off-topic:
    // the mint-only list is filtered against the chains that have a LayerZero
    // row, and those come from the balances, which the filter has already
    // cut down. So /info USDT ton called Arbitrum mint-only while the full
    // report showed six million USDT in an adapter there. Two reports from
    // one bot, contradicting each other, and the narrow one wrong.
    nativeOftChains: inScope(nativeOftChains),
    mismatchedAdapters,
    syntheticHyperlaneChains: inScope(findSyntheticHyperlaneChains(symbol)),
    // A CCIP pool on Solana that turned out to be burn-mint. The account is
    // real and holds nothing by design, so it is said as "mints" rather than
    // left out - which is how it read before, indistinguishable from Solana
    // never having been checked.
    mintsOnly:
      ccipSvmRead.mints && (!chainFilter || chainFilter === SOLANA_KEY)
        ? [{ chainKey: SOLANA_KEY, protocol: "ccip" as const }]
        : [],
    supplyOnly,
    scope: {
      supportedChains,
      singleChain: chainFilter ? chainMeta(chainFilter)?.label ?? chainFilter : undefined,
      unsupportedPlatforms,
      // Said out loud, because the alternative reads as a failure. A chain's
      // own coin has no contract address anywhere, and every lookup here
      // starts from one.
      noTokenAddresses: token.platforms.length === 0 && token.otherPlatforms.length === 0,
      byProtocol: countByProtocol(scoped, [...solanaRows, ...suiRows]),
      // Every bridge above is asked on every report, so the ones that
      // contributed nothing were asked too, and saying so is the difference
      // between "this bridge holds none of it" and "this bot ignores it".
      checkedProtocols: BRIDGE_ORDER,
      // A chain the next report will cover must not be called unchecked in
      // this one; until the scan lands, the list is not something to make
      // claims from.
      chainListIncomplete: !lastDiscovery(),
      // Sui is in the table now, so it no longer appears as a network the
      // bot does not cover - and that is exactly why this has to be said.
      // Its supply is read; its bridge vaults are not, and without this line
      // every "no bridge holds any of it here" sentence would be covering
      // for a check that never ran.
      bridgesUnread: suiInScope ? [SUI_CHAIN.key] : [],
      // The walk asks the seed's node once per destination chain, so a slow
      // node can leave part of the list unasked. Reported rather than
      // silently dropped: LayerZero absent from a chain and LayerZero never
      // asked about it read identically otherwise.
      meshUnasked: inScope(mesh.unasked).length,
      notFoundNotes: { stargate: stargateNote([...balances, ...solanaRows, ...suiRows]) },
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
    // One report, several messages. Telegram limits a message, not a reply,
    // and paying that limit out of the report's content is what made a
    // fully checked token look half-checked.
    for (const part of splitForTelegram(await buildLiquidityReport(symbol, chainKey))) {
      await ctx.reply(part, REPLY_OPTS);
    }
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
