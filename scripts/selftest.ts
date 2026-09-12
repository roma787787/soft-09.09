/**
 * Offline self-test: exercises the pure logic that would otherwise only be
 * observable against a live RPC and a live Telegram bot. No network needed.
 *
 * Run with: npm run selftest
 */
import "./offline-env";
import { encodeEventTopics, parseAbi, type Log } from "viem";
import { computePollRange } from "../src/services/tracker";
import { parseAddressChainArgs } from "../src/bot/parse";
import { tryDecodeEvent } from "../src/services/eventCatalog";
import { formatInfoCard } from "../src/bot/format";
import type { DetectionResult } from "../src/protocols/types";
import { bytes32ToAddress, isEvmAddressBytes32 } from "../src/protocols/util";
import {
  parseAssetPlatforms,
  parseCoinResponse,
  explainBody,
  parseKeyResponse,
  pickCoin,
  resolveEvmPlatform,
  resolveNonEvmPlatform,
  type AssetPlatform,
} from "../src/services/coingecko";
import { mapWithConcurrency } from "../src/services/concurrency";
import { scanAccounting, scanShortfall } from "../src/services/chainScan";
import { isFragile, isUnreachable, orderEndpoints } from "../src/services/rpcHealth";
import { attemptsFor, concurrencyFor } from "../src/services/balances";
import { isFresh } from "../src/services/idMaps";
import { EXTRA_RPC_URLS_BY_CHAIN_ID } from "../src/config/rpcs.generated";
import { PORTAL_CHAINS, portalCustodyAddress } from "../src/config/portalChains";
import { TON_CHAIN, toTonAddress } from "../src/config/tonChain";
import {
  entriesForSymbol,
  extractNonEvmDeployments,
  tallyDeploymentsByChain,
  typeLocksCollateral,
  typeMintsAndBurns,
} from "../src/bridges/layerzero";
import { classifyChain, gapsFrom } from "../src/bot/commands/lzgaps";
import { reasonClass } from "../src/bot/commands/chains";
import {
  baseTicker,
  describeBody,
  parseJettonMaster,
  parseJettonWallets,
  symbolsAgree,
} from "../src/bridges/ton";
import { aptosCalls, shapeOfResources } from "../src/bridges/portalNonEvm";
import { parseCw20, parseDenomDecimals } from "../src/bridges/portalCosmos";
import { ccipPoolCandidates, holdsCollateral } from "../src/bridges/ccipSvm";
import { forgetLearnedEndpoints, learnedEndpoints, learnedSummary, learnEndpoints } from "../src/services/extraEndpoints";
import { CCIP_EVM_DEPLOYMENTS, CCIP_SOLANA } from "../src/protocols/addresses/ccip.generated";
import { CCIP_ROUTER_BY_CHAIN } from "../src/protocols/addresses/transporter";
import { parseSelectors } from "../scripts/sync-ccip";
import {
  PORTAL_COSMOS_CHAINS,
  portalCosmosChain,
  portalCosmosUnreachable,
} from "../src/config/portalCosmosChains";
import {
  describeProbeError,
  factsFor,
  factsFromRegistryEntry,
  freeKeyFor,
  keyForSlug,
  qualifiedLabel,
  reasonForChain,
  refusalFromRegistryEntry,
  registryRefusal,
  mergeCandidates,
  mergeFacts,
  defFromDiscovered,
  type DiscoveryReport,
} from "../src/services/chainDiscovery";
import { describeError, groupByReason, mostActionable, splitFailures } from "../src/bot/commands/diag";
import { deploymentsOnChain } from "../src/bot/commands/lzprobe";
import { formatAmount } from "../src/services/balances";
import {
  findHyperlaneCustodians,
  hyperlaneRouteCount,
  hyperlaneSkippedRoutes,
  isProductionRoute,
  loadHyperlaneRegistry,
} from "../src/bridges/hyperlane";
import { svmEscrows } from "../src/bridges/svm";
import { resolveCustodians } from "../src/bridges";
import {
  chainMeta,
  getChain,
  getChainByChainId,
  registerChain,
  resolveChain,
  resolveAnyChain,
  CHAINS,
} from "../src/config/chains";
import { capToTelegramLimit, renderLiquidityReport, splitForTelegram } from "../src/bot/render";
import { isSuiCoinType, normaliseSuiCoinType, sameSuiCoinType } from "../src/config/suiChain";
import { parseSupply, parseBalance, parseCoinMetadata, suiSymbolAgrees, parseDynamicFields, suiTokenBridge, parseObjectShape, suiIdsIn, assetTypeParam, parseFieldPage, parseCustodyAmount } from "../src/bridges/sui";
import { isNodeLevelError } from "../src/services/suiClient";
import { helpText } from "../src/bot/commands/help";
import { formatInfoCard } from "../src/bot/format";
import { SVM_CHAINS } from "../src/config/svmChains";
import { OTHER_CHAINS } from "../src/config/otherChains";
import { preferredRouteId } from "../src/bridges/hyperlane";
import { extractDeployments, aliasKeysFor, classifyOft, type RegistryDeploymentInfo } from "../src/bridges/layerzero";
import { dedupeCustodians, protocolsReadableOn, tokenByChainFrom, withCustodianTokens } from "../src/bridges";
import {
  REGISTRY_CHAIN_IDS,
  candidatesFrom,
  extractEids,
  lastMetadataChainCount,
  lzEidsNow,
  explainMissing,
  normaliseLzKey,
} from "../src/bridges/lzMetadata";
import { listedChains, resolveRegistryDeployments, stargateNote } from "../src/bot/commands/liquidity";
import type { Custodian } from "../src/bridges/types";
import type { Address } from "viem";
import { validateAddress } from "../src/protocols/addresses/validate";
import { endpointsWithOverride, rpcUrlsFor } from "../src/config/env";
import { SVM_CHAINS } from "../src/config/svmChains";
import { COSMOS_CHAINS } from "../src/config/cosmosChains";
import { findCosmosRoutes, findNativeModuleRoutes } from "../src/bridges/cosmos";
import { routeHoldsCollateral } from "../src/bridges/hyperlane";
import { OTHER_CHAINS } from "../src/config/otherChains";
import { findOtherRoutes, decimalToBaseUnits } from "../src/bridges/others";
import {
  findSolanaHyperlaneRoutes,
  hyperlaneEscrowCandidates,
  wormholeCustodyCandidates,
  solanaTokenBridge,
} from "../src/bridges/svm";
import { PORTAL_TOKEN_BRIDGE_BY_CHAIN } from "../src/protocols/addresses/portal";
import { vaultAddressesByChain } from "../src/bridges/vaults";
import { stargateCoverage } from "../src/bridges/stargate";
import {
  STARGATE_POOLS_BY_SYMBOL,
  STARGATE_NATIVE_POOLS_BY_CHAIN_ID,
} from "../src/protocols/addresses/stargate.generated";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`ok    ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// Telegram counts a message "after entities parsing", so tags and entities
// do not count toward the 4096 limit - only what a person sees. Measuring
// the raw HTML instead threw away reports that fitted with room to spare,
// so the tests must measure it the same way the renderer does.
function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#\d+);/g, "\u0001").length;
}

// --- chain configuration -----------------------------------------------------
// With forty-odd chains this table is no longer something you can eyeball. A
// duplicated key or a shared env var would not throw; it would quietly make
// one chain read another chain's node, and every balance from it would be
// wrong rather than missing.

const chainKeys = CHAINS.map((c) => c.key);
check("chain keys are unique", new Set(chainKeys).size === chainKeys.length);

const envVars = CHAINS.map((c) => c.rpcEnvVar);
check("each chain has its own RPC variable", new Set(envVars).size === envVars.length);

const chainIds = CHAINS.map((c) => c.viemChain.id);
check("no two chains share a chain id", new Set(chainIds).size === chainIds.length);

check("every chain has somewhere to connect", CHAINS.every((c) => c.defaultRpcUrls.length > 0));
// viem carries one endpoint per chain, and at a hundred and fifty chains a
// single refusal took the whole chain out of the report. Most now have
// alternates behind that one.
const withFallbacks = CHAINS.filter((c) => rpcUrlsFor(c.key).length > 1).length;
check("most chains have more than one endpoint to try", withFallbacks > CHAINS.length / 2, `${withFallbacks}/${CHAINS.length}`);
check(
  "no chain lost the endpoint viem gave it",
  CHAINS.every((c) => rpcUrlsFor(c.key).includes(c.defaultRpcUrls[0]))
);
check(
  "no fallback needs an API key it does not have",
  Object.values(EXTRA_RPC_URLS_BY_CHAIN_ID).every((urls) => urls.every((u) => !/\$\{|API_KEY/i.test(u)))
);
// A chain may ask for fewer parallel reads, but never for none: a limit of
// zero would loop forever without reading anything.
check(
  "a chain's own read limit is at least one",
  CHAINS.every((c) => c.maxConcurrentReads === undefined || c.maxConcurrentReads >= 1)
);
check("Tron asks for the smallest limit, having been throttled at four", getChain("tron")?.maxConcurrentReads === 1);
check(
  "every chain builds a real explorer link",
  CHAINS.every((c) => /^https:\/\/.+\/address\/0x1$/.test(c.explorerAddressUrl("0x1")))
);
// An alias that resolves to a different chain than its own is worse than no
// alias: the user asks for one network and reads another one's balances.
check(
  "every alias resolves to its own chain",
  CHAINS.every((c) => c.aliases.every((a) => resolveChain(a)?.key === c.key)),
  CHAINS.flatMap((c) => c.aliases.filter((a) => resolveChain(a)?.key !== c.key)).join(", ")
);
check("every chain resolves by its own key", CHAINS.every((c) => resolveChain(c.key)?.key === c.key));

// --- LayerZero V1 peer decoding ----------------------------------------------
// trustedRemoteLookup returns remote and local addresses packed together,
// remote first. Reading the wrong half, or accepting a short value, would
// point the balance read at an address that holds nothing - and a wrong
// number here is worse than a missing row.

function decodeV1Peer(raw: string): string | undefined {
  const hex = raw.replace(/^0x/, "");
  if (hex.length < 40) return undefined;
  const remote = `0x${hex.slice(0, 40)}`;
  return /^0x0+$/i.test(remote) ? undefined : remote;
}

const REMOTE = "3ee18B2214AFF97000D974cf647E7C347E8fa585";
const LOCAL = "5a58505a96D1dbf8dF91cB21B54419FC36e93fdE";
check(
  "the remote address is taken from the front of the packed value",
  decodeV1Peer(`0x${REMOTE}${LOCAL}`)?.toLowerCase() === `0x${REMOTE}`.toLowerCase()
);
check("an unconfigured route decodes to nothing", decodeV1Peer("0x") === undefined);
check("a truncated value is rejected rather than padded", decodeV1Peer("0x1234") === undefined);
check("an all-zero remote is not treated as an address", decodeV1Peer(`0x${"0".repeat(80)}`) === undefined);

// V2 numbered its chains by adding 30000 to V1's numbers, so V1's ids come
// from the eids the bot already reads live rather than from a table.
const v1FromEid = (eid: number) => (eid - 30000 > 0 && eid - 30000 < 1000 ? eid - 30000 : undefined);
check("Ethereum's V1 id comes out of its eid", v1FromEid(30101) === 101);
check("Base's V1 id comes out of its eid", v1FromEid(30184) === 184);
check("a testnet or malformed eid yields no V1 id", v1FromEid(40161) === undefined && v1FromEid(101) === undefined);

// --- LayerZero ticker aliases ------------------------------------------------
// A bridged token is often listed under its own name rather than the
// original's: looking up USDT finds a deprecated adapter holding a few
// thousand, while USDT0 - one key away - holds the real balance. The rule
// generates candidates only; each still has to prove on-chain what it locks.

const REGISTRY_KEYS = ["USDT", "USDT0", "USDTB", "USDC", "USDC.E", "USDCE", "USD", "USDTABCDEF", "WETH", "ETH"];
check("the token's own ticker is not returned as its alias", !aliasKeysFor("USDT", REGISTRY_KEYS).includes("USDT"));
check("a one-character suffix is a candidate", aliasKeysFor("USDT", REGISTRY_KEYS).includes("USDT0"));
check("so is a two-character one", aliasKeysFor("USDC", REGISTRY_KEYS).includes("USDC.E"));
check("but not an arbitrarily longer name", !aliasKeysFor("USDT", REGISTRY_KEYS).includes("USDTABCDEF"));
// "ETH" would otherwise pull in WETH's neighbours and half the registry.
check("a short ticker generates no candidates at all", aliasKeysFor("ET", REGISTRY_KEYS).length === 0);
check("a ticker that is a prefix of nothing yields nothing", aliasKeysFor("WETH", REGISTRY_KEYS).length === 0);

// --- token symbol normalisation ----------------------------------------------
// Tether writes its symbol with the tugrik sign, so USDT0's on-chain symbol
// is "USD\u20AE0". Stripping that as punctuation leaves "USD0", which matches
// no ticker - and that alone rejected fourteen of USDT's twenty-three
// LayerZero deployments, on exactly the chains the wider search was for.

const norm = (v: string) => v.toUpperCase().replace(/\u20AE/g, "T").replace(/[^A-Z0-9]/g, "");
const matches = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));

check("the tugrik sign reads as a T", norm("USD\u20AE0") === "USDT0");
check("USD\u20AE0 is recognised as USDT", matches("USD\u20AE0", "USDT"));
check("plain USDT still matches itself", matches("USDT", "USDT"));
check("a wrapped variant still matches", matches("WETH", "ETH"));
check("an unrelated token does not", !matches("DAI", "USDT"));

// --- LayerZero chain metadata ------------------------------------------------
// A chain with no eid cannot be named to a contract, so the peer walk cannot
// ask about it and every deployment there stays invisible. Asking the
// endpoint directly misses the zk-rollups, where deterministic deployment
// does not hold and the endpoint sits elsewhere; the published metadata
// knows them regardless. The response shape is read defensively, so what
// matters is that a wrong shape yields nothing rather than nonsense.

check(
  "an eid is matched by EVM chain id",
  extractEids({ someName: { chainDetails: { nativeChainId: 8453 }, deployments: [{ eid: 30184 }] } }).get("base") ===
    30184
);
check(
  "a chain named the way we name it is matched too",
  extractEids({ ethereum: { deployments: [{ eid: 30101 }] } }).get("ethereum") === 30101
);
// V2 eids are V1's ids plus 30000, so the number says which generation it
// is - no need to trust a version label that may not be there.
check(
  "a V1 eid is not mistaken for a V2 one",
  extractEids({ ethereum: { deployments: [{ eid: 101 }] } }).size === 0
);
check(
  "a testnet eid is out of range and ignored",
  extractEids({ ethereum: { deployments: [{ eid: 40161 }] } }).size === 0
);
check("a chain we do not support is skipped", extractEids({ solana: { deployments: [{ eid: 30168 }] } }).size === 0);
check("a malformed payload yields nothing rather than throwing", extractEids("nonsense").size === 0);
check("so does an empty one", extractEids({}).size === 0 && extractEids(null).size === 0);
check(
  "an entry with no usable eid is skipped, not guessed at",
  extractEids({ ethereum: { chainDetails: { nativeChainId: 1 }, deployments: [] } }).size === 0
);

// -----------------------------------------------------------------------------
// The same payload, read for a different question: which chains exist at all.
// Discovery used to take its candidates from the price API alone, and the
// price API lists the chains worth pricing tokens on. Sanko, Glue and Apex
// Fusion Nexus are none of them and all three carry Stargate pools, which is
// exactly what this bot is asked about.
// -----------------------------------------------------------------------------

const lzPayload = {
  "sanko-mainnet": {
    chainDetails: {
      chainType: "evm",
      nativeChainId: 1996,
      name: "Sanko",
      nativeCurrency: { name: "DMT", symbol: "DMT", decimals: 18 },
    },
    deployments: [{ eid: 30278 }],
    rpcs: [{ url: "https://mainnet.sanko.xyz" }],
    blockExplorers: [{ url: "https://explorer.sanko.xyz/" }],
  },
  "sanko-testnet": {
    chainDetails: { chainType: "evm", nativeChainId: 1992, name: "Sanko Testnet" },
    deployments: [{ eid: 40278 }],
    rpcs: [{ url: "https://sanko-arb-sepolia.rpc.caldera.xyz/http" }],
  },
  "solana-mainnet": {
    chainDetails: { chainType: "solana", nativeChainId: 101, name: "Solana" },
    deployments: [{ eid: 30168 }],
  },
  "nodeploy-mainnet": {
    chainDetails: { chainType: "evm", nativeChainId: 777777, name: "Described, not bridged" },
  },
};

const lzCandidates = candidatesFrom(lzPayload);
check("a bridged EVM mainnet becomes a candidate", lzCandidates.length === 1, lzCandidates.map((c) => c.slug).join(","));
check("keyed by the bridge's own name, minus the suffix", lzCandidates[0]?.slug === "sanko");
check("with the chain id both sides agree on", lzCandidates[0]?.chainId === 1996);
check("and the endpoints the bridge publishes", lzCandidates[0]?.rpcUrls.join(",") === "https://mainnet.sanko.xyz");
check("the explorer loses its trailing slash", lzCandidates[0]?.explorerUrl === "https://explorer.sanko.xyz");
check("the native coin is taken from the payload, not assumed", lzCandidates[0]?.nativeCurrency?.symbol === "DMT");
// Play money under a real chain's name is worse than a missing chain.
check("a testnet is refused however it is labelled", !lzCandidates.some((c) => c.chainId === 1992));
// Non-EVM chains have their own readers; an RPC url and a chain id are not
// how they are reached, and Solana's "101" collides with a real EVM id.
check("a non-EVM chain is not discovery's to add", !lzCandidates.some((c) => c.chainId === 101));
// A described network is not a bridge on it.
check("an entry with no deployments is a description, not a chain to add", !lzCandidates.some((c) => c.chainId === 777777));
check("a malformed payload yields no candidates rather than throwing", candidatesFrom("nonsense").length === 0);
check("so does an empty one", candidatesFrom({}).length === 0 && candidatesFrom(null).length === 0);

// One entry per chain id, and the richer description wins - not whichever
// happened to be enumerated last.
const twice = candidatesFrom({
  "dup-a-mainnet": { chainDetails: { chainType: "evm", nativeChainId: 5000, name: "Dup" }, deployments: [{ eid: 30181 }], rpcs: [{ url: "https://one.example" }, { url: "https://two.example" }] },
  "dup-b-mainnet": { chainDetails: { chainType: "evm", nativeChainId: 5000, name: "Dup" }, deployments: [{ eid: 30181 }], rpcs: [{ url: "https://one.example" }] },
});
check("a chain listed twice is one candidate", twice.length === 1);
check("and keeps the fuller endpoint list", twice[0]?.rpcUrls.length === 2);

// Endpoints that need a key the bot does not have are not endpoints.
const templated = candidatesFrom({
  "keyed-mainnet": {
    chainDetails: { chainType: "evm", nativeChainId: 4242, name: "Keyed" },
    deployments: [{ eid: 30242 }],
    rpcs: [{ url: "https://rpc.example/v1/${API_KEY}" }, { url: "https://open.example" }],
  },
});
check("a templated endpoint is dropped", templated[0]?.rpcUrls.join(",") === "https://open.example");

// A chain absent from the payload and a chain present under a name we do not
// match are different problems with different fixes, so the count of what
// was seen is kept alongside the count of what matched.
extractEids({ ethereum: { deployments: [{ eid: 30101 }] }, solana: {}, aptos: {} });
check("the payload's own size is remembered", lastMetadataChainCount() === 3);

// A chain with no eid needs a reason, not just a name. Absent from the
// source, listed under a name we do not recognise, and deployed on V1 only
// are three situations with three different answers, and only one of them is
// something this code can fix.
extractEids({
  ronin: { chainDetails: { nativeChainId: 2020 }, deployments: [{ eid: 173 }] },
  "boba-mainnet": { deployments: [{ eid: 30158 }] },
  ethereum: { chainDetails: { nativeChainId: 1 }, deployments: [{ eid: 30101 }] },
});
check("a V1-only chain is reported as V1-only", /только V1/.test(explainMissing("ronin", 2020)));
check(
  "a chain present with a V2 eid points the finger at our own matching",
  /сопоставление не сработало/.test(explainMissing("boba", 288))
);
check("a chain the source does not list is reported as not deployed", /этой сети нет/.test(explainMissing("katana", 747474)));

// Not every entry lists its deployments as an array, and a shape the reader
// does not accept looks exactly like a chain with nothing deployed on it.
check(
  "deployments given as an object are read too",
  extractEids({
    gnosis: { chainDetails: { nativeChainId: 100 }, deployments: { v2: { eid: 30145 } } },
  }).get("gnosis") === 30145
);
// And when there is genuinely no eid, the entry's own fields are named, so
// an unread shape can be told from an empty one.
extractEids({
  "odd-mainnet": { deployments: [{ notAnEid: 1 }] },
  "described-mainnet": { chainName: "Described", rpcs: [] },
});
check(
  "an entry with deployments but no eid has its fields named",
  /deployments есть, но eid не найден/.test(explainMissing("odd", 999999))
);
// A chain entry with no deployments field is a description, not a
// deployment - saying so beats printing field names and leaving the reader
// to work it out.
check(
  "an entry that is only a description says exactly that",
  /только описание сети/.test(explainMissing("described", 999998))
);

// CoinGecko keys its platform map by its own slug and publishes what each
// slug means in /asset_platforms - including chain_identifier, the EVM chain
// id. The whole of this block is about resolving a slug to one of our chains.
const gecko = parseAssetPlatforms([
  { id: "ethereum", chain_identifier: 1, name: "Ethereum" },
  { id: "polygon-pos", chain_identifier: 137, name: "Polygon POS" },
  { id: "world-chain", chain_identifier: 480, name: "World Chain Mainnet" },
  { id: "solana", chain_identifier: null, name: "Solana" },
  { id: "some-chain-we-do-not-support", chain_identifier: 999999, name: "Nowhere" },
  { id: "nonsense-platform", chain_identifier: null, name: "Mainnet" },
]);
check("the platform list is keyed by slug", gecko.get("polygon-pos")?.chainId === 137);
check("a platform without a chain id keeps its name", gecko.get("solana")?.chainId === undefined);

// A base58 mint is not an EVM address, and rejecting it as malformed is
// what hid every non-EVM deployment before anything could look at it.
const withSolana = parseCoinResponse(
  {
    symbol: "usdc",
    name: "USDC",
    platforms: {
      ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "nonsense-platform": "не адрес",
    },
  },
  "USDC",
  gecko
);

// The bug this whole source change removes. CoinGecko calls chain 480
// "World Chain Mainnet"; the bot calls it "World Chain"; the name matched
// nothing, so the chain landed in the report's "not checked" footer two
// screens below the rows the same report had just printed for it. The chain
// id agrees where the spellings do not.
const suffixed = parseCoinResponse(
  { symbol: "wld", name: "Worldcoin", platforms: { "world-chain": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" } },
  "WLD",
  gecko
);
check("a name the bot spells differently resolves by chain id", suffixed?.platforms[0]?.chainKey === "worldchain");

// The other half of that class: a name qualified rather than renamed -
// "Polygon POS" here, "Polygon (prev. MATIC)" at the API this replaced.
const bracketed = parseCoinResponse(
  { symbol: "carr", name: "Carnomaly", platforms: { "polygon-pos": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" } },
  "CARR",
  gecko
);
check("a qualified network name still resolves", bracketed?.platforms[0]?.chainKey === "polygon");

// A chain id we do not carry must resolve to nothing rather than to
// whichever chain happens to answer to a similar word.
const unrelated = parseCoinResponse(
  {
    symbol: "zzz",
    name: "Nothing",
    platforms: { "some-chain-we-do-not-support": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  },
  "ZZZ",
  gecko
);
check("an unsupported chain id matches no chain", unrelated?.platforms[0]?.chainKey === undefined);
check("and it is kept in the report rather than dropped", unrelated?.platforms[0]?.platformName === "Nowhere");

// A slug the platform list has never heard of still has to survive: the list
// is cached for half a day, and a chain can appear on a token before it
// appears in the platform list.
const unknownSlug = parseCoinResponse(
  { symbol: "new", name: "New", platforms: { "chain-launched-yesterday": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" } },
  "NEW",
  gecko
);
check("an unknown slug is kept under its own name", unknownSlug?.platforms[0]?.platformName === "chain-launched-yesterday");

// Losing the platform list to a rate limit must not lose the token with it.
// Without the list a network is matched by the spelling of its slug, which
// mostly works - and quietly does not for the ones whose slug resembles
// nothing anyone would type, which is why Optimism's is spelled out.
const noPlatformList = new Map<string, AssetPlatform>();
check(
  "a slug still resolves without the platform list",
  parseCoinResponse(
    { symbol: "x", name: "X", platforms: { "arbitrum-one": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" } },
    "X",
    noPlatformList
  )?.platforms[0]?.chainKey === "arbitrum"
);
check("including Optimism, whose slug matches nothing", resolveEvmPlatform(undefined, "optimistic-ethereum") === "optimism");
check("and a slug for nothing we carry still resolves to nothing", resolveEvmPlatform(undefined, "not-a-chain") === undefined);

// Tron speaks Ethereum's JSON-RPC and the bot reads it through viem like any
// other chain - but its addresses are base58, so a Tron deployment never
// reaches the EVM branch and fell through the non-EVM one, which only knew
// about Solana, Cosmos and Starknet. The report then said "the bot does not
// check TRON" on the same screen as a Tron section listing balances.
check("Tron resolves despite not having EVM addresses", resolveNonEvmPlatform(undefined, "tron") === "tron");
check("and so do the chains that always did", resolveNonEvmPlatform(undefined, "solana") === "solanamainnet");
// Near and Aptos are read now: neither has a warp route or a pool, but both
// have a Wormhole Token Bridge, and its address comes from Wormhole's own
// registry rather than from anything typed here.
check("Near is read through Portal", resolveNonEvmPlatform(undefined, "near-protocol") === "near");
check("and so is Aptos", resolveNonEvmPlatform(undefined, "aptos") === "aptos");
// TON is read too: LayerZero lists four adapters there and all of them lock
// what they carry, which is what this bot measures.
// The registry is full of keys that are not all-capitals - USDe, sUSDe,
// wstETH, weETH, ezETH - and the ticker always arrives uppercased, because
// that is how the price API reports it. Looking the key up directly meant
// those tokens had no registry deployments at all as far as the bot was
// concerned: USDe has an adapter on TON holding real collateral, and the
// report said the chain carried nothing.
const mixedCaseRegistry = { USDe: [{ a: 1 }], USDT: [{ b: 2 }], usdt: [{ c: 3 }] };
check("a mixed-case key is found from an uppercased ticker", entriesForSymbol(mixedCaseRegistry, "USDE").length === 1);
check("and the ticker's own case does not matter either", entriesForSymbol(mixedCaseRegistry, "usde").length === 1);
check("every spelling of one ticker is collected", entriesForSymbol(mixedCaseRegistry, "USDT").length === 2);
check("and a ticker the registry lacks finds nothing", entriesForSymbol(mixedCaseRegistry, "NOPE").length === 0);

check("TON resolves through its LayerZero adapters", resolveNonEvmPlatform(undefined, "ton") === "ton");

// TON writes an address as workchain and hash together, and the registry
// gives only the hash. Workchain 0 is the basechain, where ordinary
// contracts live; -1 is the masterchain, which carries validators and
// configuration, not jettons.
check(
  "a registry hash becomes a TON address",
  toTonAddress("0x1ddf580052174ed1dd0d66c35bfdc1a5fcc69af4f4ae36154b13dcfc6c14a35f") ===
    "0:1ddf580052174ed1dd0d66c35bfdc1a5fcc69af4f4ae36154b13dcfc6c14a35f"
);
check("an EVM address is not one", toTonAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7") === undefined);
check("and neither is nonsense", toTonAddress("тьфу") === undefined);

// A jetton balance lives in a wallet contract owned by the holder, not in
// the holder itself, so what comes back is a list of wallets.
const wallets = parseJettonWallets({
  jetton_wallets: [
    { address: "0:aaa", balance: "1500000", jetton: "0:master1", owner: "0:owner" },
    { address: "0:bbb", balance: "не число", jetton: "0:master2" },
    { address: "0:ccc", jetton: "0:master3" },
  ],
});
check("a jetton holding is read", wallets.length === 1 && wallets[0].balance === 1_500_000n);
check("a balance that is not digits is dropped", !wallets.some((w) => w.jetton === "0:master2"));
check("and so is a wallet with no balance at all", !wallets.some((w) => w.jetton === "0:master3"));
check("an unparseable answer is not a crash", parseJettonWallets("тьфу").length === 0);

// TON's metadata standard stores decimals as a string, and lets a jetton
// omit them - the standard's default is nine, and guessing eighteen would
// report a billion times too little.
check("decimals arrive as a string", parseJettonMaster({ jetton_masters: [{ jetton_content: { decimals: "6", symbol: "USD₮" } }] })?.decimals === 6);
check("a jetton without them gets the standard's default", parseJettonMaster({ jetton_masters: [{ jetton_content: {} }] })?.decimals === 9);
check("an absurd value is refused", parseJettonMaster({ jetton_masters: [{ jetton_content: { decimals: "999" } }] }) === undefined);
check("and an empty answer is not a zero", parseJettonMaster({ jetton_masters: [] }) === undefined);

// The index is asked once per adapter and again per jetton, while the report
// is doing everything else at once, and it allows about one request a second
// without a key. /ton read an adapter seconds before /info reported the same
// chain as unanswered - so a refusal here is routine, not exceptional, and
// the one API listed behind it as a fallback was a different API whose paths
// all 404: a second chance that could never be taken.
check("TON has one API base, not a fallback that cannot answer", TON_CHAIN.apiUrls.length === 1);

check("and it is the index whose shape the parser reads", TON_CHAIN.apiUrls[0].includes("toncenter.com/api/v3"));

// A body that arrived whole and still has no wallets in it is a different
// fact from a refusal, and the two were reported identically - which is how
// a key pointed at the wrong service looks exactly like a chain holding
// nothing. Naming what did arrive is the only thing that tells them apart.
check("an error object names itself", describeBody({ error: "invalid api key" }).includes("invalid api key"));
check("a detail field counts as one too", describeBody({ detail: "Unauthorized" }).includes("Unauthorized"));
check("an unfamiliar shape lists its fields", describeBody({ ok: true, result: [] }) === "поля: ok, result");
check("an empty object says so", describeBody({}) === "пустой объект");
check("and nothing at all says so", describeBody(undefined) === "пусто");
check("an HTML page is not mistaken for data", describeBody("<!DOCTYPE html>").startsWith("<!DOCTYPE"));
// An empty list is the index saying the adapter owns nothing, which may
// simply be true - a third state, and it has to be distinguishable from
// both a refusal and an answer nobody could parse.
// Tether writes the jetton's symbol with a tugrik - USD₮ - and stripping
// everything but letters and digits leaves "USD", which does not begin with
// "USDT0". The wallets were found and then thrown away by the very filter
// meant to pick them. The EVM side has replaced that character for months;
// this reader had not.
// A bridged deployment is routinely listed under its own ticker with a
// digit on the end - USDT0 for USDT - and the price API knows the original
// on TON while knowing nothing about the derivative. Without an address the
// reader is left sorting through whatever the adapter has been sent, and on
// TON that is eight spam jettons.
check("a derivative ticker names what it came from", baseTicker("USDT0") === "USDT");
check("and so does another", baseTicker("XAUT0") === "XAUT");
check("a ticker with no digit has no original", baseTicker("USDC") === undefined);
check("and one that would be left too short has none either", baseTicker("X0") === undefined);

check("the tugrik does not hide a match", symbolsAgree("USD₮", "USDT0"));
check("nor against the plain ticker", symbolsAgree("USD₮", "USDT"));
check("a case difference is not a difference", symbolsAgree("USDe", "USDE"));
check("an exact match is a match", symbolsAgree("ENA", "ENA"));
// Either may be a prefix of the other, because a bridged token is routinely
// listed under a longer name than the jetton it locks.
check("but two different tokens do not agree", !symbolsAgree("USDC", "USDT0"));
check("and a two-letter prefix is not agreement", !symbolsAgree("OP", "OPX"));
check("a jetton with no symbol agrees with nothing", !symbolsAgree(undefined, "USDT"));

check("an empty wallet list parses to nothing held", parseJettonWallets({ jetton_wallets: [] }).length === 0);
check(
  "and so does a body with no such field, for a different reason",
  parseJettonWallets({ ok: true }).length === 0
);
check(
  "while a chain no registry describes still resolves to nothing",
  ["tezos", "algorand-ecosystem"].every((p) => resolveNonEvmPlatform(undefined, p) === undefined)
);
// The custody address is derived, not written down - a chain Wormhole stops
// naming a Token Bridge for drops out of the table instead of being read at
// an address nobody vouches for.
check("every Portal chain has a custody address", PORTAL_CHAINS.every((c) => !!portalCustodyAddress(c.key)));
check("and they are distinct chains", new Set(PORTAL_CHAINS.map((c) => c.key)).size === PORTAL_CHAINS.length);

// Aptos carries two token standards, and which one an address belongs to is
// a guess from its shape: a coin type is written 0xaddr::module::Name, a
// fungible asset is a bare object address. The likely shape is tried first
// and the other one after, because the guess is the only thing standing
// between a real balance and a row reported as unreadable - and Aptos pairs
// many coins with a fungible asset, so the two are not always alternatives.
const coinFirst = aptosCalls("0xf22::asset::USDC", "0xcustody");
const fungibleFirst = aptosCalls("0x357b0b74bc833e95", "0xcustody");
check("both shapes are always tried", coinFirst.length === 2 && fungibleFirst.length === 2);
check(
  "a coin type asks coin::balance first",
  (coinFirst[0].balance as { function: string }).function === "0x1::coin::balance"
);
check(
  "a bare address asks the fungible store first",
  (fungibleFirst[0].balance as { function: string }).function === "0x1::primary_fungible_store::balance"
);
// The reader keeps only hex addresses on chains that resolve to EVM, so a
// TON or Sui deployment disappears before anyone can see its shape - and
// building a reader for a chain means first seeing what the registry holds
// for it. This scan is deliberately unfiltered for that reason.
const registrySample = {
  USDT: [
    {
      deployments: {
        ethereum: { type: "OFTAdapter", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
        ton: { type: "OFT", address: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs" },
      },
    },
  ],
  USDC: [{ deployments: { "ton-mainnet": { type: "OFT", address: "EQAbc" } } }],
};
const tonFound = deploymentsOnChain(registrySample, "TON");
check("a non-EVM chain's deployments are found", tonFound.found === 2);
check("under every key the registry spells it with", tonFound.chainKeys.sort().join() === "ton,ton-mainnet");
check("and the raw address is shown, not filtered out", tonFound.rows.some((r) => r.includes("EQCxE6mU")));
check("a chain the registry does not carry finds nothing", deploymentsOnChain(registrySample, "tezos").found === 0);

check(
  "and each falls back to the other",
  (coinFirst[1].balance as { function: string }).function ===
    (fungibleFirst[0].balance as { function: string }).function
);

// /gecko answers "is the key working" with a request rather than a guess,
// and the plan's own numbers are what it reports back.
const keyBody = parseKeyResponse({
  plan: "Demo",
  rate_limit_request_per_minute: 30,
  monthly_call_credit: 10000,
  current_total_monthly_calls: 123,
  current_remaining_monthly_calls: 9877,
});
check("the plan is read", keyBody.plan === "Demo");
check("and its per-minute limit", keyBody.perMinute === 30);
check("and what is left of the month", keyBody.monthlyLeft === 9877);

// Field names here are CoinGecko's to change, so missing ones must come
// back missing rather than as zero - "0 запросов в минуту" would read as a
// dead key when it only means the field moved.
const sparse = parseKeyResponse({ plan: "Pro" });
check("a missing number stays missing", sparse.perMinute === undefined && sparse.monthlyCredit === undefined);
check("a nonsense body is not a crash", parseKeyResponse("тьфу").plan === undefined);
check("and neither is nothing at all", parseKeyResponse(undefined).plan === undefined);

// CoinGecko explains every rejection in the body, and reading it is the
// difference between a diagnosis and a guess: a Demo key was reported as
// rejected when it was the endpoint, not the key, that the plan lacked.
check(
  "the service's own reason is read",
  explainBody({ status: { error_code: 10011, error_message: "This endpoint is available on other plans" } }) ===
    "This endpoint is available on other plans (код 10011)"
);
check("a code with no text still says something", explainBody({ status: { error_code: 10002 } }) === "код 10002");
check("a plain error field is read too", explainBody({ error: "invalid api key" }) === "invalid api key");
check("and a body with nothing in it says nothing", explainBody({}) === undefined);
check("nor does a body that is not an object", explainBody("тьфу") === undefined);

// Node wraps every transport failure as "fetch failed" and puts the
// diagnosis in `cause`. Sixteen chains reported the wrapper and nothing
// else, which cannot tell a domain dead for a year from a node that is
// merely busy - opposite problems with opposite fixes.
const dnsFailure = new Error("fetch failed");
(dnsFailure as any).cause = Object.assign(
  new Error("getaddrinfo ENOTFOUND rpc.example.invalid"),
  { code: "ENOTFOUND" }
);
check(
  "the cause replaces the wrapper",
  describeError(dnsFailure) === "getaddrinfo ENOTFOUND rpc.example.invalid (ENOTFOUND)"
);
check("a bare wrapper is still reported", describeError(new Error("fetch failed")) === "fetch failed");
check("a plain error is unchanged", describeError(new Error("HTTP 429")) === "HTTP 429");

// A cause that points back at its own error would otherwise spin forever,
// and a chain of them should read as a chain.
const looping = new Error("outer");
(looping as any).cause = looping;
check("a self-referential cause terminates", describeError(looping) === "outer");

const nested = new Error("fetch failed");
(nested as any).cause = Object.assign(new Error("connect ECONNREFUSED"), {
  code: "ECONNREFUSED",
  cause: new Error("certificate has expired"),
});
check(
  "nested causes are kept in order",
  describeError(nested) === "connect ECONNREFUSED (ECONNREFUSED) ← certificate has expired"
);

check("the EVM deployment is still read as before", withSolana?.platforms.length === 1);
check("the Solana mint is kept rather than discarded", withSolana?.otherPlatforms.length === 1);
check(
  "and it is matched to the chain the bot reads",
  withSolana?.otherPlatforms[0]?.chainKey === "solanamainnet"
);
check(
  "the mint keeps its base58 form",
  withSolana?.otherPlatforms[0]?.tokenAddress === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
check("nonsense is still thrown away", (withSolana?.platforms.length ?? 0) + (withSolana?.otherPlatforms.length ?? 0) === 2);

// A person typing "solana" after a ticker is naming a chain the bot reads.
// Telling them it is not connected, while the report shows Solana rows two
// lines above, is the bot contradicting itself.
check("solana resolves as a chain", resolveAnyChain("solana")?.key === "solanamainnet");
check("so does its registry name", resolveAnyChain("solanamainnet")?.key === "solanamainnet");
check("and its short form", resolveAnyChain("sol")?.key === "solanamainnet");
check("EVM chains still resolve as before", resolveAnyChain("eth")?.key === "ethereum");
check("a chain that does not exist still resolves to nothing", resolveAnyChain("нетакой") === undefined);
// getChain stays EVM-only: everything calling it needs viemChain.
check("but Solana is still not an EVM chain", getChain("solanamainnet") === undefined);

// --- Solana routes -----------------------------------------------------------
// The EVM rule "has collateralAddressOrDenom, therefore holds collateral" is
// wrong on Sealevel: synthetic routes carry that field too and mint their
// supply. Using the EVM signal would report twenty minting routes as custody
// contracts sitting at zero - a wrong answer dressed as a measurement.

// Every Sealevel chain runs the same VM and the same Hyperlane program, so
// the derivation proven on Solana holds on Eclipse, SOON and the rest.
// Adding them is a row in the chain table, not new logic - which is only
// true while the table is generated from the same registry the routes are.
const svmKeys = SVM_CHAINS.map((c) => c.key);
check("the Sealevel table covers more than Solana", svmKeys.length >= 4, svmKeys.join(", "));
check("Solana is in it", svmKeys.includes("solanamainnet"));
check("and so are the rollups that borrow its VM", svmKeys.includes("eclipsemainnet") && svmKeys.includes("soon"));
check("every one of them has somewhere to connect", SVM_CHAINS.every((c) => c.defaultRpcUrls.length > 0));
check("and its own RPC variable", new Set(SVM_CHAINS.map((c) => c.rpcEnvVar)).size === SVM_CHAINS.length);
// An explorer base carrying a query string cannot take a path appended.
check(
  "an explorer link is never built by gluing a path onto a query string",
  SVM_CHAINS.every((c) => !/\?.*\/account\//.test(c.explorerAddressUrl("X")))
);

const solRoutes = findSolanaHyperlaneRoutes("Bonk");
check("Solana collateral routes are found", solRoutes.length > 0, `${solRoutes.length}`);
check("and every one of them actually locks something", solRoutes.every((r) => /Collateral|Native/i.test(r.standard)));
check("a route brings both its program and its mint", solRoutes.every((r) => !!r.programId && !!r.mint));
check("and names the chain it is on", solRoutes.every((r) => svmKeys.includes(r.chainKey)));
check("a ticker with no Solana route yields nothing", findSolanaHyperlaneRoutes("QWERTYNOPE").length === 0);

// Derivation is deterministic, so the same inputs must always name the same
// account - a candidate that moved between runs could never be verified.
const cands = hyperlaneEscrowCandidates(
  "2mYa5q9chqBxR89Nc5CtAqdy5Wwjev5269GyxNFaT95U",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
);
check("several candidate accounts are offered", cands.length >= 4, `${cands.length}`);
check("each candidate says how it was derived", cands.every((c) => c.how.length > 0));
check(
  "derivation is stable across calls",
  JSON.stringify(
    hyperlaneEscrowCandidates(
      "2mYa5q9chqBxR89Nc5CtAqdy5Wwjev5269GyxNFaT95U",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    )
  ) === JSON.stringify(cands)
);
check("a malformed address yields no candidates rather than throwing", hyperlaneEscrowCandidates("не адрес", "тоже нет").length === 0);
check("Wormhole's Solana bridge is known", !!solanaTokenBridge());
check(
  "and its custody account can be derived from a mint",
  wormholeCustodyCandidates("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263").length > 0
);

// --- Cosmos routes -----------------------------------------------------------
// A CosmWasm warp route is a contract with an ordinary address holding an
// ordinary bank balance, so nothing here is derived and nothing can be
// derived wrongly. The routes addressed by a hex router id belong to
// Hyperlane's native module, whose collateral sits in an account this code
// cannot derive - those are counted, not guessed at.

const cosmosKeys = COSMOS_CHAINS.map((c) => c.key);
check("the Cosmos table is populated", cosmosKeys.length >= 8, cosmosKeys.join(", "));
check("every chain has a REST endpoint", COSMOS_CHAINS.every((c) => c.restUrls.length > 0));
check("a Cosmos chain resolves by name", resolveAnyChain("neutron")?.key === "neutron");
check("and by ticker-ish alias", resolveAnyChain("inj")?.key === "injective");
check("Cosmos chains are not EVM chains", getChain("neutron") === undefined);

const cosmosRoutes = findCosmosRoutes("INJ");
check("a Cosmos collateral route is found", cosmosRoutes.length > 0, `${cosmosRoutes.length}`);
check("its address is bech32, not a hex router id", cosmosRoutes.every((r) => /^[a-z]+1/.test(r.address)));
check("a native route falls back to the chain's own denom", cosmosRoutes.every((r) => r.denom.length > 0));
check("a ticker with no Cosmos route yields nothing", findCosmosRoutes("QWERTYNOPE").length === 0);

// The native-module routes are the ones left out of the readable set, and
// the two sets must not overlap: a route counted as unread while its balance
// is also shown would be the report arguing with itself.
const nativeRoutes = findNativeModuleRoutes("TIA");
check("native-module routes are identified separately", nativeRoutes.length > 0, `${nativeRoutes.length}`);
check("each is addressed by a hex id, not a contract", nativeRoutes.every((r) => !/^[a-z]+1/.test(r.routerId)));
const readable = new Set(findCosmosRoutes("TIA").map((r) => r.routeId + r.chainKey));
check(
  "and none of them is also counted as readable",
  nativeRoutes.every((r) => !readable.has(r.routeId + r.chainKey))
);
// The module escrows every route's collateral in one account, so the routes
// cannot be told apart from outside. One row per chain and denom: reporting
// the same balance once per route would multiply it, which in a report about
// whether a withdrawal will go through is the worst error available.
check("a native-module route knows the denom it escrows", nativeRoutes.every((r) => !!r.denom));
const chainDenoms = new Set(nativeRoutes.map((r) => `${r.chainKey}:${r.denom}`));
check(
  "seven TIA routes collapse to far fewer accounts",
  chainDenoms.size < nativeRoutes.length,
  `${nativeRoutes.length} маршрутов -> ${chainDenoms.size} аккаунтов`
);

// Once a chain lists more than one matching module account, taking whichever
// came first makes the answer depend on which node replied - and a
// sub-account like "hyperlane_fee" holds a different balance while matching
// the pattern just as well.
function pickModuleAccount(names: string[]): string {
  return [...names].sort((a, b) => {
    const rank = (n: string) => (n.toLowerCase() === "hyperlane" ? 0 : n.toLowerCase() === "warp" ? 1 : 2);
    return rank(a) - rank(b) || a.length - b.length;
  })[0];
}
check("the escrow is preferred over a sub-account", pickModuleAccount(["hyperlane_fee", "hyperlane"]) === "hyperlane");
check("order in the response does not decide it", pickModuleAccount(["hyperlane", "hyperlane_fee"]) === "hyperlane");
check("warp is the next best name", pickModuleAccount(["warp_collector", "warp"]) === "warp");
check("otherwise the shortest name wins", pickModuleAccount(["hyperlane_x_y", "hyperlane_x"]) === "hyperlane_x");

// --- Starknet, Radix, Aleo ---------------------------------------------------
// Three chains, three unrelated ways of asking for a balance, eleven routes
// between them. Every address comes from the registry, so the only failure
// available is being told nothing - which produces no row.

const otherKeys = OTHER_CHAINS.map((c) => c.key);
check("the last non-EVM chains are present", otherKeys.length >= 3, otherKeys.join(", "));
check("Starknet resolves", resolveAnyChain("starknet")?.key === "starknet");
check("Radix resolves", resolveAnyChain("radix")?.key === "radix");
check("every one has an endpoint", OTHER_CHAINS.every((c) => c.rpcUrls.length > 0));

const starknetRoutes = findOtherRoutes("USDC").filter((r) => r.protocol === "starknet");
check("a Starknet collateral route is found", starknetRoutes.length > 0, `${starknetRoutes.length}`);
check("and it names the token it locks", starknetRoutes.every((r) => !!r.collateral));

// Radix reports a decimal string rather than base units, so this is the
// conversion every one of its balances passes through. Done on strings:
// parsing "1234567.89" as a float loses precision before it is ever scaled.
check("a whole number converts", decimalToBaseUnits("12", 6) === 12_000_000n);
check("a fraction converts", decimalToBaseUnits("12.34", 6) === 12_340_000n);
check("a fraction longer than the scale is cut, not rounded up", decimalToBaseUnits("1.9999999", 6) === 1_999_999n);
check("no fractional part at all still works", decimalToBaseUnits("7", 18) === 7n * 10n ** 18n);
check("zero stays zero", decimalToBaseUnits("0", 6) === 0n);
// A balance beyond 2^53 is where a float-based conversion would start lying.
check(
  "a balance too large for a float is exact",
  decimalToBaseUnits("123456789012345.678901", 18) === 123456789012345678901000000000000n
);

// Every non-EVM chain declares an env var for its endpoint, and for a while
// none of the readers looked at it - the variables were advertised in the
// chain tables and ignored everywhere else, so setting one did nothing.
// Public endpoints on these chains go stale, get discontinued or fall behind
// the ledger, which is exactly when someone reaches for their own.
process.env.__TEST_RPC_URL = "https://mine.example";
check(
  "a configured endpoint is tried first",
  endpointsWithOverride("__TEST_RPC_URL", ["https://public.example"])[0] === "https://mine.example"
);
check(
  "and the public ones stay behind it",
  endpointsWithOverride("__TEST_RPC_URL", ["https://public.example"]).length === 2
);
check(
  "without one, nothing changes",
  endpointsWithOverride("__UNSET_RPC_URL", ["https://public.example"]).join() === "https://public.example"
);
delete process.env.__TEST_RPC_URL;

// --- address validation ------------------------------------------------------
// This guard was silently passing everything: viem's getAddress() returns a
// mixed-case input unchanged instead of validating it, so the old
// try/catch around it approved any capitalisation. Two addresses in the
// repo were wrong and the check reported 28/28. These cases fail if the
// technique ever regresses to something that always agrees.

const GOOD = "0x3ee18B2214AFF97000D974cf647E7C347E8fa585";
check("a correctly checksummed address passes", validateAddress(GOOD).length === 0);
check("an all-lowercase address passes, having no checksum to check", validateAddress(GOOD.toLowerCase()).length === 0);
check(
  "a single flipped letter is caught",
  validateAddress("0x3ee18B2214AFF97000D974cf647E7C347E8fa585".replace("B2214", "b2214")).length === 1
);
check("a dropped character is caught", validateAddress(GOOD.slice(0, -1)).length > 0);
check("something that is not an address at all is caught", validateAddress("0xnope").length > 0);

// --- Wormhole address book ---------------------------------------------------
// Derived from Wormhole's own registry rather than typed in. If that
// derivation ever breaks - a renamed export, a changed lookup - the map goes
// quietly empty and every Wormhole row disappears from every report, which
// reads as "this token has no liquidity" rather than as a broken import.

const portalMap = PORTAL_TOKEN_BRIDGE_BY_CHAIN as Record<string, string>;
check("the Wormhole map is not empty", Object.keys(portalMap).length >= 10, `${Object.keys(portalMap).length} chains`);
check(
  "and still resolves the Token Bridge everyone knows by sight",
  portalMap.ethereum === "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
  portalMap.ethereum
);
check("every derived address survives validation", Object.values(portalMap).every((a) => validateAddress(a).length === 0));
check(
  "chains Wormhole never deployed to are absent rather than guessed",
  portalMap.linea === undefined && portalMap.blast === undefined && portalMap.mode === undefined
);

// --- shared vaults -----------------------------------------------------------
// Across keys its deployments by EVM chain id; we key chains by our own
// names. If that mapping resolves to nothing the table is silently empty and
// every Across row vanishes from every report - indistinguishable, to the
// reader, from the bridge holding no liquidity.

const acrossByChain = vaultAddressesByChain().across ?? {};
check("the Across table maps onto our chains", Object.keys(acrossByChain).length >= 10, `${Object.keys(acrossByChain).length} chains`);
check("every Across address survives validation", Object.values(acrossByChain).every((a) => validateAddress(a).length === 0));
// These three are the chains Wormhole never deployed to, so before Across
// they could only ever show a Hyperlane row.
check(
  "it reaches the chains Wormhole does not",
  !!acrossByChain.linea && !!acrossByChain.mode && !!acrossByChain.blast
);
check(
  "and does not invent a chain we have no RPC for",
  Object.keys(acrossByChain).every((key) => getChain(key) !== undefined)
);

// --- Stargate pools ----------------------------------------------------------
// The largest balances this bot reports, and the ones no ticker registry
// could find. The table is generated from Stargate's deployments, so what is
// worth testing is that it survives the trip: real addresses, mainnet only,
// and the assets people actually bridge.

const stargate = stargateCoverage();
check("Stargate covers the assets that matter", ["USDC", "USDT", "ETH"].every((a) => stargate.assets.includes(a)));
check("and resolves onto chains we support", stargate.pools >= 10, `${stargate.pools} pools`);

const allStargate = [
  ...Object.values(STARGATE_POOLS_BY_SYMBOL).flatMap((byChain) => Object.values(byChain)),
  ...Object.values(STARGATE_NATIVE_POOLS_BY_CHAIN_ID),
];
// Native pools hold the chain's coin and hold far more ETH on an L2 than any
// wrapped-token pool, so their absence was the largest gap in the ETH report.
check(
  "the native pools are in the table too",
  [1, 10, 8453, 42161].every((id) => !!STARGATE_NATIVE_POOLS_BY_CHAIN_ID[id])
);
check("every Stargate address survives validation", allStargate.every((a) => validateAddress(a).length === 0));
// Stargate deploys to testnets too, and a testnet pool read by chain id
// would report play money as real liquidity.
check(
  "no testnet pool made it into the table",
  Object.values(STARGATE_POOLS_BY_SYMBOL).every((byChain) =>
    Object.keys(byChain).every((id) => ![11155111, 43113, 5003, 421614, 84532].includes(Number(id)))
  )
);

// --- tracker block range arithmetic -----------------------------------------

const MAX = 2000n;
const LOOKBACK = 1000n;

const resumed = computePollRange({
  lastBlock: "100",
  currentBlock: 105n,
  maxRange: MAX,
  initialLookback: LOOKBACK,
});
check(
  "resumes at the block after the last scanned one",
  resumed?.fromBlock === 101n && resumed?.toBlock === 105n,
  JSON.stringify(resumed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
);

check(
  "returns nothing when no new blocks have been produced",
  computePollRange({ lastBlock: "100", currentBlock: 100n, maxRange: MAX, initialLookback: LOOKBACK }) === undefined
);

const capped = computePollRange({
  lastBlock: "0",
  currentBlock: 10_000n,
  maxRange: MAX,
  initialLookback: LOOKBACK,
});
check(
  "caps a large backlog to the max range",
  capped?.fromBlock === 1n && capped?.toBlock === 2000n,
  JSON.stringify(capped, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
);

const fresh = computePollRange({
  lastBlock: null,
  currentBlock: 5000n,
  maxRange: MAX,
  initialLookback: LOOKBACK,
});
check(
  "first run starts one lookback window behind the head",
  fresh?.fromBlock === 4000n && fresh?.toBlock === 5000n,
  JSON.stringify(fresh, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
);

const youngChain = computePollRange({
  lastBlock: null,
  currentBlock: 10n,
  maxRange: MAX,
  initialLookback: LOOKBACK,
});
check(
  "never asks for a negative block on a chain younger than the lookback",
  youngChain?.fromBlock === 0n && youngChain?.toBlock === 10n
);

// Consecutive rounds must not overlap (duplicate alerts) or skip blocks.
const roundOne = computePollRange({ lastBlock: "500", currentBlock: 600n, maxRange: MAX, initialLookback: LOOKBACK })!;
const roundTwo = computePollRange({
  lastBlock: roundOne.toBlock.toString(),
  currentBlock: 700n,
  maxRange: MAX,
  initialLookback: LOOKBACK,
})!;
check(
  "consecutive rounds are contiguous and non-overlapping",
  roundOne.toBlock + 1n === roundTwo.fromBlock,
  `${roundOne.toBlock} then ${roundTwo.fromBlock}`
);

// --- command argument parsing ------------------------------------------------

const PORTAL_ETH = "0x3ee18B2214AFF97000D974cf647E7C347E8fa585";

check("parses address with an explicit chain", (() => {
  const r = parseAddressChainArgs(`/info ${PORTAL_ETH} arbitrum`);
  return r.address === PORTAL_ETH && r.chainKey === "arbitrum" && !r.error;
})());

check("parses address without a chain", (() => {
  const r = parseAddressChainArgs(`/info ${PORTAL_ETH}`);
  return !!r.address && r.chainKey === undefined && !r.error;
})());

check("resolves chain aliases", (() => {
  const r = parseAddressChainArgs(`/info ${PORTAL_ETH} eth`);
  return r.chainKey === "ethereum";
})());

check("accepts a lowercase address", (() => {
  const r = parseAddressChainArgs(`/info ${PORTAL_ETH.toLowerCase()}`);
  return !!r.address && !r.error;
})());

check("accepts an address with non-canonical capitalisation", (() => {
  const oddCase = "0x3EE18b2214aff97000d974cf647e7c347e8fa585";
  const r = parseAddressChainArgs(`/info ${oddCase}`);
  return !!r.address && !r.error;
})());

check("handles the group-chat command form", (() => {
  const r = parseAddressChainArgs(`/info@my_bridge_bot ${PORTAL_ETH} base`);
  return r.address === PORTAL_ETH && r.chainKey === "base";
})());

check("rejects a truncated address", (() => {
  const r = parseAddressChainArgs("/info 0x3ee18B2214AFF97000D974cf647E7C347E8fa5");
  return !!r.error && !r.address;
})());

check("rejects an unknown chain", (() => {
  const r = parseAddressChainArgs(`/info ${PORTAL_ETH} solana`);
  return !!r.error;
})());

check("rejects a missing address", (() => parseAddressChainArgs("/info").error !== undefined)());

// --- event decoding ----------------------------------------------------------

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const transferTopics = encodeEventTopics({
  abi: transferAbi,
  eventName: "Transfer",
  args: {
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
  },
});
const transferLog = {
  topics: transferTopics,
  data: `0x${(123456n).toString(16).padStart(64, "0")}`,
} as unknown as Log;

const decodedTransfer = tryDecodeEvent(transferLog);
check(
  "decodes a known event shape",
  decodedTransfer?.eventName === "Transfer" && String(decodedTransfer?.args.value) === "123456",
  JSON.stringify(decodedTransfer, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
);

const unknownLog = {
  topics: ["0x" + "ab".repeat(32)],
  data: "0x",
} as unknown as Log;
check("returns undefined for an unrecognised event instead of throwing", tryDecodeEvent(unknownLog) === undefined);

// --- bytes32 peer/origin decoding -------------------------------------------

const evmPadded = "0x000000000000000000000000" + "3ee18B2214AFF97000D974cf647E7C347E8fa585".toLowerCase();
check("recognises a left-padded EVM address in bytes32", isEvmAddressBytes32(evmPadded));
check("decodes that bytes32 back to the address", bytes32ToAddress(evmPadded).toLowerCase() === PORTAL_ETH.toLowerCase());

const solanaLike = "0x" + "c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61";
check("does not mistake a full 32-byte non-EVM address for an EVM one", !isEvmAddressBytes32(solanaLike));

check("treats an all-zero bytes32 as not an address", !isEvmAddressBytes32("0x" + "0".repeat(64)));

// --- /info card rendering ----------------------------------------------------

const sample: DetectionResult = {
  protocol: "portal",
  confidence: "high",
  role: "Token Bridge: контракт самого моста",
  facts: [["Wormhole core bridge", "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B"]],
  peers: [
    { chainKey: "polygon", chainLabel: "Polygon", remoteId: 5, peerAddress: "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE" },
  ],
  notes: ["пример заметки"],
};

const card = formatInfoCard("ethereum", PORTAL_ETH as `0x${string}`, [sample]);
check("info card contains the role and a peer", card.includes("контракт самого моста") && card.includes("Polygon"));
check("info card stays within Telegram's message limit", card.length < 4096, `length=${card.length}`);
check(
  "empty detection renders a helpful message rather than a blank card",
  formatInfoCard("ethereum", PORTAL_ETH as `0x${string}`, []).includes("не относится ни к LayerZero")
);

// --- CoinGecko response parsing ----------------------------------------------

const platformList = parseAssetPlatforms([
  { id: "ethereum", chain_identifier: 1, name: "Ethereum" },
  { id: "arbitrum-one", chain_identifier: 42161, name: "Arbitrum One" },
  { id: "binance-smart-chain", chain_identifier: 56, name: "BNB Smart Chain" },
  { id: "nowhere", chain_identifier: 999999, name: "Some Chain We Do Not Support" },
]);

const coinBody = {
  id: "arbitrum",
  symbol: "arb",
  name: "Arbitrum",
  platforms: {
    "arbitrum-one": "0x912CE59144191C1204E64559FE8253a0e49E6548",
    ethereum: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",
    nowhere: "0xf2c2b3d6a5b1d4b2c8e0a9f7d6c5b4a3e2d1c0b9",
    broken: "не адрес",
  },
};

const parsed = parseCoinResponse(coinBody, "ARB", platformList);
check("parses the CoinGecko payload", parsed?.symbol === "ARB" && parsed?.name === "Arbitrum");
check(
  "maps a platform slug onto our chain key",
  parsed?.platforms.find((p) => p.chainKey === "arbitrum")?.tokenAddress ===
    "0x912CE59144191C1204E64559FE8253a0e49E6548"
);
check(
  "keeps an unsupported network without a chain key instead of dropping it",
  parsed?.platforms.some((p) => p.chainKey === undefined && p.platformName.includes("Do Not Support")) === true
);
check("skips malformed addresses", parsed?.platforms.every((p) => p.tokenAddress.length === 42) === true);
check("lists each platform once", parsed?.platforms.filter((p) => p.chainKey === "ethereum").length === 1);
check(
  "a coin with no platforms at all parses to an empty report",
  parseCoinResponse({ symbol: "btc", name: "Bitcoin" }, "BTC", platformList)?.platforms.length === 0
);
check(
  "maps BNB Chain through its chain id, not its spelling",
  parseCoinResponse(
    { symbol: "x", name: "X", platforms: { "binance-smart-chain": "0x912CE59144191C1204E64559FE8253a0e49E6548" } },
    "X",
    platformList
  )?.platforms[0]?.chainKey === "bsc"
);

// Tickers are not unique, and the copies outnumber the originals: reporting
// bridge liquidity for a namesake of USDT would be worse than reporting
// none. Market capitalisation is what settles it.
const searchBody = {
  coins: [
    { id: "fake-tether", symbol: "USDT", name: "Tether Imposter", market_cap_rank: null },
    { id: "tether", symbol: "USDT", name: "Tether", market_cap_rank: 3 },
    { id: "another-usdt", symbol: "USDT", name: "USDT Clone", market_cap_rank: 4210 },
  ],
};
check("the best-known coin with the ticker wins", pickCoin(searchBody, "USDT") === "tether");
check("an unranked namesake does not win", pickCoin(searchBody, "usdt") === "tether");
check(
  "a name is accepted when no ticker matches",
  pickCoin({ coins: [{ id: "wormhole", symbol: "W", name: "Wormhole", market_cap_rank: 200 }] }, "Wormhole") ===
    "wormhole"
);
check(
  "a partial name is not accepted",
  pickCoin({ coins: [{ id: "wormhole", symbol: "W", name: "Wormhole", market_cap_rank: 200 }] }, "worm") === undefined
);
check("an unknown ticker resolves to nothing", pickCoin({ coins: [] }, "NOPE") === undefined);
check("a malformed search answer resolves to nothing", pickCoin({}, "NOPE") === undefined);


// --- amount formatting -------------------------------------------------------

check("formats a whole amount with thousands separators", formatAmount(1_250_000n * 10n ** 18n, 18).replace(/\u00a0/g, " ") === "1 250 000");
check("formats a six-decimal token", formatAmount(45_000_000_000n, 6) === "45 000".replace(/ /g, " ") || formatAmount(45_000_000_000n, 6).replace(/\u00a0/g, " ") === "45 000");
check("keeps a fraction visible so dust is not shown as zero", formatAmount(1_500_000_000_000_000n, 18).includes(","));
check("formats zero", formatAmount(0n, 18) === "0");

// --- bridge custodian resolution (real Hyperlane registry, no network) -------

const usdcRoutes = findHyperlaneCustodians("USDC");
check("finds Hyperlane collateral routers for USDC in the real registry", usdcRoutes.length > 0, `found=${usdcRoutes.length}`);
check(
  "every Hyperlane custodian names a supported chain and two addresses",
  usdcRoutes.every(
    (c) => !!getChain(c.chainKey) && c.custodyAddress.length === 42 && c.tokenAddress.length === 42
  )
);
check("a nonsense ticker matches no warp route", findHyperlaneCustodians("ZZZZNOTATOKEN").length === 0);

const custodians = resolveCustodians("USDC", [
  { chainKey: "ethereum", platformName: "Ethereum", tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { chainKey: "bsc", platformName: "BNB Smart Chain (BEP20)", tokenAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
]);
check(
  "adds a Wormhole custodian for every chain with a known Token Bridge",
  custodians.filter((c) => c.protocol === "wormhole").length === 2,
  `wormhole=${custodians.filter((c) => c.protocol === "wormhole").length}`
);
check("returns no duplicate custody entries", (() => {
  const keys = custodians.map((c) => `${c.protocol}:${c.chainKey}:${c.custodyAddress.toLowerCase()}`);
  return new Set(keys).size === keys.length;
})());

// --- liquidity report rendering ----------------------------------------------

function fakeBalance(chainKey: string, protocol: "wormhole" | "hyperlane" | "layerzero", amount: bigint): any {
  return {
    protocol,
    chainKey,
    custodyAddress: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
    tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    amount,
    decimals: 6,
  };
}

// The real shape of the problem: USDC resolves to well over a hundred
// custody contracts, which printed in full is several times Telegram's cap.
const manyChains = ["ethereum", "arbitrum", "base", "polygon", "bsc", "optimism", "avalanche"];
const heavy = Array.from({ length: 137 }, (_, i) =>
  fakeBalance(manyChains[i % manyChains.length], i % 9 === 0 ? "wormhole" : "hyperlane", BigInt((i + 1) * 1_000_000))
);

const heavyReport = renderLiquidityReport({
  symbol: "USDC",
  name: "USD Coin",
  balances: heavy,
  checkedCount: heavy.length,
  failuresByChain: {},
  attemptsByChain: {},
});
check(
  "a 137-custodian report fits inside Telegram's message limit",
  visibleLength(heavyReport) < 4096,
  `${visibleLength(heavyReport)} visible chars, ${heavyReport.length} of HTML`
);
// The closing notes are what explain a thin report. Budgeting the body
// first and appending them afterwards meant the cut landed on exactly the
// lines that say why the report looks the way it does.
check("a heavy report keeps its closing notes", heavyReport.includes("Всего проверено контрактов"));
check("and is not left with the truncation notice instead", !heavyReport.includes("обрезан"));
check("the heavy report still names several chains", (heavyReport.match(/Сеть:/g) ?? []).length >= 3);
check("the heavy report summarises the routes it did not print", heavyReport.includes("и ещё"));
check("the heavy report says how many contracts were checked", heavyReport.includes("проверено контрактов: 137"));
check(
  "the heavy report warns that routes are separate pools",
  heavyReport.includes("нельзя складывать")
);

// Routes under one ticker hold different contracts with different decimals.
// Comparing or adding the raw integers ranks an 18-decimal balance above any
// 6-decimal one regardless of real value, which is what shipped and showed
// USDT rows out of order with a wrong tail total.
function mixed(decimals: number, human: number): any {
  return {
    protocol: "hyperlane",
    chainKey: "ethereum",
    custodyAddress: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
    tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    amount: BigInt(human) * 10n ** BigInt(decimals),
    decimals,
  };
}

const mixedReport = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether USDt",
  // Real value order is 492987 > 37477 > 12625 > 900 > 800, but the
  // 18-decimal row has by far the largest raw integer.
  balances: [mixed(18, 12625), mixed(6, 492987), mixed(6, 37477), mixed(6, 900), mixed(18, 800)],
  checkedCount: 5,
  failuresByChain: {},
  attemptsByChain: {},
});
const orderedRows = (mixedReport.match(/<b>([\d\s\u00a0,]+) USDT<\/b>/g) ?? []).map((m) =>
  Number(m.replace(/[^\d,]/g, "").replace(",", "."))
);
check(
  "ranks rows by real value, not by raw integer, across mixed decimals",
  orderedRows.length >= 3 && orderedRows[0] > orderedRows[1] && orderedRows[1] > orderedRows[2],
  `порядок=${orderedRows.join(" > ")}`
);
check(
  "the largest row is the 6-decimal one, not the 18-decimal one",
  orderedRows[0] === 492987,
  `первый=${orderedRows[0]}`
);
check(
  "totals the tail on a common scale rather than adding raw integers",
  mixedReport.includes("суммарно 1 700") || mixedReport.includes("суммарно 1 700"),
  mixedReport.split("\n").find((l) => l.includes("суммарно")) ?? "строки с суммой нет"
);

const smallReport = renderLiquidityReport({
  symbol: "ARB",
  name: "Arbitrum",
  balances: [fakeBalance("arbitrum", "wormhole", 45_000_000_000n)],
  checkedCount: 7,
  failuresByChain: { polygon: 1 },
  attemptsByChain: { arbitrum: 1, polygon: 1 },
});
check("a small report shows the amount", smallReport.includes("45 000") || smallReport.includes("45 000"));
check("a small report names the chain that failed", smallReport.includes("Polygon"));

const emptyReport = renderLiquidityReport({
  symbol: "ZZZ",
  name: "Nothing",
  balances: [fakeBalance("ethereum", "wormhole", 0n)],
  checkedCount: 7,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
});
check("zero balances are reported as no liquidity, not as an error", emptyReport.includes("не заведён"));

// A peer walk that ran out of time must say so. The walk asks the seed's own
// node once per destination chain, and the number of chains it asks about
// went from 98 to 144, so a slow node can now leave the tail of the list
// unasked - which produces exactly the silence "LayerZero is not deployed
// there" produces.
const truncatedMesh = renderLiquidityReport({
  symbol: "MESHY",
  name: "Meshy",
  balances: [fakeBalance("ethereum", "layerzero", 1_000_000n)],
  checkedCount: 7,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  scope: {
    supportedChains: ["Ethereum"],
    unsupportedPlatforms: [],
    byProtocol: { layerzero: 1 },
    meshUnasked: 37,
  },
});
check("a truncated peer walk is admitted in the report", truncatedMesh.includes("не успел спросить 37"));
check("and says it was the node, not the token", truncatedMesh.includes("медленно"));

const wholeMesh = renderLiquidityReport({
  symbol: "MESHY",
  name: "Meshy",
  balances: [fakeBalance("ethereum", "layerzero", 1_000_000n)],
  checkedCount: 7,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  scope: {
    supportedChains: ["Ethereum"],
    unsupportedPlatforms: [],
    byProtocol: { layerzero: 1 },
    meshUnasked: 0,
  },
});
check("a walk that finished says nothing about time", !wholeMesh.includes("не успел спросить"));

// -----------------------------------------------------------------------------
// Sui. A coin there is a Move type tag, not an address, and a balance is a
// set of objects rather than a mapping inside a contract - so none of the
// EVM machinery applies and the parsing is its own.
// -----------------------------------------------------------------------------

check("a full coin type is recognised", isSuiCoinType("0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"));
// Sui writes its framework types short; both spellings name one coin.
check("and the chain's own short-form coin too", isSuiCoinType("0x2::sui::SUI"));
check("a bare address is not a coin type", !isSuiCoinType("0x2"));
check("nor is an EVM address", !isSuiCoinType("0xdAC17F958D2ee523a2206206994597C13D831ec7"));

check(
  "a short package id normalises to the same coin as its padded form",
  sameSuiCoinType("0x2::sui::SUI", `0x${"0".repeat(63)}2::sui::SUI`)
);
// The module and struct names are Move identifiers, so case is meaning:
// lowercasing USDC would name a type that does not exist.
check(
  "the struct name keeps its case",
  normaliseSuiCoinType("0x2::coin::COIN")?.endsWith("::coin::COIN") === true
);
check("two different coins do not collapse", !sameSuiCoinType("0x2::sui::SUI", "0x2::sui::WSUI"));

check("a supply comes back as a bigint", parseSupply({ value: "74309012673600" }) === 74_309_012_673_600n);
// Anything but a decimal string is a shape we did not expect, and guessing
// zero would print "nothing is issued here" about a chain we failed to read.
check("an unexpected shape is not read as zero", parseSupply({ value: null }) === undefined);
check("and neither is a missing field", parseSupply({}) === undefined);

check("a balance comes back as a bigint", parseBalance({ totalBalance: "1500000" }) === 1_500_000n);
check("an unreadable balance is not zero", parseBalance({ totalBalance: {} }) === undefined);

check("coin metadata yields decimals", parseCoinMetadata({ decimals: 6, symbol: "USDC" })?.decimals === 6);
// Decimals are what turns a raw integer into an amount; without them the
// number would be printed a million times too large.
check("metadata without decimals is refused", parseCoinMetadata({ symbol: "USDC" }) === undefined);

check("a matching symbol is accepted", suiSymbolAgrees("USDC", "USDC"));
check("a wrapped variant of the same ticker is accepted", suiSymbolAgrees("wUSDC", "USDC"));
check("another project's coin is rejected", !suiSymbolAgrees("CETUS", "USDC"));
// A coin with no metadata published is still evidence: the type tag came
// from the price API, and refusing on silence would hide real supply.
check("a coin that publishes no symbol is not refused", suiSymbolAgrees(undefined, "USDC"));

// On Sui a bridge does not own its collateral at an address - it hangs off
// the state object as a dynamic field - so the custody walk starts by
// listing those fields. Nothing here infers the shape; it prints it, and the
// reader gets written against what actually came back.
const suiFields = parseDynamicFields({
  data: [
    {
      name: { type: "0x2::dynamic_object_field::Wrapper<0x1::type_name::TypeName>", value: "0x2::sui::SUI" },
      objectType: "0xc575::token_registry::NativeAsset<0x2::sui::SUI>",
      objectId: "0xabc",
    },
  ],
});
check("a dynamic field is read out of Sui's listing", suiFields.length === 1);
check("its name is kept as the key the collateral hangs on", suiFields[0]?.name === "0x2::sui::SUI");
check("and its type, which is what says it holds an asset", suiFields[0]?.objectType.includes("NativeAsset"));
// A shape nobody expected must print as itself rather than vanish: the whole
// point of the listing is to find out what is there.
check("a field with no string name still arrives", parseDynamicFields({ data: [{ name: { value: { x: 1 } } }] }).length === 1);
check("a listing that is not a list yields nothing", parseDynamicFields({ data: "oops" }).length === 0);
check("and neither does an empty answer", parseDynamicFields(null).length === 0);
// Wormhole publishes the Sui bridge itself, so the walk needs no address
// written down here.
check("Wormhole names its own Sui bridge", (suiTokenBridge() ?? "").startsWith("0x"));

// The bridge object came back with no dynamic fields at all, which does not
// mean it holds nothing: on Sui a registry is a field of the state and its
// table is an object of its own. The id that matters is therefore never at
// the top - Sui writes a table as { id: { id: "0x…" }, size } - and it is
// the one the next call has to ask about.
const stateShape = parseObjectShape({
  data: {
    content: {
      type: "0xc575::state::State",
      fields: {
        governance_chain: 1,
        token_registry: { type: "0xc575::token_registry::TokenRegistry", fields: { coin_types: { id: { id: "0xdeadbeef".padEnd(66, "0") }, size: "42" } } },
      },
    },
  },
});
check("the object states its own type", stateShape?.type.includes("state::State"));
check("its top-level fields are listed", stateShape?.fields.includes("token_registry"));
check("and the nested table id is pulled out of the depths", stateShape?.ids.length === 1);
// Named by where it sits, not as a bare id. The token bridge's state holds
// three ids and the first walk followed the wrong one - the emitter registry
// and the token registry are indistinguishable without the path.
check("the id is named by the field it came from", stateShape?.ids[0]?.path === "token_registry.fields.coin_types.id.id");
check("an object with no content is not invented", parseObjectShape({ data: {} }) === undefined);
check("a short hex is not mistaken for an object id", suiIdsIn({ a: "0x2" }).length === 0);
// One entry per id: a state that names itself must not send the walk round
// in a circle.
const repeated = "0x" + "ab".repeat(32);
check("the same id twice is one entry", suiIdsIn({ a: repeated, b: { c: repeated } }).length === 1);

// The walk, as the chain actually answered it. The registry keys one field
// per coin: NativeAsset<C> for what the bridge locked on Sui, WrappedAsset<C>
// for what it minted here against collateral elsewhere. Counting the second
// as custody would claim the money is on Sui when it is on the chain the
// token came from.
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const PKG = "0x26efee2b51c911237888e5dc6702868abca3c7ac12c53f76ef8eba0697695e3d";
check("the coin a registry field is keyed by is read off its type", assetTypeParam(`${PKG}::native_asset::NativeAsset<${SUI}>`) === SUI);
check("a type with no parameter yields nothing", assetTypeParam(`${PKG}::state::State`) === undefined);
// Sui writes 0x2 short and everything published later at full width, and the
// registry and the price API do not agree on which - so the comparison has
// to go through the normaliser, not through string equality.
check("the same coin written two ways still matches", sameSuiCoinType(assetTypeParam(`x::native_asset::NativeAsset<${SUI}>`)!, "0x2::sui::SUI"));

const page = parseFieldPage({
  data: [{ name: { value: { dummy_field: false } }, objectType: `${PKG}::native_asset::NativeAsset<${SUI}>`, objectId: "0xaa" }],
  nextCursor: "0xbb",
  hasNextPage: true,
});
check("a page of registry fields keeps its cursor", page.nextCursor === "0xbb" && page.hasNextPage);
check("and the field type survives whole, since the coin is matched on it", page.fields[0]?.objectType.endsWith(">"));
// A last page must end the walk rather than loop on a stale cursor.
check("a last page says so", parseFieldPage({ data: [], hasNextPage: false }).hasNextPage === false);

check("the custody balance is read off the asset object", parseCustodyAmount({ data: { content: { fields: { custody: "2939806490000" } } } }) === 2_939_806_490_000n);
// The id a dynamic-field listing gives is the wrapper, not the asset: Sui
// writes every one as { id, name, value } with the NativeAsset under
// value.fields. Reading only the top level found no custody at all, and the
// walk said "this coin is not among the collateral" about a coin whose entry
// it had just matched by name on the same screen.
check(
  "and also when it sits under the dynamic field's wrapper",
  parseCustodyAmount({
    data: {
      content: {
        fields: {
          id: { id: "0xaa" },
          name: { dummy_field: false },
          value: { type: "0x26::native_asset::NativeAsset<0x2::sui::SUI>", fields: { custody: "17", decimals: 9 } },
        },
      },
    },
  }) === 17n
);
check("and also when Sui wraps it", parseCustodyAmount({ data: { content: { fields: { custody: { value: "42" } } } } }) === 42n);
// Zero is a real answer; a shape nobody expected is not, and printing it as
// zero would say "this vault is empty" about a vault nobody read.
check("an unexpected shape is not read as an empty vault", parseCustodyAmount({ data: { content: { fields: {} } } }) === undefined);
check("and neither is a missing object", parseCustodyAmount(null) === undefined);

// Sui is in the chain table now, and one of its bridges is read and the rest
// are not - which is precisely why the report has to say which. Without the
// line, "no bridge holds any of it here" would be covering for the ones that
// were never asked; with the old wording it denied the check that does run.
// Two lines of one report contradicted each other: /info TURBOS sui said
// Hyperlane, LayerZero, Stargate, Across and CCIP had been checked on Sui
// and found nothing, and four lines later that only Wormhole is read there.
// None of the five has a reader for that chain, so none was ever asked.
check("on Sui only the bridge with a reader counts as checked", protocolsReadableOn("sui").join() === "wormhole");
check("TON is LayerZero's alone", protocolsReadableOn("ton").join() === "layerzero");
check("Aptos has two", protocolsReadableOn("aptos").sort().join() === "layerzero,wormhole");
check("Solana has four", protocolsReadableOn("solanamainnet").length === 4);
// An EVM chain is asked by everything, and so is a report with no chain named.
check("an EVM chain is asked by every bridge", protocolsReadableOn("ethereum").length === 6);
check("and so is a report about no chain in particular", protocolsReadableOn().length === 6);
// A chain nothing reads claims nothing, rather than claiming all six.
check("a chain with no reader claims none", protocolsReadableOn("нет-такой-сети").length === 0);

// A token whose only vault is on Sui. Both short replies in the report build
// return before Sui is read - "no custody contracts found" and the
// one-network "nothing here" - so the custody row has to exist by the time
// they are reached, or a real balance is answered with "nothing found".
const suiOnly = renderLiquidityReport({
  symbol: "SUI",
  name: "Sui",
  balances: [
    {
      protocol: "wormhole",
      chainKey: "sui",
      custodyAddress: "0xf0147adcfbf7b3270aac16b35f1f1474fb75c178ad8ba04da28c866b8d337691",
      tokenAddress: "0x2::sui::SUI",
      note: "реестр токенов",
      amount: 2_939_806_490_000n,
      decimals: 9,
    } as any,
  ],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: {},
  scope: { supportedChains: [], unsupportedPlatforms: [], byProtocol: { wormhole: 1 }, bridgesUnread: ["sui"] },
});
check("a vault that exists only on Sui is reported", suiOnly.includes("Сеть: <b>Sui</b>"));
check("with the amount scaled by the coin's own decimals", suiOnly.includes("2 939,8064 SUI"));
check("and linked to the object holding it", suiOnly.includes("suiscan.xyz/mainnet/object/0xf0147adc"));
// Wormhole is read there; the rest are not, and the report says which even
// when it found something.
check("the partial-coverage caveat survives a found balance", suiOnly.includes("проверен только Wormhole"));

const suiKnownButUnread = renderLiquidityReport({
  symbol: "USDC",
  name: "USDC",
  balances: [fakeBalance("ethereum", "wormhole", 8_529_291_000000n)],
  checkedCount: 5,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  scope: {
    supportedChains: ["Ethereum"],
    unsupportedPlatforms: [],
    byProtocol: { wormhole: 1 },
    bridgesUnread: ["sui"],
  },
});
check("a chain whose bridges are only partly read says so", suiKnownButUnread.includes("проверен только Wormhole"));
check("and does not deny the check that does run", !suiKnownButUnread.includes("не хранилища мостов"));
check("and names it", /Sui/.test(suiKnownButUnread));

// A node that does not implement a method, or is rate-limiting, will be
// answered differently by the node beside it. Treating every RPC error as
// final meant one endpoint's "method not found" ended the read for all three.
check("a missing method is a reason to try the next node", isNodeLevelError(-32601, "Method not found"));
check("so is a rate limit", isNodeLevelError(-32000, "Too Many Requests"));
check("and an overloaded node", isNodeLevelError(undefined, "service temporarily unavailable"));
// A bad argument will be bad everywhere, and asking three nodes in turn
// only turns one wrong question into three.
check("a bad argument is final", !isNodeLevelError(-32602, "Invalid params: not a valid coin type"));

// This chain cannot be tried from a laptop the way an EVM node can, so
// without the node's own words the only way to learn why a read failed is
// to guess and redeploy.
const supplyWithReason = renderLiquidityReport({
  symbol: "USDC",
  name: "USDC",
  balances: [fakeBalance("ethereum", "wormhole", 8_529_291_000000n)],
  checkedCount: 3,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  supplyOnly: [{ chainKey: "sui", unreadable: true, reason: "Cannot find treasury cap" }],
});
check("an unread supply quotes what the chain said", supplyWithReason.includes("Cannot find treasury cap"));

// Sui came back holding 289 million USDC and landed under "no tracked bridge
// holds any of it here", followed by a conclusion deducing it must have
// arrived by some route the bot does not follow. Both were drawn from a
// check that never ran - Sui's vaults are not read - and both were
// contradicted by a warning four lines further down, where nobody would
// reconcile them.
const suiSupplyUnverified = renderLiquidityReport({
  symbol: "USDC",
  name: "USDC",
  balances: [fakeBalance("ethereum", "wormhole", 8_529_291_000000n)],
  checkedCount: 3,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  supplyOnly: [
    { chainKey: "sui", amount: 289_692_772_913900n, decimals: 6 },
    { chainKey: "cronos", amount: 7_410_048_194800n, decimals: 6 },
  ],
  scope: {
    supportedChains: ["Ethereum"],
    unsupportedPlatforms: [],
    byProtocol: { wormhole: 1 },
    bridgesUnread: ["sui"],
  },
});
check(
  "a chain whose vaults went unread is kept out of the no-bridge-holds-it claim",
  !/ни один отслеживаемый мост[^.]*Sui/.test(suiSupplyUnverified)
);
check(
  "the chain that WAS checked still carries that claim",
  /ни один отслеживаемый мост[^.]*Cronos/.test(suiSupplyUnverified)
);
check("and the unread one says what is actually unknown", suiSupplyUnverified.includes("Сколько лежит в остальных, неизвестно"));
// Named, not hand-waved: Wormhole IS read there, and the coin simply is not
// in its registry. "No vault is read here" would be the old lie in reverse.
check("it names the bridge that was checked", suiSupplyUnverified.includes("проверен только Wormhole"));
// The caveat now sits beside the number it qualifies, so repeating it in the
// scope block put the same warning twice in one report.
check(
  "the warning is not repeated once the supply line carries it",
  suiSupplyUnverified.split("проверен только Wormhole").length === 2
);
// Without a captured reason the old two-way split still stands.
const supplyWithoutReason = renderLiquidityReport({
  symbol: "USDC",
  name: "USDC",
  balances: [fakeBalance("ethereum", "wormhole", 8_529_291_000000n)],
  checkedCount: 3,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  supplyOnly: [{ chainKey: "sui", unreadable: true }],
});
check(
  "and falls back to the generic split when it said nothing",
  supplyWithoutReason.includes("контракт не отдаёт выпуск")
);

// Stargate's row is labelled "пул LayerZero" because that is what it is, so
// a chain whose own OFT route mints and whose Stargate pool holds 356 000
// printed both facts under the same protocol name and read as the report
// contradicting itself.
const mintsButStargateHolds = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether",
  balances: [
    fakeBalance("ethereum", "layerzero", 3_151_135_000000n),
    fakeBalance("mantle", "stargate", 356_615_000000n),
  ],
  checkedCount: 4,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1, mantle: 1 },
  nativeOftChains: ["mantle"],
});
check(
  "a chain that mints still says its Stargate pool holds something",
  mintsButStargateHolds.includes("Stargate") && /Mantle/.test(mintsButStargateHolds)
);
check(
  "and separates the token's own route from the shared vault",
  mintsButStargateHolds.includes("собственный маршрут")
);

// The reverse: nothing to reconcile, so nothing is said.
const mintsAndNothingElse = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether",
  balances: [fakeBalance("ethereum", "layerzero", 3_151_135_000000n)],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  nativeOftChains: ["mantle"],
});
check(
  "a minting chain with no Stargate pool says nothing about one",
  !mintsAndNothingElse.includes("собственный маршрут")
);

// A chain where one read of twenty failed still has its data in the report,
// so calling it unchecked tells the user their numbers are missing when they
// are printed right above.
const partialReport = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether USDt",
  balances: [
    fakeBalance("ethereum", "wormhole", 3_820_756_000000n),
    fakeBalance("ethereum", "hyperlane", 492_987_000000n),
    fakeBalance("base", "hyperlane", 6_887_000000n),
  ],
  checkedCount: 25,
  failuresByChain: { ethereum: 2, avalanche: 3 },
  attemptsByChain: { ethereum: 20, base: 2, avalanche: 3 },
});
check(
  "a chain that answered partially is not reported as unchecked",
  !/Не ответили совсем:[^\n]*Ethereum/.test(partialReport),
  partialReport.split("\n").find((l) => l.includes("Не ответили совсем")) ?? "(нет строки)"
);
check(
  "a partially read chain is named as incomplete, with counts",
  /Ответили не полностью:[^\n]*Ethereum \(2 из 20\)/.test(partialReport),
  partialReport.split("\n").find((l) => l.includes("не полностью")) ?? "(нет строки)"
);
check(
  "a chain where every read failed is reported as unreachable",
  /Не ответили совсем:[^\n]*Avalanche/.test(partialReport)
);
check("the partially read chain still shows its balances", partialReport.includes("3 820 756") || partialReport.includes("3 820 756"));
check("an empty report never claims a chain failed", !emptyReport.includes("не удалось"));

// A native OFT holds nothing anywhere by design. Reporting that as "not
// bridged" is not a softer wording of the same fact, it is the wrong answer.
const oftReport = renderLiquidityReport({
  symbol: "TAC",
  name: "TAC Protocol",
  balances: [],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { bsc: 2 },
  nativeOftChains: ["bsc", "ethereum"],
});
check("a native OFT is explained, not called unbridged", !oftReport.includes("не заведён"));
check("a native OFT report says there is no custody contract", oftReport.includes("нет контракта-хранилища"));
check("a native OFT report names the chains", oftReport.includes("BNB Chain") && oftReport.includes("Ethereum"));

// PENGU, exactly: five EVM chains all minting, and every token behind them
// locked in one Solana account. Saying only "nothing is held on those five"
// reads as "this token has no liquidity", which is the opposite of true.
const anchored = renderLiquidityReport({
  symbol: "PENGU",
  name: "Pudgy Penguins",
  balances: [fakeBalance("solanamainnet", "layerzero", 41_000_000_000000n)],
  checkedCount: 6,
  failuresByChain: {},
  attemptsByChain: {},
  nativeOftChains: ["bsc", "ethereum"],
});
check("a minting OFT report points at where the collateral is", anchored.includes("Заблокированный запас LayerZero"));
check("and names the chain holding it", /Заблокированный запас LayerZero[^\n]*Solana/.test(anchored));
// With nothing found, there is no anchor to name and no claim to make.
check("no anchor is claimed when none was found", !oftReport.includes("Заблокированный запас"));

const syntheticReport = renderLiquidityReport({
  symbol: "XYZ",
  name: "Example",
  balances: [],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: {},
  syntheticHyperlaneChains: ["base"],
});
check("a synthetic warp route is reported as existing", syntheticReport.includes("синтетические"));
check("a synthetic route report does not call the token unbridged", !syntheticReport.includes("не заведён"));

const trulyNothing = renderLiquidityReport({
  symbol: "NADA",
  name: "Nothing At All",
  balances: [],
  checkedCount: 3,
  failuresByChain: {},
  attemptsByChain: {},
});
check("a token with no bridge at all still says so plainly", trulyNothing.includes("не заведён"));
// It used to end by telling the reader to edit config/layerzero-lockboxes.json.
// The reader of this report is whoever asked whether they can withdraw; the
// repository belongs to whoever runs the bot.
check("and shows how to check a suspected adapter", trulyNothing.includes("/info"));
check("without sending anyone into the source tree", !trulyNothing.includes("layerzero-lockboxes.json"));

// "Checked 2 contracts" with no explanation invites exactly one question,
// so the report answers it before it is asked.
const scoped = renderLiquidityReport({
  symbol: "GRAM",
  name: "Gram",
  balances: [fakeBalance("ethereum", "wormhole", 49_468_000000n)],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1, bsc: 1 },
  scope: {
    supportedChains: ["Ethereum", "BNB Chain"],
    unsupportedPlatforms: ["TON"],
    byProtocol: { wormhole: 2, hyperlane: 0, layerzero: 0 },
  },
});
check("the report breaks down where its contracts came from", scoped.includes("Откуда взялись контракты"));
check("it names the counts per bridge", scoped.includes("Wormhole — 2 сети"));
// A bridge that contributed nothing is left out rather than listed as zero:
// with five bridges, a line of zeroes buries the one number that matters.
check("and leaves out the bridges that contributed nothing", !scoped.includes("Hyperlane — 0"));
check("it names the networks CoinGecko listed", scoped.includes("Ethereum, BNB Chain"));
check("it names networks outside the bot's coverage", scoped.includes("TON"));
check("the scoped report still fits the message limit", scoped.length < 4096);

// A bridge that was asked and holds nothing looked exactly like a bridge the
// bot does not implement, which is how "Stargate carries PENGU" came back as
// a parsing bug: Stargate's site routes it, Stargate's pools never held it.
const asked = renderLiquidityReport({
  symbol: "GRAM",
  name: "Gram",
  balances: [fakeBalance("ethereum", "hyperlane", 49_468_000000n)],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  scope: {
    supportedChains: ["Ethereum"],
    unsupportedPlatforms: [],
    byProtocol: { hyperlane: 1 },
    checkedProtocols: ["wormhole", "hyperlane", "layerzero", "stargate", "across", "ccip"],
    notFoundNotes: { stargate: "пулы только под USDC, USDT." },
  },
});
check("the report names the bridges it asked and found nothing on", asked.includes("Проверены, но своих хранилищ"));
check("and lists them by name", asked.includes("Stargate") && asked.includes("CCIP"));
check("it does not list a bridge that did contribute", !/хранилищ[^\n]*Hyperlane/.test(asked));
check("a known reason for the gap is printed", asked.includes("пулы только под USDC, USDT."));

// The complaint verbatim: "it does not parse all the bridges, Stargate is
// there and it only shows Hyperlane". Stargate's site does carry PENGU - and
// Stargate's published deployments contain no PENGU contract at all, because
// it routes the token through the token's own LayerZero adapter, which is
// the row already in the report holding two and a half billion of it. The
// number was never missing; it was unlabelled, and the note said only that
// Stargate's own pools cover other assets.
const penguLike = [
  fakeBalance("solanamainnet", "layerzero", 2_537_536_755_001500n),
  fakeBalance("solanamainnet", "hyperlane", 2_067_538600n),
];
const pointed = stargateNote(penguLike);
check("the note says Stargate does carry the token", /возит/.test(pointed), pointed);
check("and points at the row that holds the number", /строка LayerZero/.test(pointed));
check("naming the chain it is on", /Solana/.test(pointed), pointed);
// The opposite misreading is worse: a reader must not go looking for a
// second pile of Stargate liquidity that does not exist.
check("and saying it is the same money, not more of it", /те же деньги/.test(pointed));
// With no LayerZero row there is nothing to point at, and the note must not
// claim there is.
check(
  "with nothing to point at it stays general",
  !/строка LayerZero/.test(stargateNote([fakeBalance("ethereum", "hyperlane", 1n)]))
);
check("a LayerZero row holding zero is not pointed at either", !/строка LayerZero/.test(stargateNote([fakeBalance("ethereum", "layerzero", 0n)])));
check("and the assets Stargate does have pools for are still named", /USDC/.test(stargateNote([])));
// And it must not send anyone to a row that is not there: on a token where
// nothing was found there is no LayerZero line to look at.
check("with nothing found it says there is nothing to carry", /нечем/.test(stargateNote([])));

// Two contracts of one bridge on one chain can carry the same note. USDT's
// report showed "LayerZero (OFT Adapter) USDT0" twice on Ethereum, 3.1
// billion against 25 million, with nothing to say which was which.
const sameNoteAdapters = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether",
  balances: [
    { protocol: "layerzero", chainKey: "ethereum", custodyAddress: "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee", tokenAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7", note: "USDT0", amount: 3_186_119_993_856100n, decimals: 6 },
    { protocol: "layerzero", chainKey: "ethereum", custodyAddress: "0x1234567890AbcdEF1234567890aBcdef12345678", tokenAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7", note: "USDT0", amount: 25_258_466_654600n, decimals: 6 },
  ],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { ethereum: 2 },
});
check("two rows sharing a note are told apart by address", sameNoteAdapters.includes("…7Fa41dee".slice(0, 7)) || /…[0-9a-fA-F]{6}/.test(sameNoteAdapters), sameNoteAdapters.slice(0, 400));
check("and both amounts still appear", sameNoteAdapters.includes("3 186 119 993,8561") && sameNoteAdapters.includes("25 258 466,6546"));

// A single row needs no address: the note alone is unambiguous, and a tail
// on every line is noise.
const loneNoteAdapter = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether",
  balances: [
    { protocol: "layerzero", chainKey: "ethereum", custodyAddress: "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee", tokenAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7", note: "USDT0", amount: 1n, decimals: 6 },
    { protocol: "wormhole", chainKey: "ethereum", custodyAddress: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585", tokenAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: 2n, decimals: 6 },
  ],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { ethereum: 2 },
});
check("a note that appears once carries no address tail", !/…[0-9a-fA-F]{6}/.test(loneNoteAdapter));

// A chain's own coin has no contract address anywhere, and every lookup here
// starts from one. SOL's report found a single route and said nothing about
// why - which reads as a bot that failed rather than a question it cannot
// ask that way.
const nativeCoin = renderLiquidityReport({
  symbol: "SOL",
  name: "Solana",
  balances: [fakeBalance("ethereum", "hyperlane", 74500000n)],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  scope: { supportedChains: [], unsupportedPlatforms: [], byProtocol: { hyperlane: 1 }, noTokenAddresses: true },
});
check("a coin with no contract anywhere is explained", /собственная монета сети/.test(nativeCoin));
check("and an ordinary token is not", !/собственная монета сети/.test(scopedWith(1, 1)));

// "1 адаптер ... они не подтвердили" - the number disagreed with the verb.
const oneSkipped = renderLiquidityReport({
  symbol: "T", name: "Test",
  balances: [fakeBalance("ethereum", "hyperlane", 1n)],
  checkedCount: 1, failuresByChain: {}, attemptsByChain: { ethereum: 1 },
  mismatchedAdapters: 1,
});
check("one skipped adapter reads in the singular", /он не подтвердил, что держит/.test(oneSkipped));
const twoSkipped = renderLiquidityReport({
  symbol: "T", name: "Test",
  balances: [fakeBalance("ethereum", "hyperlane", 1n)],
  checkedCount: 1, failuresByChain: {}, attemptsByChain: { ethereum: 1 },
  mismatchedAdapters: 2,
});
check("and two in the plural", /они не подтвердили, что держат/.test(twoSkipped));
// Without the caller vouching for what it asked, the report must not invent
// a list of bridges it cannot stand behind.
check("no such line when the caller did not say what it checked", !scoped.includes("Проверены, но своих хранилищ"));

// --- The registry's Solana shape, verbatim from /lzprobe PENGU --------------
//
// Two things here defeat the EVM reading of the same data, and both cost a
// deploy to find out: `address` is the SPL mint rather than a contract, and
// `type` says "OFT" on the entry that publishes the account holding every
// token the five EVM chains have ever minted against.
const penguRegistry = [
  {
    name: "Pudgy Penguins",
    sharedDecimals: 6,
    endpointVersion: "v2",
    deployments: {
      abstract: { address: "0x9ebe3a824ca958e4b3da772d2065518f009cba62", localDecimals: 18, type: "OFT" },
      ethereum: { address: "0x6418c0dd099a9fda397c766304cdd918233e8847", localDecimals: 18, type: "OFT" },
      solana: {
        address: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
        localDecimals: 6,
        details: {
          innerTokenProgramId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          oftProgramId: "EfRMrTJWU2CYm52kHmRYozQNdF8RH5aTi3xyeSuLAX2Y",
          escrowTokenAccount: "8qytKBooPvD4Q7vdrKnjKmiweShS4D5mPzsgQc6HqgvX",
          oftPDA: "qMNo1RFo11J9ZLGuq7dVmWAssuCZaNsSamk8g2q4UZA",
        },
        type: "OFT",
      },
    },
  },
];

// LayerZero's own name for a chain is not derivable from ours: Linea is
// "zkconsensys" in its registry, Polygon zkEVM is "zkpolygon", Plume is
// "plumephoenix". Ten chains the bot has an RPC for were losing every
// deployment on them to a name lookup that could only ever have failed, and
// the report could not say so - a dropped chain and an empty one look the
// same. The chain id both sides publish is what settles it.
const renamedChains = [
  { deployments: { zkconsensys: { address: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585", type: "OFTAdapter" } } },
];
check("our alias table alone cannot match LayerZero's name", extractDeployments(renamedChains).length === 0);
const viaMetadata = extractDeployments(renamedChains, (key) =>
  normaliseLzKey(key) === "zkconsensys" ? "linea" : undefined
);
check("the metadata index finds the chain behind that name", viaMetadata.length === 1);
check("and it lands on our own chain key", viaMetadata[0]?.chainKey === "linea");
check("a name the index does not know is still dropped, not guessed", extractDeployments(renamedChains, () => undefined).length === 0);
check("the key is folded so a -mainnet suffix does not miss", normaliseLzKey("Plume-Phoenix_Mainnet") === "plumephoenix");

// A chain id is only unique among EVM chains. Aptos numbers its own mainnet
// 1 - the number Ethereum uses - so matching on it alone filed Aptos under
// Ethereum and reported it as a chain the bot reads, which is worse than
// leaving it in the gap list. The eid is what tells the two apart.
const collidingIds = extractEids({
  ethereum: { nativeChainId: 1, deployments: [{ eid: 30101 }] },
  aptos: { nativeChainId: 1, deployments: [{ eid: 30108 }] },
});
check("the chain that owns the id keeps its eid", collidingIds.get("ethereum") === 30101);
check("a foreign chain reusing the id does not take it over", collidingIds.size === 1);

const penguSolana = extractNonEvmDeployments(penguRegistry, "solana");
check("the Solana deployment is found", penguSolana.length === 1);
check(
  "its address is carried as the mint, not dropped for not being hex",
  penguSolana[0]?.address === "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv"
);
check(
  "the escrow account the registry publishes is kept",
  penguSolana[0]?.details?.escrowTokenAccount === "8qytKBooPvD4Q7vdrKnjKmiweShS4D5mPzsgQc6HqgvX"
);
// The type field says "OFT", which on every EVM chain means "mints, holds
// nothing". A named escrow outranks it: the registry is stating that this
// deployment locks.
check("a named escrow counts as locking collateral despite the OFT type", penguSolana[0]?.locksCollateral === true);
check("a chain with no entry yields nothing", extractNonEvmDeployments(penguRegistry, "aptos").length === 0);

// Aptos, verbatim from /lzprobe aptos. Four adapters, all locking, and the
// address is a bare object address - no "::" - so the balance is asked for
// as a fungible asset rather than as a coin. Nothing here is EVM-shaped, so
// the EVM reader drops all four and always did.
const aptosRegistry = [
  {
    deployments: {
      aptos: { address: "0xa84a503845236bbb2fc83693cfb25ee4f5dc31e078131c38de8c7d27b65d3243", type: "NATIVE_OFT_ADAPTER" },
    },
  },
];
const aptosDeployments = extractNonEvmDeployments(aptosRegistry, "aptos");
check("an Aptos deployment is found", aptosDeployments.length === 1);
// NATIVE_OFT_ADAPTER locks the chain's own coin; OFT_ADAPTER locks a token.
// Both hold something, and both have to survive the locking filter or the
// chain contributes nothing however well it is read.
check("a native adapter still counts as locking", aptosDeployments[0]?.locksCollateral === true);
check(
  "and so does a plain one",
  extractNonEvmDeployments([{ deployments: { aptos: { address: "0x96", type: "OFT_ADAPTER" } } }], "aptos")[0]
    ?.locksCollateral === true
);
check("the EVM reader still drops it, as it must", extractDeployments(aptosRegistry).length === 0);

// The registry's type field cannot decide this one. Both Aptos deployments
// are filed as adapters; the objects say otherwise, and the objects are
// right. APT's carries oft_adapter_fa with an extend ref to the escrow -
// which held 2 939 APT nobody could see - while USDe's carries oft_fa with
// a mint ref, so it makes its own supply and its zero is the true answer.
const aptAdapter = [
  { type: "0xa84::oft_store::OftStore", data: { shared_decimals: 6 } },
  {
    type: "0xa84::oft_adapter_fa::OftImpl",
    data: { escrow_extend_ref: { self: "0x40e701f7542e15cc594ec406c5f54a08ce114d2fe6f5c5d46d20dd5179dc048e" }, metadata: { inner: "0xa" } },
  },
];
const usdeMinter = [
  { type: "0x967::oft_fa::OftImpl", data: { mint_ref: { metadata: { inner: "0xf37" } }, burn_ref: {}, metadata: { inner: "0xf37" } } },
];
check("an adapter object is read as locking", shapeOfResources(aptAdapter)?.mints === false);
check(
  "and it names the escrow, which no derivation could",
  shapeOfResources(aptAdapter)?.escrow === "0x40e701f7542e15cc594ec406c5f54a08ce114d2fe6f5c5d46d20dd5179dc048e"
);
// The adapter also names what it locks, which is how a chain the price API
// lists no address for gets read at all: WBTC's adapter holds real
// collateral on Aptos and CoinGecko knows nothing about it there, so every
// WBTC report called the chain unread.
check("the adapter names the asset it locks", shapeOfResources(aptAdapter)?.asset === "0xa");
check("a mint ref means the deployment makes its own supply", shapeOfResources(usdeMinter)?.mints === true);
check("and a minting deployment names no escrow", shapeOfResources(usdeMinter)?.escrow === undefined);
check("an object with neither is not guessed at", shapeOfResources([{ type: "0x1::coin::CoinStore", data: {} }]) === undefined);

const penguEscrows = svmEscrows(penguSolana);
check("the escrow is paired with the mint it holds", penguEscrows.length === 1);
check("the account read is the escrow", penguEscrows[0]?.escrow === "8qytKBooPvD4Q7vdrKnjKmiweShS4D5mPzsgQc6HqgvX");
check("and the mint checked against it is the token", penguEscrows[0]?.mint === "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv");
// Without a published escrow there is nothing to read: the account is created
// in its own right and the store is derived from it, so it cannot be derived
// back. Guessing would put an unrelated balance under this ticker.
check(
  "a deployment with no published escrow is not guessed at",
  svmEscrows(extractNonEvmDeployments(penguRegistry, "abstract")).length === 0
);

// A chain the bot cannot read hides its deployments the same way Solana hid
// PENGU's: the missing reader and the empty bridge produce the same silence.
// Counting the registry by chain is what turns that into a list.
const tally = tallyDeploymentsByChain({
  PENGU: penguRegistry,
  USDT: [
    {
      deployments: {
        ethereum: { address: "0x1", type: "OFTAdapter" },
        solana: { address: "Ao", type: "OFT", details: { escrowTokenAccount: "Es" } },
        injective: { address: "inj1", type: "OFT" },
      },
    },
  ],
});
const byKey = (key: string) => tally.find((t) => t.lzChainKey === key);
check("every chain in the registry is counted", byKey("ethereum")?.deployments === 2);
check("a locking deployment is counted as such", byKey("ethereum")?.locking === 1);
check("a published escrow counts as locking", byKey("solana")?.locking === 2);
check("a minting deployment is not counted as locking", byKey("injective")?.locking === 0);
check("chains are ordered by how much sits on them", tally[0].deployments >= tally[tally.length - 1].deployments);

const gaps = gapsFrom(tally);
check("a chain with a reader is not a gap", !gaps.some((g) => g.lzChainKey === "solana"));
check("and neither is an EVM one", !gaps.some((g) => g.lzChainKey === "ethereum"));
// Aptos has its own LayerZero reader now, so it is no longer a gap - but it
// stopped being one once before without being fixed, by being mis-filed
// under Ethereum, so which of the two it is gets asserted rather than
// inferred from its absence.
check("a chain with its own reader is named by that reader", classifyChain({ lzChainKey: "aptos", deployments: 4, locking: 4 }).reader === "aptos");
check("and is therefore not a gap", !gaps.some((g) => g.lzChainKey === "aptos"));
// A chain the bot knows through Hyperlane alone is still a LayerZero gap,
// which is the distinction the command exists to draw.
check(
  "a chain read by another bridge is still a LayerZero gap",
  classifyChain({ lzChainKey: "injective", deployments: 1, locking: 1 }).reader === "нет"
);
check("a gap the bot has no chain for is named as such", classifyChain({ lzChainKey: "sui", deployments: 3, locking: 3 }).reader === "сеть неизвестна");
check("gaps lead with the ones holding collateral", gaps.every((g, i) => i === 0 || gaps[i - 1].locking >= g.locking));

// --- LayerZero OFT registry parsing (real response shape) --------------------

// Exactly the shape the live registry returned for DELABS.
const delabs = [
  {
    name: "Delabs",
    sharedDecimals: 6,
    endpointVersion: "v2",
    deployments: {
      bsc: { address: "0x23ccab1de32e06a6235a7997c266f86440c2cbe6", localDecimals: 18, type: "OFT" },
      klaytn: { address: "0x23ccab1de32e06a6235a7997c266f86440c2cbe6", localDecimals: 18, type: "OFT" },
    },
  },
];
const delabsOut = extractDeployments(delabs);
check("reads a deployment out of the real registry shape", delabsOut.length === 1, `получено=${delabsOut.length}`);
check("maps LayerZero's chain key onto ours", delabsOut[0]?.chainKey === "bsc");
check("skips chains this bot does not support", !delabsOut.some((d) => d.chainKey === "klaytn"));
check(
  "a plain OFT is not treated as holding collateral",
  delabsOut[0]?.locksCollateral === false,
  `type=${delabsOut[0]?.rawType}`
);

const adapterEntry = [
  {
    name: "Example",
    deployments: {
      ethereum: { address: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585", type: "OFTAdapter" },
      arbitrum: { address: "0x0b2402144Bb366A632D14B83F244D2e0e21bD39c", type: "NativeOFTAdapter" },
      base: { address: "не адрес", type: "OFTAdapter" },
      polygon: { address: "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE", type: "SomethingNew" },
    },
  },
];
const adapterOut = extractDeployments(adapterEntry);
check(
  "an adapter is recognised as holding collateral",
  adapterOut.filter((d) => d.locksCollateral).length === 2,
  adapterOut.map((d) => `${d.chainKey}:${d.rawType}:${d.locksCollateral}`).join(" ")
);
check("a malformed address is skipped", !adapterOut.some((d) => d.chainKey === "base"));
check(
  "an unrecognised type is treated as not holding collateral",
  adapterOut.find((d) => d.chainKey === "polygon")?.locksCollateral === false
);
check("a missing ticker yields nothing rather than throwing", extractDeployments(undefined).length === 0);

// -----------------------------------------------------------------------------
// Wormhole on Cosmos. The bot read the Token Bridge everywhere it exists
// except here, and the gap was structural: the Cosmos chain table came from
// Hyperlane's registry alone, so a chain only Wormhole is on had no endpoint
// and its bridge could not be queried at all.
// -----------------------------------------------------------------------------

// Addresses from the SDK, never transcribed - a redeployment arrives with an
// upgrade instead of going unnoticed.
check("the Token Bridge is found on Injective", portalCosmosChain("injective")?.tokenBridge.startsWith("inj1") === true);
check("and on Sei, which Hyperlane's registry does not describe", portalCosmosChain("seicosmos")?.tokenBridge.startsWith("sei1") === true);
check("a chain with no Wormhole deployment is not claimed", portalCosmosChain("osmosis") === undefined);
check(
  "every entry carries a bech32 contract",
  PORTAL_COSMOS_CHAINS.every((c) => /^[a-z]+1[02-9ac-hj-np-z]{6,}$/.test(c.tokenBridge))
);
// A chain Wormhole is on that the bot cannot reach is a gap, and a gap
// nobody can see is indistinguishable from a bridge that holds nothing.
check("and the ones with no endpoint are named rather than dropped", portalCosmosUnreachable().includes("Wormchain"));

// -----------------------------------------------------------------------------
// No two chain tables may claim the same key or the same alias.
//
// A key decides how a row is labelled and which explorer its address is
// linked to, and the lookups walk the tables in a fixed order - so a shared
// key means one chain silently answers for another. Adding Sei to the Cosmos
// table for Wormhole did exactly that: the EVM chain already held "sei", and
// a balance found on the CosmWasm side would have been printed under the EVM
// chain's name with a bech32 address in an EVM explorer link.
//
// Checked as a rule rather than as a case, because the next collision will
// arrive the same way this one did - with a new chain, quietly.
// -----------------------------------------------------------------------------

const chainTables: Array<[string, ReadonlyArray<{ key: string; label: string; aliases?: readonly string[] }>]> = [
  ["EVM", CHAINS],
  ["SVM", SVM_CHAINS],
  ["Cosmos", COSMOS_CHAINS],
  ["Other", OTHER_CHAINS],
  ["Portal", PORTAL_CHAINS],
  ["TON", [{ key: TON_CHAIN.key, label: TON_CHAIN.label, aliases: TON_CHAIN.aliases }]],
];

const keyOwners = new Map<string, string[]>();
const aliasOwners = new Map<string, string[]>();
for (const [table, list] of chainTables) {
  for (const chain of list) {
    keyOwners.set(chain.key, [...(keyOwners.get(chain.key) ?? []), `${table}:${chain.label}`]);
    for (const alias of chain.aliases ?? []) {
      const a = alias.toLowerCase();
      aliasOwners.set(a, [...(aliasOwners.get(a) ?? []), `${table}:${chain.label}`]);
    }
  }
}
const sharedKeys = [...keyOwners].filter(([, owners]) => owners.length > 1);
check("no key is claimed by two chain tables", sharedKeys.length === 0, sharedKeys.map(([k, o]) => `${k}: ${o.join(" | ")}`).join("; "));

const sharedAliases = [...aliasOwners].filter(([, owners]) => new Set(owners).size > 1);
check("and no alias is pulled by two", sharedAliases.length === 0, sharedAliases.map(([a, o]) => `${a}: ${[...new Set(o)].join(" | ")}`).join("; "));

// A key in one table that another table hands out as an alias is the same
// bug wearing a different hat: whoever the resolver reaches first wins.
const crossed = [...keyOwners].filter(([key, owners]) => (aliasOwners.get(key.toLowerCase()) ?? []).some((o) => !owners.includes(o)));
check("nor is one table's key another's alias", crossed.length === 0, crossed.map(([k]) => k).join(", "));

// And the rename must not have lost the bridge it was made for.
check("Sei's Token Bridge survived being renamed", PORTAL_COSMOS_CHAINS.some((c) => c.wormholeChain === "Sei"));
check("under a label that says which Sei it is", chainMeta("seicosmos")?.label === "Sei (Cosmos)");
check("and links to a Cosmos explorer", (chainMeta("seicosmos")?.explorerAddressUrl("sei1abc") ?? "").includes("sei1abc"));

// A bridge that mints on a chain where other bridges do hold something. The
// closing note covers only chains with no rows at all, so on a chain with
// rows the fact was dropped entirely - and "CCIP mints on Solana" is not
// something a reader can infer from its absence.
const mintsBeside = renderLiquidityReport({
  symbol: "PIPPIN",
  name: "pippin",
  balances: [fakeBalance("solanamainnet", "hyperlane", 5_000000n)],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { solanamainnet: 2 },
  mintsOnly: [{ chainKey: "solanamainnet", protocol: "ccip" }],
});
check("a minting bridge is marked on the chain it mints on", /чеканит, не держит/.test(mintsBeside), mintsBeside);
check("and is not repeated in the closing note", !/Мост чеканит, а не держит/.test(mintsBeside));

// With no rows of its own the chain gets no block, so the note is the only
// place the fact can go.
const mintsAlone = renderLiquidityReport({
  symbol: "PIPPIN",
  name: "pippin",
  balances: [fakeBalance("ethereum", "hyperlane", 5_000000n)],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  mintsOnly: [{ chainKey: "solanamainnet", protocol: "ccip" }],
});
check("a chain with nothing else is named in the closing note", /Мост чеканит, а не держит/.test(mintsAlone));
// It must never be called an empty vault: an empty vault might fill, a
// mint-burn deployment never holds anything at all.
check("and never as a vault standing empty", !/хранилища пусты[^\n]*Solana/.test(mintsAlone));

// A key that had to be qualified must be qualified where people read it too:
// a unique key nobody can see is half a fix.
check("a suffixed key carries a qualified label", qualifiedLabel("Injective", "injectiveevm", "injective") === "Injective (EVM)");
check("and an untouched key is left alone", qualifiedLabel("Base", "base", "base") === "Base");

// -----------------------------------------------------------------------------
// Hyperlane ships the team's own test deployments beside the real ones and
// flags neither. Four of them run on mainnets - oUSDT/staging across
// seventeen of them, three moonpay-staging routes across six - so their
// contracts were read and printed as liquidity: "USDT/moonpay-staging:
// 1 USDT" on Katana, real tokens on a route nobody bridges through. That is
// the lie a testnet in the chain table tells, one level down.
// -----------------------------------------------------------------------------

check("a staging deployment is not production", isProductionRoute("USDT/moonpay-staging") === false);
check("nor is one simply called staging", isProductionRoute("oUSDT/staging") === false);
check("nor a testnet route", isProductionRoute("USDT/aleotestnet") === false);
check("nor one on a public testnet by name", isProductionRoute("USDC/predicate-sepolia-basesepolia") === false);
// Judged on the deployment half, never the ticker: a token may legitimately
// be called REZSTAGING, and dropping it because of its own name would hide
// the one route somebody asking for that ticker wants.
check("a ticker containing the word is not a staging route", isProductionRoute("REZSTAGING/base-ethereum-unichain") === true);
// The registry's own naming says the distinction is real.
check("and the production twin is kept", isProductionRoute("oUSDT/production") === true);
check("as are ordinary routes", isProductionRoute("USDT/krown") && isProductionRoute("USDT/eclipsemainnet"));
check("a route id with no deployment part is still judged", isProductionRoute("sepolia") === false);

// The real registry, so a rename upstream shows up here rather than in a
// report. Silently dropping every route would look exactly like a clean one.
check("the real registry still has routes after filtering", hyperlaneRouteCount() > 250, `${hyperlaneRouteCount()}`);
check("and the test ones were actually found and dropped", hyperlaneSkippedRoutes() > 20, `${hyperlaneSkippedRoutes()}`);
const liveRoutes = Object.keys(loadHyperlaneRegistry());
check("no staging route survives into the registry the bot reads", !liveRoutes.some((id) => !isProductionRoute(id)));
check("while the routes the report is built from are still there", liveRoutes.includes("oUSDT/production"));

// -----------------------------------------------------------------------------
// The shared vaults could only be asked about a token they were given an
// address for, and that address came from the price API alone. For USDT the
// price API lists five EVM chains, so Across was asked on two of the
// twenty-seven it is deployed on and the USDT it holds on Arbitrum, Base,
// Optimism and Polygon never reached the report - on a token whose whole
// report is about where the liquidity is.
//
// The addresses were in hand the entire time: an OFT adapter names the
// ERC-20 it locks and a Stargate pool names the token it holds, each already
// confirmed against the contract before it earned a row.
// -----------------------------------------------------------------------------

const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
const USDT_ARB = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address;
const SOMETHING_ELSE = "0x3333333333333333333333333333333333333333" as Address;

const listed = tokenByChainFrom([
  { chainKey: "ethereum", platformName: "Ethereum", tokenAddress: USDT_ETH },
  { chainKey: "avalanche", platformName: "Avalanche", tokenAddress: USDT_ETH },
]);
check("the price API's own chains are the starting point", listed.size === 2);

const widened = withCustodianTokens(listed, [
  { chainKey: "arbitrum", tokenAddress: USDT_ARB },
  { chainKey: "base", tokenAddress: USDT_ARB },
  { chainKey: "ethereum", tokenAddress: SOMETHING_ELSE },
]);
check("a chain a bridge confirmed is added", widened.get("arbitrum") === USDT_ARB);
check("and so is the next one", widened.get("base") === USDT_ARB);
check("so the vault lookup reaches four chains instead of two", widened.size === 4);
// The price API is the one source tied to the ticker a person typed, so a
// bridge naming something else on a chain it already covers must not
// redirect the vault lookup there.
check("but it never overwrites what the price API said", widened.get("ethereum") === USDT_ETH);
check("and the original map is left alone", listed.size === 2);
check("nothing to add is not a change", withCustodianTokens(listed, []).size === 2);

// Before the first sweep nothing has been measured, and a chain with no
// measurements looks exactly like a chain where nothing answered. Skipping
// on that would skip the entire table on a fresh boot - so only a chain that
// was actually asked and said nothing counts as unreachable.
check("an unmeasured chain is not called unreachable", isUnreachable("ethereum") === false);

// The first screen anyone sees, and it was contradicting the rest of the bot.
// Its chain total left TON out while its own breakdown counted it, so the
// sum came out one short of its parts and one short of /sources - and it
// described LayerZero as a handful of adapters kept by hand, on a bot that
// reads a registry of three hundred and fifty-eight tickers.
const help = helpText();
const totalInHelp = Number(/Сетей сейчас (\d+)/.exec(help)?.[1]);
const partsInHelp = [...help.matchAll(/(\d+) (?:EVM|на VM Solana|Cosmos|прочих)/g)].reduce((n, m) => n + Number(m[1]), 0);
check("the help's chain total matches its own breakdown", totalInHelp === partsInHelp, `итого=${totalInHelp} по частям=${partsInHelp}`);
// TON and Sui are the two that have no table of their own: one chain each,
// counted by hand. Sui joined the total the day its vaults became readable -
// the count means "chains whose bridge vaults are read", and leaving it out
// would have the first screen deny a balance the report prints.
check("and counts every table the bot reads", totalInHelp === CHAINS.length + SVM_CHAINS.length + COSMOS_CHAINS.length + OTHER_CHAINS.length + PORTAL_CHAINS.length + 2);
// The claim that stopped being true, not the words: the other bridges on
// Sui genuinely are unread, and the help still says so.
check("the help no longer says Sui gives only a supply", !help.includes("читает только выпуск токена"));
check("and says what it does read there", help.includes("реестр токенов Wormhole"));
// Understating the product on its own front page is its own kind of wrong
// answer: every address comes from a bridge's registry, none by hand.
check("it does not claim the adapters are kept by hand", !/вручную в конфиге/.test(help));
check("it names the registries the addresses come from", /реестр OFT/.test(help) && /деплои Stargate/.test(help) && /справочник Chainlink/.test(help));
// And it must not promise balances the bot does not read.
check("CCTP is described as identified, not measured", /CCTP/.test(help) && /хранилища у него нет/.test(help));
// A list typed beside the table it describes drifts the moment the table
// moves, invisibly: /other promised three chains while its table held four.
// Both lists are built from the tables now, so this asserts they stay built.
for (const chain of OTHER_CHAINS) {
  check(`/other names ${chain.label}, which its table holds`, help.includes(chain.label));
}
for (const chain of PORTAL_CHAINS) {
  check(`/portal names ${chain.label}`, help.includes(chain.label));
}

// The address card spells the queried address checksummed and the peers
// lowercased, because a peer arrives as the low 20 bytes of a bytes32 slot.
// One card spelling addresses two ways reads as two kinds of address, and
// the peers are the half somebody copies out to look up next.
const adapterCard = formatInfoCard("ethereum", "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee" as Address, [
  {
    protocol: "layerzero",
    confidence: "high",
    role: "OFT Adapter",
    facts: [["Заблокировано", "3 186 989 757,693 USDT"]],
    peers: [{ chainLabel: "Arbitrum One", remoteId: 30110, peerAddress: "0x14e4a1b13bf7f943c8ff7c51fb60fa964a298d92" }],
    notes: [],
  },
]);
check(
  "a peer address is shown checksummed",
  adapterCard.includes("0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92"),
  adapterCard
);
check("and the locked balance earns its place on the card", adapterCard.includes("Заблокировано"));

// The fallback advice is read by whoever asked whether they can withdraw,
// not by whoever runs the bot. It used to end "add the address to
// config/layerzero-lockboxes.json" - a repository that reader does not have.
const nothingFound = renderLiquidityReport({
  symbol: "ZRX",
  name: "0x Protocol",
  balances: [],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { ethereum: 2 },
});
check("the advice does not send a trader into the repository", !/lockboxes\.json/.test(nothingFound), nothingFound);
check("but still shows them how to check a contract themselves", /\/info/.test(nothingFound));
check("and says who makes it permanent", /владелец бота/.test(nothingFound));

// "The bot does not check Energi" reads as a permanent property of the bot.
// It is a property of a table that is discovered and grows: one report said
// exactly that about Energi while another, after the next scan, read its
// supply.
const unchecked = renderLiquidityReport({
  symbol: "UNI",
  name: "Uniswap",
  balances: [fakeBalance("ethereum", "wormhole", 1n)],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
  scope: { supportedChains: ["Ethereum"], unsupportedPlatforms: ["Energi", "Sora"], byProtocol: { wormhole: 1 } },
});
check("an absent chain is described as absent from the table", /нет в таблице/.test(unchecked), unchecked);
check("and never as something the bot refuses to check", !/бот их не проверяет/.test(unchecked));
check("with a command that explains why", /\/chains/.test(unchecked));

// -----------------------------------------------------------------------------
// A synthetic route holds nothing, and on the Cosmos family it was being read
// as collateral: their standards are CosmosNativeHypCollateral and
// CosmosNativeHypSynthetic, so the synthetic one matched the "Native" in the
// middle of its own name. USDC's Celestia route is one, with no collateral
// denom of its own - so the reader fell back to the chain's coin and printed
// the Hyperlane module's TIA balance under the ticker USDC. The same number,
// 92.6785, appeared in the TIA report as TIA and in the USDC report as USDC.
// -----------------------------------------------------------------------------

check("a Cosmos synthetic is not read as collateral", routeHoldsCollateral("CosmosNativeHypSynthetic") === false);
check("though its collateral sibling still is", routeHoldsCollateral("CosmosNativeHypCollateral") === true);
check("and so are the CosmWasm ones", routeHoldsCollateral("CwHypCollateral") && routeHoldsCollateral("CwHypNative"));
// Every VM names the thing the same way, so the word is refused everywhere.
check("a Sealevel synthetic too", routeHoldsCollateral("SealevelHypSynthetic") === false);
check("and an EVM one", routeHoldsCollateral("EvmHypSynthetic") === false);
check("while the EVM collateral kinds pass", routeHoldsCollateral("EvmHypCollateral") && routeHoldsCollateral("EvmHypNative"));
check("an unknown standard holds nothing until it says so", routeHoldsCollateral(undefined) === false);

// Against the real registry, because the trap was in real data: the token
// whose route printed somebody else's balance must no longer have one there,
// and the token that legitimately escrows on that chain must keep all of its.
const celestiaUsdc = findNativeModuleRoutes("USDC").filter((r) => r.chainKey === "celestia");
check("USDC no longer claims a module route on Celestia", celestiaUsdc.length === 0, celestiaUsdc.map((r) => r.routeId).join(", "));
const celestiaTia = findNativeModuleRoutes("TIA").filter((r) => r.chainKey === "celestia");
check("while TIA keeps its collateral routes there", celestiaTia.length > 0 && celestiaTia.every((r) => r.denom === "utia"));
// These two name no collateral denom and genuinely escrow the chain's own
// coin, so the fallback that caused the bug is right for them and must stay.
check("a collateral route that names no denom still falls back to the chain coin", findNativeModuleRoutes("KYVE").some((r) => r.denom === "ukyve"));

// "CoinGecko знает токен в сетях: Paradex" - about ETH, which the price API
// lists nowhere. The line was built from the chains rows were found on, so a
// Hyperlane route on Paradex became a claim the price API never made. It is
// about who listed what; a row found through a bridge's own registry is
// already in the report above.
const listedBoth = listedChains({
  platforms: [
    { chainKey: "ethereum", platformName: "Ethereum", tokenAddress: USDT_ETH },
    { chainKey: undefined, platformName: "Tezos", tokenAddress: USDT_ETH },
  ],
  otherPlatforms: [
    { chainKey: "solanamainnet", platformName: "Solana", tokenAddress: "So111" },
    { chainKey: TON_CHAIN.key, platformName: "TON", tokenAddress: "0:abc" },
    { chainKey: undefined, platformName: "Sui", tokenAddress: "0xsui" },
  ],
});
check("both halves of the price API's answer are listed", listedBoth.includes("Ethereum") && listedBoth.includes("Solana") && listedBoth.includes("TON"), listedBoth.join(", "));
// A platform the bot cannot read is not in this line - it has its own.
check("a platform the bot does not support is left out", !listedBoth.includes("Tezos") && !listedBoth.includes("Sui"));
// The whole point: nothing enters this line except what the price API said.
check("a token listed nowhere claims nothing", listedChains({ platforms: [], otherPlatforms: [] }).length === 0);

// -----------------------------------------------------------------------------
// A report narrowed to one network is about that network. Left whole, its
// chain lists spoke for the others - and the mint-only list is filtered
// against the chains that have a LayerZero row, which come from the balances
// the filter has already cut down. So /info USDT ton called Arbitrum
// mint-only while the full report showed six million USDT in an adapter
// there: two reports from one bot contradicting each other, the narrow one
// wrong.
// -----------------------------------------------------------------------------

const narrowed = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether",
  balances: [fakeBalance("ton", "layerzero", 2_018_260_742200n)],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: {},
  // What the caller now hands it: only the chain in scope.
  nativeOftChains: [],
  syntheticHyperlaneChains: [],
  scope: {
    supportedChains: [],
    unsupportedPlatforms: [],
    byProtocol: { layerzero: 1 },
    checkedProtocols: ["wormhole", "hyperlane", "layerzero", "stargate", "across", "ccip"],
    singleChain: "TON",
  },
});
check("a one-network report says its gaps are that network's", /в этой сети \(TON\)/.test(narrowed), narrowed);
check("and not a claim about the ticker everywhere", !/под этот тикер не нашлось/.test(narrowed));
// The wide report keeps the wide wording, because there it is true.
const wholeToken = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether",
  balances: [fakeBalance("ethereum", "layerzero", 1n)],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: {},
  scope: {
    supportedChains: [],
    unsupportedPlatforms: [],
    byProtocol: { layerzero: 1 },
    checkedProtocols: ["wormhole", "layerzero"],
  },
});
check("a whole-token report still speaks for the token", /под этот тикер не нашлось/.test(wholeToken));

// /track and /info both sweep every chain when no network is named, and they
// did it with two copies of one loop - which is how one came to be bounded
// and the other left as it was. One scan now, so the next change lands in
// both. What it must always say is the shortfall: "not found on any chain"
// and "not looked at on all of them" are different answers.
const answered = (n: number) => Array.from({ length: n }, (_, i) => ({ chain: `c${i}`, outcome: { results: [] } }));
const names = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`);

check(
  "a complete sweep claims no shortfall",
  scanShortfall({ perChain: answered(250), reachable: 250, timedOut: [], unreachable: [], total: 250 }) === ""
);
check(
  "chains that answer nothing are counted out loud",
  /22 не отвечают совсем/.test(
    scanShortfall({ perChain: answered(228), reachable: 228, timedOut: [], unreachable: names(22), total: 250 })
  )
);
check(
  "and so are the ones that ran out of time",
  /5 не уложились/.test(
    scanShortfall({ perChain: answered(245), reachable: 250, timedOut: names(5), unreachable: [], total: 250 })
  )
);
// The count is of what actually came back, not of what was set out for -
// a timeout is neither an answer nor a refusal, and counting it as either
// put 249 beside 229 in adjacent lines of one report.
check(
  "with the count of what was actually looked at",
  /Просмотрено 223 сетей из 250/.test(
    scanShortfall({ perChain: answered(223), reachable: 228, timedOut: names(5), unreachable: names(22), total: 250 })
  )
);

// The report's own arithmetic. Its numerator came from the scan and its
// denominator from the chain table as it stood when the message was built -
// and the table is discovered in the background and keeps growing, so
// "checked 121 of 252" appeared above a list naming twenty-one unchecked
// chains, leaving a hundred and ten networks accounted for nowhere. There
// were 142 chains when that sweep began.
const scan142 = {
  perChain: answered(142),
  reachable: 142,
  timedOut: [] as string[],
  unreachable: [] as string[],
  total: 142,
};
const acc = scanAccounting(scan142, ["c0", "c1", "c2"]);
check("what was checked and what was not add up to the table", acc.checked + acc.unchecked.length === acc.total, `${acc.checked}+${acc.unchecked.length}≠${acc.total}`);
check("the denominator is the table the sweep walked", acc.total === 142);
check("a chain that refused counts as unchecked", acc.unchecked.includes("c0") && acc.checked === 139);

// And with every kind of shortfall at once, the sum still holds.
const messy = scanAccounting(
  { perChain: answered(200), reachable: 220, timedOut: names(20), unreachable: names(30), total: 250 },
  ["c0", "c1"]
);
check("the sum holds with refusals, timeouts and silent chains together", messy.checked + messy.unchecked.length === messy.total, `${messy.checked}+${messy.unchecked.length}≠${messy.total}`);

// LayerZero's two sources disagree: the OFT registry files deployments on
// chains its own metadata does not describe, so the id lookup has nothing to
// match on and the short names it uses are not what anyone else calls them.
// Seven deployments the registry itself marks as holding collateral were
// invisible in every report because of it - /lzgaps is what found them.
// Each entry names a chain id, so it can only ever point at a chain the bot
// already has, and it stops mattering the day the metadata publishes the name.
for (const [name, chainId] of [
  ["etherlink", 42793],
  ["xdc", 50],
  ["sanko", 1996],
  ["apexfusionnexus", 9069],
  ["goat", 2345],
  ["iota", 8822],
  ["glue", 1300],
] as const) {
  check(`the registry's name for ${name} carries its chain id`, REGISTRY_CHAIN_IDS[name] === chainId);
}
check("and every entry is a chain id, never a chain key", Object.values(REGISTRY_CHAIN_IDS).every((v) => typeof v === "number" && v > 0));

// A raw includes() matched ENI Mainnet against "plumephoenix" - the letters
// e-n-i sit inside "phoenix" - and the report then said ENI has eid 30370
// and the matching is fixable, about Plume. A wrong lead in a diagnostic is
// worse than none: it is the one the reader will follow.
extractEids({
  "plumephoenix-mainnet": { chainDetails: { nativeChainId: 98866 }, deployments: [{ eid: 30370 }] },
});
check(
  "a name is not matched on a substring inside another word",
  /в метаданных этой сети нет/.test(explainMissing("eni", 999111)),
  explainMissing("eni", 999111)
);
// The segment match still has to work, or every explanation becomes "absent".
extractEids({ "etherlink-mainnet": { chainDetails: { nativeChainId: 42793 }, deployments: [{ eid: 30292 }] } });
check("but a whole segment still matches", /есть как «etherlink-mainnet»/.test(explainMissing("etherlink", 999111)));
// The id is still the strongest signal and outranks any name.
check("and the chain id wins over the name", /есть как «etherlink-mainnet»/.test(explainMissing("somethingelse", 42793)));

// -----------------------------------------------------------------------------
// The mapping is rebuilt against the table as it stands, not frozen when the
// payload arrived. The metadata is fetched at startup and cached for six
// hours while the chain table is discovered in the background and takes
// minutes to fill - so a mapping built at parse time answered for two
// hundred and fifty chains having been built against forty. Forty-eight
// chains had an eid sitting in the payload, under a name matching theirs,
// and no eid as far as the bot was concerned. The peer walk cannot go where
// there is no eid.
// -----------------------------------------------------------------------------

// Its own number: 987_654_321 belongs to the registration test further down.
const laterChainId = 912_345_678;
const payloadWithLateChain = {
  "latecomer-mainnet": { chainDetails: { nativeChainId: laterChainId }, deployments: [{ eid: 30999 }] },
};

// Parsed while the bot does not have the chain: nothing to map it to.
check("a chain the table lacks gets no eid", extractEids(payloadWithLateChain).size === 0);

// The chain arrives afterwards, the way discovery adds them.
registerChain({
  key: "latecomer",
  label: "Latecomer",
  viemChain: {
    id: laterChainId,
    name: "Latecomer",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://latecomer.example"] } },
  } as never,
  rpcEnvVar: "LATECOMER_RPC_URL",
  defaultRpcUrls: ["https://latecomer.example"],
  explorerTxUrl: () => "",
  explorerAddressUrl: () => "",
  aliases: ["latecomer"],
  platformNames: ["Latecomer"],
});

// Without re-reading the payload, the same facts now resolve.
check(
  "and picks one up once the table has it, with no new download",
  extractEids(payloadWithLateChain).get("latecomer") === 30999
);

// A testnet entry never supplies a mainnet chain's eid. LayerZero's metadata
// carries one keyed "astar-testnet" declaring the chain id of Japan Open
// Chain, and matching on the id alone handed joc that entry's eid - so the
// peer walk would have asked a real contract about a network it has nothing
// to do with, and any peer that came back would have been printed as this
// token's adapter. No eid is a gap the report states plainly; a wrong one is
// a row with a real balance under the wrong name.
const fromTestnetEntry = extractEids({
  "somewhere-testnet": { chainDetails: { nativeChainId: laterChainId }, deployments: [{ eid: 30285 }] },
});
check("a testnet entry supplies no eid, whatever chain id it claims", fromTestnetEntry.get("latecomer") === undefined);
// And the mainnet entry for the same chain is still read.
const fromMainnetEntry = extractEids({
  "somewhere-mainnet": { chainDetails: { nativeChainId: laterChainId }, deployments: [{ eid: 30777 }] },
});
check("while a mainnet entry for the same chain is", fromMainnetEntry.get("latecomer") === 30777);

// The same staleness one layer up, sitting on top of the fix below it. The
// eid map is a function of two things - the published metadata and our chain
// table - and only the clock was being checked. A map built during startup
// kept answering for every chain discovered afterwards, so /lzchains
// reported 98 chains with an eid where the payload held 144. Four cached
// maps share this.
const built = { builtAt: 1_000_000, chainCount: 142 };
check("a map is fresh while the clock and the table both hold", isFresh(built, 1_000_500, 142, 60_000));
check("and stale once the table has grown under it", isFresh(built, 1_000_500, 253, 60_000) === false);
check("stale on the clock as before", isFresh(built, 9_000_000, 142, 60_000) === false);
// A map from before the count was recorded must not be trusted either.
check("and a map that never recorded a count is stale", isFresh({ builtAt: 1_000_000 }, 1_000_500, 142, 60_000) === false);

// And the mapping asked for at the moment of use, not kept from whatever an
// await handed back. The first command after a restart parses the metadata
// against a table of a hundred and forty chains, spends seconds on its other
// awaits while discovery fills the table, and then prints against two
// hundred and fifty - which is how 144 chains with an eid were reported as
// 98 three runs in a row, each run being the first after a deploy.
registerChain({
  key: "arrivedlate",
  label: "Arrived Late",
  viemChain: {
    id: 913_579_246,
    name: "Arrived Late",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://late.example"] } },
  } as never,
  rpcEnvVar: "ARRIVEDLATE_RPC_URL",
  defaultRpcUrls: ["https://late.example"],
  explorerTxUrl: () => "",
  explorerAddressUrl: () => "",
  aliases: ["arrivedlate"],
  platformNames: ["Arrived Late"],
});
check(
  "the mapping asked for now covers a chain added since the payload was read",
  lzEidsNow().get("arrivedlate") === undefined
);
extractEids({ "arrivedlate-mainnet": { chainDetails: { nativeChainId: 913_579_246 }, deployments: [{ eid: 30888 }] } });
check("and answers from the payload in hand without another download", lzEidsNow().get("arrivedlate") === 30888);

// A CW20 has its own ledger and has to be asked; the decimals come from the
// same contract, and a balance without them cannot be printed at all - a
// number at the wrong scale reads as real and is off by orders of magnitude.
check(
  "a CW20 answer yields both halves",
  parseCw20({ data: { balance: "12345" } }, { data: { decimals: 6, symbol: "USDT" } })?.amount === 12345n
);
check(
  "at the decimals the contract itself reports",
  parseCw20({ data: { balance: "1" } }, { data: { decimals: 8 } })?.decimals === 8
);
check("a balance with no decimals is not a row", parseCw20({ data: { balance: "1" } }, {}) === undefined);
check("nor are decimals with no balance", parseCw20({}, { data: { decimals: 6 } }) === undefined);
check(
  "a non-numeric balance is refused",
  parseCw20({ data: { balance: "lots" } }, { data: { decimals: 6 } }) === undefined
);
check("zero is a balance like any other", parseCw20({ data: { balance: "0" } }, { data: { decimals: 6 } })?.amount === 0n);
check("an unreachable node yields nothing rather than throwing", parseCw20(undefined, undefined) === undefined);

// Bank denoms publish their decimals per denom rather than per contract.
check(
  "the display unit's exponent is the denom's decimals",
  parseDenomDecimals({
    metadata: { display: "sei", denom_units: [{ denom: "usei", exponent: 0 }, { denom: "sei", exponent: 6 }] },
  }) === 6
);
// Some chains publish the units without naming a display unit; the base unit
// is zero by construction, so the largest exponent is the whole coin.
check(
  "with no display unit named, the largest exponent is taken",
  parseDenomDecimals({
    metadata: { denom_units: [{ denom: "uatom", exponent: 0 }, { denom: "atom", exponent: 6 }] },
  }) === 6
);
// -----------------------------------------------------------------------------
// CCIP. Five routers were written down by hand out of the seventy-five
// Chainlink publishes, so the bridge was checked on five chains and skipped
// in silence on the rest - Robinhood Chain, the customer's own example,
// among them. And Solana was unreachable on top of that, because every step
// of the EVM walk is a contract call and Solana has no contract to call.
// -----------------------------------------------------------------------------

check("the directory covers far more than the five hand-written chains", CCIP_EVM_DEPLOYMENTS.length > 60, `${CCIP_EVM_DEPLOYMENTS.length}`);
check("every row carries a chain id to join on", CCIP_EVM_DEPLOYMENTS.every((d) => Number.isSafeInteger(d.chainId) && d.chainId > 0));
check("and a router that is an address", CCIP_EVM_DEPLOYMENTS.every((d) => /^0x[0-9a-fA-F]{40}$/.test(d.router)));
check("one row per chain id", new Set(CCIP_EVM_DEPLOYMENTS.map((d) => d.chainId)).size === CCIP_EVM_DEPLOYMENTS.length);
// The registry published per chain is what replaces a four-call walk from
// the Router through an OffRamp and an OnRamp, every step of which had to
// succeed on a chain that may answer none of them.
check("nearly every chain publishes its TokenAdminRegistry", CCIP_EVM_DEPLOYMENTS.filter((d) => d.tokenAdminRegistry).length > 60);
// The chains the customer named.
check("Robinhood Chain is in the table", CCIP_EVM_DEPLOYMENTS.some((d) => d.chainId === 4663));

// The generated table against the addresses that were verified by hand. Two
// sources agreeing is the only offline check available on generated data,
// and it is a real one: a join on the wrong key would show up here first.
for (const [chainKey, router] of Object.entries(CCIP_ROUTER_BY_CHAIN)) {
  const chainId = getChain(chainKey)?.viemChain.id;
  const generated = CCIP_EVM_DEPLOYMENTS.find((d) => d.chainId === chainId);
  check(
    `the directory agrees with the checked router on ${chainKey}`,
    generated?.router.toLowerCase() === router!.toLowerCase(),
    `справочник=${generated?.router ?? "нет"} проверено=${router}`
  );
}

// Joined on the selector, not the name: Ethereum is "mainnet" in one file
// and "ethereum-mainnet" in the other, and four of the largest chains fell
// out of the table when the join was on the name.
const selectors = parseSelectors([
  "selectors:",
  "  1:",
  "    selector: 5009297550715157269",
  '    name: "ethereum-mainnet"',
  "    network_type: mainnet",
  "  11155111:",
  "    selector: 16015286601757825753",
  '    name: "ethereum-testnet-sepolia"',
  "    network_type: testnet",
  '  "56":',
  "    selector: 11344663589394136015",
  "    name: binance_smart_chain-mainnet",
  "    network_type: mainnet",
].join("\n"));
check("a mainnet selector maps to its chain id", selectors.get("5009297550715157269") === 1);
check("a quoted chain id is read the same way", selectors.get("11344663589394136015") === 56);
// A testnet router in this table would put play money in a liquidity report.
check("a testnet is dropped by its own label", selectors.get("16015286601757825753") === undefined);
check("an empty registry yields nothing rather than throwing", parseSelectors("").size === 0);

// Solana: the pool programs are the part that could not have been learned
// any other way, since the custody account is derived from the program.
check("Solana's CCIP deployment is in the table", CCIP_SOLANA !== undefined);
check("with a router program", (CCIP_SOLANA?.router.length ?? 0) > 30);
check("and a lock-release pool program", Object.keys(CCIP_SOLANA?.poolPrograms ?? {}).some((k) => holdsCollateral(k)));
// Only that one holds anything. A burn-mint pool mints on arrival and holds
// nothing at any point, so finding a token under it is the answer "nothing
// is held here", not an empty vault.
check("a burn-mint pool is not treated as holding", holdsCollateral("BurnMintTokenPool") === false);
check("nor is the CCTP pool", holdsCollateral("CCTPTokenPool") === false);
check("a lock-release pool is", holdsCollateral("LockReleaseTokenPool") === true);

const svmCandidates = ccipPoolCandidates("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
check("every pool program contributes candidates", svmCandidates.length >= 9, `${svmCandidates.length}`);
check("each names the pool it came from", svmCandidates.every((c) => !!c.poolType && !!c.program));
check("each names how it was derived, so a live check can say which won", svmCandidates.every((c) => c.how.length > 0));
check("and each is a plausible Solana address", svmCandidates.every((c) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.address)));
check("no candidate is offered twice", new Set(svmCandidates.map((c) => `${c.program}:${c.address}`)).size === svmCandidates.length);
// A Token-2022 mint derives a different associated account, and deriving it
// under the wrong token program yields an address that simply does not exist.
check("both token programs are covered", svmCandidates.some((c) => c.how.endsWith("ATA-2022")) && svmCandidates.some((c) => c.how.endsWith("→ ATA")));
check("a mint that is not a Solana key yields nothing rather than throwing", ccipPoolCandidates("не минт").length === 0);

check("a denom with no metadata is left unread, not guessed at", parseDenomDecimals({}) === undefined);
check("and neither is nothing at all", parseDenomDecimals(undefined) === undefined);

// A MintBurnOFTAdapter is an adapter by name and a minter by behaviour. It
// was read as a vault, found to hold nothing, and reported as a bridge
// standing empty - a wrong answer, not a missing one.
check("a mint-burn adapter is not counted as holding collateral", typeLocksCollateral("MintBurnOFTAdapter") === false);
check(
  "however the registry spells it",
  typeLocksCollateral("MintBurnOFT") === false && typeLocksCollateral("mint_burn_oft_adapter") === false
);
check("and it is marked mint-burn outright", typeMintsAndBurns("MintBurnOFTAdapter") === true);
// The narrowing must not cost the adapters that do hold something.
check("a plain adapter still locks", typeLocksCollateral("OFTAdapter") === true);
check("a native adapter still locks", typeLocksCollateral("NativeOFTAdapter") === true);
check("a lockbox still locks", typeLocksCollateral("OFTLockbox") === true);
check("a proxy still locks", typeLocksCollateral("ProxyOFT") === true);
check("a plain OFT still does not", typeLocksCollateral("OFT") === false);
check("and a plain OFT is not mint-burn either", typeMintsAndBurns("OFT") === false);
check("nor is a plain adapter", typeMintsAndBurns("OFTAdapter") === false);

const mintBurnOut = extractDeployments([
  {
    name: "Example",
    deployments: {
      ethereum: { address: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585", type: "MintBurnOFTAdapter" },
    },
  },
]);
check(
  "a mint-burn adapter read out of the registry carries both flags",
  mintBurnOut[0]?.locksCollateral === false && mintBurnOut[0]?.mintsAndBurns === true,
  mintBurnOut.map((d) => `${d.rawType}:${d.locksCollateral}:${d.mintsAndBurns}`).join(" ")
);
check(
  "a locking adapter is not marked mint-burn",
  adapterOut.every((d) => d.mintsAndBurns === false)
);

// --- Russian noun agreement --------------------------------------------------

function scopedWith(hyperlane: number, layerzero: number, omitted = 0): string {
  return renderLiquidityReport({
    symbol: "T",
    name: "Test",
    balances: Array.from({ length: 4 + omitted * 3 }, (_, i) =>
      fakeBalance(["ethereum", "bsc", "base", "polygon", "celo"][i % 5], "hyperlane", BigInt((i + 1) * 1_000000))
    ),
    checkedCount: 10,
    failuresByChain: {},
    attemptsByChain: {},
    scope: { supportedChains: [], unsupportedPlatforms: [], byProtocol: { wormhole: 1, hyperlane, layerzero } },
  });
}
check("one route reads as одна", scopedWith(1, 1).includes("Hyperlane — 1 маршрут,"));
check("two routes read as два", scopedWith(2, 2).includes("Hyperlane — 2 маршрута,"));
check("five routes read as пять", scopedWith(5, 5).includes("Hyperlane — 5 маршрутов,"));
check("eleven routes take the exception", scopedWith(11, 11).includes("Hyperlane — 11 маршрутов,"));
check("twenty-one routes go back to singular", scopedWith(21, 21).includes("Hyperlane — 21 маршрут,"));
check("one network agrees", scopedWith(1, 1).includes("Wormhole — 1 сеть"));
check("adapters are no longer described as living in the config", !scopedWith(1, 1).includes("в конфиге"));
check("adapters are counted as adapters", scopedWith(1, 1).includes("LayerZero — 1 адаптер"));

// -----------------------------------------------------------------------------
// A registry entry is not yet a custody contract: it still has to be checked
// against what the token actually is on that chain. These were live-only
// decisions until the step was split out of the command.
// -----------------------------------------------------------------------------

const ADAPTER = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const OTHER_TOKEN = "0x3333333333333333333333333333333333333333" as Address;

function deployment(
  chainKey: string,
  locksCollateral: boolean,
  address: Address = ADAPTER,
  rawType = locksCollateral ? "OFTAdapter" : "OFT"
): RegistryDeploymentInfo {
  return { chainKey, address, locksCollateral, mintsAndBurns: typeMintsAndBurns(rawType), rawType };
}

async function asyncChecks(): Promise<void> {
// The pool every sweep now shares. Order of results must follow the input,
// not the order things finished, or a chain's health would be reported
// under another chain's name.
  const items = [50, 10, 30, 0, 20];
  let live = 0;
  let peak = 0;
  const out = await mapWithConcurrency(items, 2, async (ms) => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, ms));
    live--;
    return ms * 2;
  });
  check("results keep the input's order", out.join(",") === "100,20,60,0,40");
  check("and never more than the limit run at once", peak === 2);

  const empty = await mapWithConcurrency([], 4, async () => 1);
  check("an empty list is not a hang", empty.length === 0);

  // The layering itself, against the registries that ship with the bot. Both
  // of these answer from memory, so this costs no request: viem flags
  // Sepolia a testnet and describes Meter, Beam, Injective's EVM chain,
  // Rollux and EDU Chain as mainnets - and the second group is exactly what
  // a faucet list read as a verdict had thrown out.
  check("viem's testnet flag refuses the chain", (await registryRefusal(11155111)) !== undefined);
  for (const [name, id] of [["Meter", 82], ["Beam", 4337], ["Injective EVM", 1776], ["Rollux", 570], ["EDU Chain", 41923]] as const) {
    check(`and its mainnets are let through: ${name}`, (await registryRefusal(id)) === undefined);
  }

  // "Testnet or mainnet" and "live or shut down" are different things to
  // know, and the first answer was silencing the second: Horizen EON has
  // sunset and the canonical registry says so, while viem still describes it
  // as a mainnet - which it was. A chain nobody can bridge to any more has
  // balances that read as available liquidity.
  check(
    "a sunset chain is refused even though viem calls it a mainnet",
    /устаревш/.test((await registryRefusal(7332)) ?? "")
  );
  // The one the canonical registry catches on its own: no flag anywhere, an
  // empty faucet list, and "testnet" written in the name by its authors.
  check("and a testnet named as one in the registry", (await registryRefusal(9070)) !== undefined);
  check("while the mainnet beside it goes through", (await registryRefusal(9069)) === undefined);

  // A limit larger than the list must not spawn workers with nothing to do.
  const few = await mapWithConcurrency([1, 2], 99, async (n) => n + 1);
  check("a limit above the list length is harmless", few.join(",") === "2,3");

  const native = await resolveRegistryDeployments(
    [deployment("ethereum", false)],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => undefined
  );
  check("a plain OFT yields no custody contract", native.custodians.length === 0);
  check("and is reported as an omnichain chain instead", native.nativeOftChains.includes("ethereum"));

  // The registry's type field is a label, not evidence: on Aptos it called
  // three minting deployments adapters. The same field calling an adapter an
  // OFT is the dangerous direction - the collateral would be invisible on
  // every path, since the contract probe skips chains the registry named and
  // the peer walk skips whatever was filed as mint-only. So the contract is
  // asked whatever the label said.
  const mislabelled = await resolveRegistryDeployments(
    [deployment("ethereum", false)],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => TOKEN
  );
  check("a deployment the registry calls an OFT is still asked what it locks", mislabelled.custodians.length === 1);
  check("and its balance is read against what it named", mislabelled.custodians[0]?.tokenAddress === TOKEN);
  check("a chain with real collateral is not called mint-only", !mislabelled.nativeOftChains.includes("ethereum"));
  // Said out loud, because that row exists only because the label was not
  // believed - and if the label is ever right, this is the line that shows
  // the check earning its keep.
  check("the row says the contract overruled the registry", /контракт блокирует/.test(mislabelled.custodians[0]?.note ?? ""));

  // The one case the contract cannot settle. A MintBurnOFTAdapter names a
  // separate ERC-20 just like a locking adapter does - it was granted mint
  // and burn on one - so the probe above reads it as a vault and the balance
  // comes back zero. Reported that way it claims the bridge is here and
  // empty, about a bridge that never holds anything.
  const mintBurn = await resolveRegistryDeployments(
    [deployment("ethereum", false, ADAPTER, "MintBurnOFTAdapter")],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => TOKEN
  );
  check("a mint-burn adapter naming a token is still not a custody contract", mintBurn.custodians.length === 0);
  check("and the chain is reported as minting instead", mintBurn.nativeOftChains.includes("ethereum"));
  check("without being counted as a mismatch", mintBurn.mismatchedAdapters === 0);

  const adapter = await resolveRegistryDeployments(
    [deployment("ethereum", true)],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => TOKEN
  );
  check("an adapter locking the listed token becomes a custodian", adapter.custodians.length === 1);
  check(
    "the balance is read against the locked ERC-20, not the adapter",
    adapter.custodians[0]?.tokenAddress === TOKEN && adapter.custodians[0]?.custodyAddress === ADAPTER
  );

  // Tickers are not unique. An adapter under the same symbol that locks some
  // other project's token would otherwise be reported as this token's
  // liquidity - a wrong number reads worse than a missing one.
  const foreign = await resolveRegistryDeployments(
    [deployment("ethereum", true)],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => OTHER_TOKEN
  );
  check("an adapter locking a different token is skipped", foreign.custodians.length === 0);
  check("and is counted so the report can say so", foreign.mismatchedAdapters === 1);

  // The manual config exists to override the registry, so a chain it already
  // covers must not pick up a second, contradictory row from the registry.
  const overridden = await resolveRegistryDeployments(
    [deployment("ethereum", true)],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(["ethereum"]),
    "TKN",
    async () => TOKEN
  );
  check("the manual config wins over the registry", overridden.custodians.length === 0);

  // A node that will not answer token() is not a reason to drop the chain:
  // CoinGecko already told us which ERC-20 lives there.
  const fallback = await resolveRegistryDeployments(
    [deployment("ethereum", true)],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => undefined
  );
  check("an unreadable adapter falls back to the listed token", fallback.custodians[0]?.tokenAddress === TOKEN);

  // A deployment found under a neighbouring ticker must prove itself. The
  // interesting case is a chain CoinGecko does not list: that is exactly
  // where a bridged deployment adds coverage, so requiring CoinGecko there would
  // discard the chains the wider search was for.
  const aliasDeployment = { ...deployment("ethereum", true), viaAlias: "TKN0" };

  const aliasListed = await resolveRegistryDeployments(
    [aliasDeployment],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => TOKEN
  );
  check("an alias deployment locking the listed token is kept", aliasListed.custodians.length === 1);

  const aliasWrong = await resolveRegistryDeployments(
    [aliasDeployment],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => OTHER_TOKEN,
    async () => false
  );
  check("an alias deployment locking something else is rejected", aliasWrong.custodians.length === 0);

  // A bridged deployment locks its own variant of the token rather than the
  // one CoinGecko lists, and to anyone asking whether a transfer can be
  // withdrawn that is the same asset. Requiring the listed address alone
  // rejected sixteen of USDT's twenty-three real deployments.
  const aliasVariant = await resolveRegistryDeployments(
    [aliasDeployment],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => OTHER_TOKEN,
    async () => true
  );
  check("but a variant of the same token, by symbol, is kept", aliasVariant.custodians.length === 1);

  const aliasUnlisted = await resolveRegistryDeployments(
    [aliasDeployment],
    [],
    new Set(),
    "TKN",
    async () => TOKEN,
    async () => true
  );
  check("on a chain CoinGecko does not list, the token's own symbol is the proof", aliasUnlisted.custodians.length === 1);

  const aliasUnlistedWrongSymbol = await resolveRegistryDeployments(
    [aliasDeployment],
    [],
    new Set(),
    "TKN",
    async () => TOKEN,
    async () => false
  );
  check("and a symbol that does not match is rejected", aliasUnlistedWrongSymbol.custodians.length === 0);

  // No fallback to the listed address here: an alias candidate that will not
  // say what it locks has proved nothing, and guessing is the one thing that
  // could put another project's balance under this ticker.
  const aliasUnreadable = await resolveRegistryDeployments(
    [aliasDeployment],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => undefined
  );
  check("an alias deployment that will not identify itself is dropped", aliasUnreadable.custodians.length === 0);

  const unknown = await resolveRegistryDeployments(
    [deployment("ethereum", true)],
    [],
    new Set(),
    "TKN",
    async () => undefined
  );
  check("with nothing to lock, the adapter is dropped rather than guessed", unknown.custodians.length === 0);
  check("and is counted as unresolved rather than vanishing", unknown.accounting.unresolved === 1);

  // Every registry entry lands in exactly one bucket, and the buckets sum to
  // what went in. /lzmesh reported "28 in the registry, 24 accepted, 1
  // rejected" - three entries gone between two numbers, with no way to tell
  // a deliberate skip from a read that failed.
  const mixedRegistry = await resolveRegistryDeployments(
    [
      deployment("ethereum", true), // adapter locking the listed token
      deployment("arbitrum", false), // plain OFT: mints
      deployment("optimism", true), // adapter on a chain already configured
    ],
    [
      { chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN },
      { chainKey: "arbitrum", platformName: "Arbitrum", tokenAddress: TOKEN },
    ],
    new Set(["optimism"]),
    "TKN",
    async (chainKey) => (chainKey === "ethereum" ? TOKEN : undefined)
  );
  const tallied =
    mixedRegistry.custodians.length +
    mixedRegistry.rejected.length +
    mixedRegistry.accounting.minting +
    mixedRegistry.accounting.preconfigured +
    mixedRegistry.accounting.unresolved;
  check("every registry entry is accounted for in exactly one bucket", tallied === 3);
  check("the minting one is counted as minting", mixedRegistry.accounting.minting === 1);
  check("the preconfigured one is counted as preconfigured", mixedRegistry.accounting.preconfigured === 1);
  check("and the adapter still becomes a custodian", mixedRegistry.custodians.length === 1);
}

// -----------------------------------------------------------------------------
// A contract that names a separate ERC-20 is not yet a vault.
//
// The peer walk reaches chains no registry lists, so the registry's type
// string - the only thing that told a locking adapter from a mint-burn one -
// is not available there. token() cannot tell them apart: both name a token
// other than themselves. Nine adapters found this way came back holding
// nothing and were reported as empty vaults, which is the opposite of the
// truth: a mint-burn deployment never holds anything at all, so there is no
// vault to fill.
// -----------------------------------------------------------------------------

const SELF = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;

check("a contract naming itself mints, whatever else it says", classifyOft(SELF, SELF, true) === "native");
check("naming nothing is the same answer", classifyOft(SELF, undefined, true) === "native");
check(
  "naming another token and needing an allowance is a vault",
  classifyOft(SELF, OTHER, true) === "adapter"
);
check(
  "naming another token and needing none is mint-burn, not an empty vault",
  classifyOft(SELF, OTHER, false) === "native"
);
// V1 has no approvalRequired(), and a contract that will not answer must not
// be written off: an unanswered question is not a denial.
check(
  "a question that went unanswered leaves the vault reading in place",
  classifyOft(SELF, OTHER, undefined) === "adapter"
);
// Checksum casing differs between registries and RPC replies, and comparing
// them raw would call an OFT an adapter locking itself.
check(
  "the self comparison ignores case",
  classifyOft(SELF, SELF.toUpperCase().replace("0X", "0x") as typeof SELF, undefined) === "native"
);

// -----------------------------------------------------------------------------
// The same contract arrives from the registry and from probing the token
// itself. Listing it twice would read as twice the liquidity that exists.
// -----------------------------------------------------------------------------

const fromRegistry: Custodian = {
  protocol: "layerzero",
  chainKey: "ethereum",
  custodyAddress: ADAPTER,
  tokenAddress: TOKEN,
  note: "из реестра LayerZero (OFTAdapter)",
};
const fromProbe: Custodian = {
  protocol: "layerzero",
  chainKey: "ethereum",
  // Same contract, different casing: addresses arrive checksummed from one
  // source and lowercase from another.
  custodyAddress: ADAPTER.toUpperCase().replace("0X", "0x") as Address,
  tokenAddress: TOKEN,
  note: "адаптер определён по контракту",
};
const onAnotherChain: Custodian = { ...fromRegistry, chainKey: "arbitrum" };
const otherProtocol: Custodian = { ...fromRegistry, protocol: "wormhole" };

const deduped = dedupeCustodians([fromRegistry, fromProbe, onAnotherChain, otherProtocol]);
check("the same contract from two sources is counted once", deduped.length === 3);
check("case alone does not make two contracts", !deduped.some((c) => c === fromProbe));
check("the same address on another chain is kept", deduped.some((c) => c.chainKey === "arbitrum"));
check("two bridges holding the same token are both kept", deduped.some((c) => c.protocol === "wormhole"));

// -----------------------------------------------------------------------------
// Telegram rejects a message over 4096 characters outright, and the reply is
// then not a shortened report but a generic error. The caps upstream are
// sized by hand, so this is the backstop for whatever they missed.
// -----------------------------------------------------------------------------

const runaway = renderLiquidityReport({
  symbol: "HUGE",
  name: "A".repeat(9000),
  balances: [],
  checkedCount: 0,
  failuresByChain: {},
  attemptsByChain: {},
  nativeOftChains: Array.from({ length: 400 }, () => "ethereum"),
  scope: {
    supportedChains: Array.from({ length: 200 }, (_, i) => `Сеть номер ${i}`),
    unsupportedPlatforms: Array.from({ length: 200 }, (_, i) => `Платформа номер ${i}`),
    byProtocol: { wormhole: 0, hyperlane: 0, layerzero: 0 },
  },
});
check(
  "a runaway report still fits Telegram's limit",
  visibleLength(runaway) <= 4096,
  `${visibleLength(runaway)} visible chars`
);
check("and says it was cut rather than ending mid-word", runaway.includes("обрезан"));

// A report is no longer paid for out of its own content. USDC checked 231
// contracts and dropped twenty-two networks to fit one message - more than
// it printed - and anyone reading that would conclude the bot does not cover
// those chains, which is the complaint this whole line of work began from.
const wide = renderLiquidityReport({
  symbol: "WIDE",
  name: "Widely Bridged",
  // Distinct chains, because rows are grouped per chain: sixty rows on two
  // chains collapse to four lines and prove nothing about a long report.
  balances: Array.from({ length: 120 }, (_, i) =>
    fakeBalance(`сеть-номер-${i}`, "hyperlane", BigInt(1_000_000 - i))
  ),
  checkedCount: 120,
  failuresByChain: {},
  attemptsByChain: {},
  scope: {
    supportedChains: Array.from({ length: 120 }, (_, i) => `Сеть номер ${i}`),
    unsupportedPlatforms: [],
    byProtocol: { hyperlane: 120 },
  },
});
const wideParts = splitForTelegram(wide);
check("a report too big for one message is split, not cut", wideParts.length > 1);
check("every part fits Telegram's limit", wideParts.every((p) => visibleLength(p) <= 4096));
check("and no part is the truncation notice", !wideParts.some((p) => p.includes("обрезан")));
// Split, not summarised: the closing notes are the last thing, and the
// header the first, so the reader gets a whole report across messages.
check("the first part opens the report", wideParts[0].startsWith("Токен:"));
check("the last part is the report's true tail", wide.endsWith(wideParts[wideParts.length - 1]));
check("the closing notes survive the split", wideParts.join("\n").includes("Всего проверено контрактов"));
check("nothing is lost between parts", wideParts.join("\n") === wide);
check("every part is valid HTML on its own", wideParts.every(tagsBalanced));
// A short report is still one message; splitting is not a new default shape.
check("a report that fits stays a single message", splitForTelegram(smallReport).length === 1);

// Discovery only ever added chains to memory, so every restart began without
// them and answered questions while it rebuilt the table. Two identical USDC
// reports minutes apart differed by three networks and eighty-eight million
// in reported supply - one had run before the scan finished. A report that
// changes with the bot's uptime is not a report.
const storedChain = {
  slug: "xdc-network",
  chainId: 50,
  name: "XDC Network",
  nativeCurrency: { name: "XDC", symbol: "XDC", decimals: 18 },
  rpcUrls: ["https://rpc.xinfin.network"],
  explorerUrl: "https://xdcscan.io",
  rpcUrl: "https://rpc.xinfin.network",
};
const restored = defFromDiscovered(storedChain);
check("a stored chain comes back as a usable definition", restored?.viemChain.id === 50);
check("with its own coin, not a guessed one", restored?.viemChain.nativeCurrency.symbol === "XDC");
check("and a working explorer link", restored?.explorerAddressUrl("0xabc") === "https://xdcscan.io/address/0xabc");
check("it answers to the name the price API uses", restored?.aliases.includes("xdc-network") === true);
// The file is not code: a truncated write or a hand edit must cost one chain
// rather than the boot.
const broken = [null, {}, { slug: "x" }, { ...storedChain, nativeCurrency: undefined }, { ...storedChain, chainId: "50" }, { ...storedChain, rpcUrl: "" }];
check("every incomplete record is skipped, not half-registered", broken.every((b) => defFromDiscovered(b) === undefined));

// Breaking between any two lines put a message boundary through the middle
// of a chain: the next message opened with a bare " - Hyperlane (Warp
// Route): 46 489 USDC" and no way to tell which network it belonged to.
// Telegram strips the leading spaces too, so it did not even read as a
// continuation. A chain is one thing and has to arrive as one.
check(
  "no part opens on an orphaned row",
  wideParts.every((p) => !/^\s*[-·]/.test(p)),
  wideParts.map((p) => p.split("\n")[0].slice(0, 40)).join(" | ")
);
check(
  "every part after the first opens on a chain or a note",
  wideParts.slice(1).every((p) => /^(Сеть:|<b>|[А-ЯЁ⚠️ℹ️])/.test(p.trimStart())),
  wideParts.slice(1).map((p) => p.trimStart().slice(0, 30)).join(" | ")
);

// Telegram parses the whole message as HTML and refuses an unbalanced one,
// so a cut through a tag fails to send - the exact outcome the cap prevents.
function tagsBalanced(html: string): boolean {
  const open: string[] = [];
  const tag = /<(\/?)([a-zA-Z]+)[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    const name = m[2].toLowerCase();
    if (m[1]) {
      if (open.pop() !== name) return false;
    } else {
      open.push(name);
    }
  }
  return open.length === 0;
}
check("the truncated report is still valid HTML", tagsBalanced(runaway));

// Telegram parses the whole message as HTML and rejects it outright if a
// "<" does not start a tag it knows. A dust balance renders as "< 0,0001",
// and unescaped it cost a whole report: "can't parse entities: Unsupported
// start tag". Anything interpolated into the message has to be escaped, even
// something as apparently safe as a number.
const dusty = renderLiquidityReport({
  symbol: "DUST",
  name: "Dust Token",
  balances: [fakeBalance("ethereum", "across", 1n)],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
});
// A contract that reverts is not a chain that failed. Counting the two the
// same made the report warn about Polygon's connection because two warp
// routes there are not plain ERC-20 holders.
const reverted = renderLiquidityReport({
  symbol: "REV",
  name: "Revert Token",
  balances: [fakeBalance("ethereum", "wormhole", 500n)],
  checkedCount: 3,
  failuresByChain: {},
  attemptsByChain: { ethereum: 3 },
  notReadableByChain: { ethereum: 2 },
});
check("a reverting contract is not reported as a connection problem", !reverted.includes("не ответили"));

// A non-EVM chain nobody could reach must be named too. Radix's gateways
// are nine days behind the ledger, and a report that simply omits the row
// says "this bridge holds nothing" about a bridge nobody could ask.
const unreachableNonEvm = renderLiquidityReport({
  symbol: "XRD",
  name: "Radix",
  balances: [],
  checkedCount: 1,
  failuresByChain: { radix: 1 },
  attemptsByChain: { radix: 1 },
});
check("an unreachable non-EVM chain is named", unreachableNonEvm.includes("Radix"));
check("and is called unreachable, not empty", !unreachableNonEvm.includes("не заведён"));
check("but it is still accounted for", reverted.includes("отказом вместо баланса"));
check("and counted with the right noun", reverted.includes("2 контракта ответили"));

// One bridge holding the same token in several contracts on one chain gives
// identical labels; without the note there is no way to tell a live
// deployment from a deprecated one sitting next to it.
const twoAdapters = renderLiquidityReport({
  symbol: "TKN",
  name: "Token",
  balances: [
    { ...fakeBalance("ethereum", "layerzero", 3_000_000n), note: "TKN0" },
    { ...fakeBalance("ethereum", "layerzero", 400n), note: "реестр" },
  ],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: { ethereum: 2 },
});
check("two adapters on one chain are told apart", twoAdapters.includes("TKN0") && twoAdapters.includes("реестр"));

const oneAdapter = renderLiquidityReport({
  symbol: "TKN",
  name: "Token",
  balances: [{ ...fakeBalance("ethereum", "layerzero", 3_000_000n), note: "TKN0" }],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
});
check("a lone row is not cluttered with a note it does not need", !oneAdapter.includes("TKN0"));

// "Checked and empty" is the most useful answer this report can give - do
// not send here - and hiding it made an empty route indistinguishable from
// one that was never looked at.
const withEmpty = renderLiquidityReport({
  symbol: "TKN",
  name: "Token",
  balances: [
    fakeBalance("ethereum", "wormhole", 5_000n),
    { ...fakeBalance("ethereum", "layerzero", 0n) },
    { ...fakeBalance("ethereum", "across", 0n) },
  ],
  checkedCount: 3,
  failuresByChain: {},
  attemptsByChain: { ethereum: 3 },
});
check("a bridge that holds nothing is named as empty", withEmpty.includes("пусто:"));
check("and both empty bridges are listed", withEmpty.includes("LayerZero") && withEmpty.includes("Across"));
check("a bridge that does hold something is not called empty", !/пусто:[^\n]*Wormhole/.test(withEmpty));

const nothingEmpty = renderLiquidityReport({
  symbol: "TKN",
  name: "Token",
  balances: [fakeBalance("ethereum", "wormhole", 5_000n)],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
});
check("with nothing empty the line does not appear", !nothingEmpty.includes("пусто:"));

check("a dust balance is shown, not rounded away to zero", dusty.includes("0,0001"));

// A native pool holds the chain's coin, so a WETH report shows those rows in
// ETH. Printing the requested ticker would misstate what comes out.
const nativeRow = renderLiquidityReport({
  symbol: "WETH",
  name: "WETH",
  balances: [
    { ...fakeBalance("ethereum", "stargate", 5n * 10n ** 18n), decimals: 18, readsNativeCoin: true },
  ],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: { ethereum: 1 },
});
check("a native pool's row is labelled with the chain's coin", nativeRow.includes("5 ETH"), nativeRow);
check("and not with the ticker that was asked for", !nativeRow.includes("5 WETH"));
check("the report says what a native row means", nativeRow.includes("нативной монетой"));
check("and its \"<\" is escaped so Telegram can parse the message", !/<(?![a-zA-Z/])/.test(dusty), dusty);
check("the report as a whole opens no tag it does not close", tagsBalanced(dusty));

// A balance too small to print at four decimals is not zero, and printing
// it as "0" says there is nothing here - the single most consequential
// thing this bot can get wrong.
check("dust is not reported as zero", formatAmount(1n, 18) === "< 0,0001", formatAmount(1n, 18));
check("a real zero still reads as zero", formatAmount(0n, 18) === "0");
check("dust on top of a whole number does not hide the whole number", formatAmount(10n ** 18n + 1n, 18) === "1");


// The cut lands mid-line only when a single line outgrows the whole budget;
// the usual case must land on a line boundary, tags intact.
const manyLines = renderLiquidityReport({
  symbol: "MANY",
  name: "Many Lines",
  balances: [],
  checkedCount: 0,
  failuresByChain: {},
  attemptsByChain: {},
  nativeOftChains: Array.from({ length: 500 }, () => "ethereum"),
  scope: {
    supportedChains: Array.from({ length: 300 }, (_, i) => `Длинное имя сети номер ${i}`),
    unsupportedPlatforms: [],
    byProtocol: { wormhole: 0, hyperlane: 0, layerzero: 0 },
  },
});
check(
  "a long multi-line report is capped too",
  visibleLength(manyLines) <= 4096,
  `${visibleLength(manyLines)} visible chars`
);
check("and stays valid HTML", tagsBalanced(manyLines));

// "TON did not answer" and "TON's index refused on a rate limit" send the
// reader to different places, and only one of them is something they can act
// on. The non-EVM readers returned a count and nothing else, so both
// produced the same line.
const withReason = renderLiquidityReport({
  symbol: "USDE",
  name: "Ethena USDe",
  balances: [
    {
      protocol: "layerzero",
      chainKey: "ethereum",
      custodyAddress: PORTAL_ETH,
      tokenAddress: TOKEN,
      amount: 5n,
      decimals: 18,
    },
  ],
  checkedCount: 2,
  failuresByChain: { ton: 1 },
  attemptsByChain: { ton: 1 },
  failureReasons: { ton: "индекс TON ответил 429 — лимит запросов" },
});
check("an unanswered chain carries its reason", withReason.includes("429 — лимит запросов"));
check("and is still named", withReason.includes("TON"));

const withoutReason = renderLiquidityReport({
  symbol: "USDE",
  name: "Ethena USDe",
  balances: [
    {
      protocol: "layerzero",
      chainKey: "ethereum",
      custodyAddress: PORTAL_ETH,
      tokenAddress: TOKEN,
      amount: 5n,
      decimals: 18,
    },
  ],
  checkedCount: 2,
  failuresByChain: { ton: 1 },
  attemptsByChain: { ton: 1 },
});
check("a reader with no reason to give still names the chain", withoutReason.includes("Не ответили совсем"));
check(
  "and does not invent one",
  (withoutReason.split("\n").find((l) => l.includes("Не ответили совсем")) ?? "").includes(" — ") === false
);

// The address scan builds one enormous line - every chain name it checked,
// comma-separated - and at two hundred and twenty-nine chains that line is
// on its own most of a message. It also had no cap at all until the table
// outgrew it, and a message Telegram refuses looks from the phone exactly
// like a bot that is down.
const oneHugeLine = capToTelegramLimit(
  `🔎 <code>0xdAC17F958D2ee523a2206206994597C13D831ec7</code>\n\n` +
    `Проверено: ${Array.from({ length: 300 }, (_, i) => `Сеть с довольно длинным именем ${i}`).join(", ")}.`
);
check("a report that is one long line is capped", visibleLength(oneHugeLine) <= 4096);
check("and survives with its tags closed", tagsBalanced(oneHugeLine));
check("and says it was cut", oneHugeLine.includes("обрезан"));

// Hyperlane files one contract under more than one name. Polygon's MoonPay
// router 0x766A…1270 is both "USDT/moonpay" and "CROSS/moonpay", and the
// name shown was whichever sorted first - so asking about USDT0 produced
// "CROSS/moonpay", a name with no visible connection to the question. The
// balance was never wrong; the provenance was, and provenance is the point.
check("an exact ticker wins", preferredRouteId(["CROSS/moonpay", "USDT/moonpay"], "USDT") === "USDT/moonpay");
check(
  "a variant of it wins over a router's own name",
  preferredRouteId(["CROSS/moonpay", "USDT/moonpay"], "USDT0") === "USDT/moonpay"
);
check(
  "and the exact one still beats the variant",
  preferredRouteId(["USDT/moonpay", "USDT0/somewhere"], "USDT0") === "USDT0/somewhere"
);
check(
  "with nothing related, order is at least stable",
  preferredRouteId(["ZZZ/b", "AAA/a"], "USDT") === "AAA/a"
);
check("one name is just itself", preferredRouteId(["USDT/moonpay"], "USDT") === "USDT/moonpay");
check("duplicates collapse", preferredRouteId(["A/x", "A/x"], "A") === "A/x");

// The customer's question, verbatim: does the report say whether there are
// tokens on Robinhood Chain or not? It did not. CoinGecko listed the token
// there, no tracked bridge held custody there, so the chain produced no row
// and no mention - and "checked, no bridge there" looked exactly like "not
// checked", which is the one distinction this bot exists to make.
const withSupplyOnly = renderLiquidityReport({
  symbol: "PENGU",
  name: "Pudgy Penguins",
  balances: [
    {
      protocol: "hyperlane",
      chainKey: "ethereum",
      custodyAddress: PORTAL_ETH,
      tokenAddress: TOKEN,
      amount: 2_067n * 10n ** 18n,
      decimals: 18,
    },
  ],
  checkedCount: 7,
  failuresByChain: {},
  attemptsByChain: {},
  supplyOnly: [
    { chainKey: "robinhood", amount: 5_000_000n * 10n ** 18n, decimals: 18 },
    { chainKey: "abstract", amount: 0n, decimals: 18 },
    { chainKey: "bsc" },
  ],
});
check("a chain with supply but no custody is named", withSupplyOnly.includes("Robinhood"));
check("with how much is there", /5\s*000\s*000/.test(withSupplyOnly.replace(/\u00a0/g, " ")));
// Three different facts used to share one heading, and it read as a
// contradiction: "the token is on these chains: Mantle (no supply)". LINK's
// report carried twenty-eight such entries, most of them zeroes, with the
// ones that mattered buried among them.
check("a chain with supply is under a heading that says so", /выпущен в этих сетях[^\n]*Robinhood/.test(withSupplyOnly));
check("a chain with none is not called a chain the token is on", !/выпущен в этих сетях[^\n]*Abstract/.test(withSupplyOnly));
check("it gets its own plain statement instead", /выпуска нет[^\n]*Abstract/.test(withSupplyOnly), withSupplyOnly);
check("and one that could not be read is neither", /не прочитался[^\n]*BNB/.test(withSupplyOnly), withSupplyOnly);
// A group with nothing in it says nothing at all.
const onlyIssued = renderLiquidityReport({
  symbol: "T", name: "Test",
  balances: [fakeBalance("ethereum", "hyperlane", 1n)],
  checkedCount: 1, failuresByChain: {}, attemptsByChain: {},
  supplyOnly: [{ chainKey: "robinhood", amount: 5n, decimals: 0 }],
});
check("no empty groups are printed", !/выпуска нет/.test(onlyIssued) && !/не прочитался/.test(onlyIssued));
check("a chain with no supply says so", withSupplyOnly.includes("выпуска нет"));
check("and one that would not answer is not called empty", withSupplyOnly.includes("узел не ответил"));
// When several of a chain's nodes fail differently, the report used to name
// whichever came first - and the first endpoint is often a hostname that
// died a year ago. Kroma and Aleph Zero were reported as ENOTFOUND while
// their other nodes were alive and refusing this host's IP. Opposite
// diagnoses: a dead name cannot be fixed by anyone, a refusal is fixed by
// the private RPC the report's own footer offers.
check(
  "a server that said no outranks a name that is gone",
  mostActionable(["getaddrinfo ENOTFOUND api.kroma.network (ENOTFOUND)", "HTTP 403"]) === "HTTP 403"
);
check(
  "a certificate problem is actionable too",
  mostActionable([
    "getaddrinfo ENOTFOUND rpc.example.invalid",
    "Hostname/IP does not match certificate's altnames",
  ]).startsWith("Hostname/IP")
);
check(
  "a dead name still outranks silence",
  mostActionable(["нет ответа за 6 с", "getaddrinfo ENOTFOUND rpc.example.invalid"]).includes("ENOTFOUND")
);
check(
  "a reset connection sits between them",
  mostActionable(["getaddrinfo ENOTFOUND x", "read ECONNRESET (ECONNRESET)"]).includes("ECONNRESET")
);
check("one reason is itself", mostActionable(["HTTP 429"]) === "HTTP 429");

// And the count of a chain's other failures must not become part of the key
// the report groups by: appended to the reason, "HTTP 400 (+3)" and
// "HTTP 400 (+2)" turned one reason into two groups, which is the opposite
// of grouping.
const failedChains = [
  { chainKey: "a", label: "A", ok: false, alive: 0, asked: 4, error: "HTTP 400", otherReasons: 3, custom: false },
  { chainKey: "b", label: "B", ok: false, alive: 0, asked: 3, error: "HTTP 400", otherReasons: 2, custom: false },
  { chainKey: "c", label: "C", ok: false, alive: 0, asked: 1, error: "HTTP 403", custom: false },
];
// A server that answered and refused is alive and a key opens it; a name
// that does not resolve is not, and no key fixes it. The footer used to send
// the reader hunting for a key on both. Dogechain has nine endpoints and all
// nine refuse - that chain is not short of nodes.
const split = splitFailures([
  { chainKey: "a", label: "Refusing", ok: false, alive: 0, asked: 2, error: "HTTP 429 (lb.routeme.sh)", custom: false },
  { chainKey: "b", label: "Forbidden", ok: false, alive: 0, asked: 1, error: "HTTP 403 (rpc.ankr.com)", custom: false },
  { chainKey: "c", label: "Gone", ok: false, alive: 0, asked: 1, error: "getaddrinfo ENOTFOUND x", custom: false },
  { chainKey: "d", label: "BadCert", ok: false, alive: 0, asked: 1, error: "Hostname/IP does not match certificate's altnames", custom: false },
  { chainKey: "e", label: "Silent", ok: false, alive: 0, asked: 1, error: "нет ответа за 6 с", custom: false },
]);
check("a refusal counts as alive", split.refusing.map((h) => h.label).join() === "Refusing,Forbidden");
check("and everything else as broken", split.broken.map((h) => h.label).join() === "Gone,BadCert,Silent");
check("every failure lands on exactly one side", split.refusing.length + split.broken.length === 5);
check("a chain with no reason is not called alive", splitFailures([
  { chainKey: "f", label: "F", ok: false, alive: 0, asked: 0, custom: false },
]).refusing.length === 0);

const grouped = groupByReason(failedChains);
check("one reason is one group, whatever else failed", grouped.length === 2);
check("and the commonest comes first", grouped[0][0] === "HTTP 400" && grouped[0][1].length === 2);
check("a chain with no reason at all is still grouped", groupByReason([
  { chainKey: "d", label: "D", ok: false, alive: 0, asked: 0, custom: false },
])[0][0] === "нет ответа");
check("and no reason at all is not a crash", mostActionable([]) === "нет ответа");

// A chain that answers on a single node has nowhere to fall back to inside
// one read, so it is asked more gently and given more patience. A chain with
// six healthy nodes has already tried five others by the time a retry is
// reached, and waiting longer would only lengthen a slow report.
check("a fragile chain is asked more gently", concurrencyFor(undefined, true) < concurrencyFor(undefined, false));
check("and given more attempts", attemptsFor(true) > attemptsFor(false));
check("but never fewer than one attempt", attemptsFor(false) >= 1);
// A chain's own declared limit wins: it was written down because someone
// watched that chain throttle, which beats anything measured in passing.
check("a declared limit overrides both", concurrencyFor(1, false) === 1 && concurrencyFor(1, true) === 1);

// And nothing is called fragile before it has been measured - otherwise
// every chain would be throttled for the first minutes after a deploy, on
// no evidence at all.
check("an unmeasured chain is not fragile", isFragile("ethereum") === false);

// The alternates table is keyed by chain id, not by the bot's name for a
// chain. It discovers chains at runtime, and a chain it was never told
// about has no such name - so keying by name handed every discovered chain
// an empty list, which is how ninety-one chains came to rely on one node.
check("the alternates table is keyed by chain id", Object.keys(EXTRA_RPC_URLS_BY_CHAIN_ID).every((k) => /^\d+$/.test(k)));
check(
  "and it covers chains the curated table never listed",
  Object.keys(EXTRA_RPC_URLS_BY_CHAIN_ID).length > CHAINS.length
);
check(
  "a discovered tier-3 chain now has alternates",
  (EXTRA_RPC_URLS_BY_CHAIN_ID[4689] ?? []).length > 1 && (EXTRA_RPC_URLS_BY_CHAIN_ID[50] ?? []).length > 1
);
check(
  "and no entry carries a placeholder for a key",
  Object.values(EXTRA_RPC_URLS_BY_CHAIN_ID).every((urls) =>
    urls.every((u) => u.startsWith("https://") && !/\$\{|API_KEY/i.test(u))
  )
);
check(
  "nor the same node twice",
  Object.values(EXTRA_RPC_URLS_BY_CHAIN_ID).every((urls) => new Set(urls).size === urls.length)
);

// Endpoint order decides how long a read waits before it succeeds. viem's
// fallback walks the list and pays a full timeout for each node that does
// not answer, so a dead node in first place is a tax on every read of that
// chain - Kroma lists five endpoints and the first is a hostname that no
// longer resolves.
const fast = { ok: true, ms: 100, at: 0 };
const slow = { ok: true, ms: 900, at: 0 };
const dead = { ok: false, ms: 5000, at: 0 };
const measured: Record<string, typeof fast> = {
  "https://dead.example": dead,
  "https://slow.example": slow,
  "https://fast.example": fast,
};
const look = (u: string) => measured[u];

check(
  "a dead node goes last",
  orderEndpoints(["https://dead.example", "https://fast.example"], false, look).join() ===
    "https://fast.example,https://dead.example"
);
check(
  "and the quickest that answered goes first",
  orderEndpoints(["https://slow.example", "https://fast.example"], false, look)[0] ===
    "https://fast.example"
);
check(
  "an unmeasured node outranks a dead one but not a live one",
  orderEndpoints(
    ["https://dead.example", "https://unknown.example", "https://fast.example"],
    false,
    look
  ).join() === "https://fast.example,https://unknown.example,https://dead.example"
);
// Someone paid for a configured RPC; one slow probe must not demote it
// behind a public node. That is the bot overruling its operator.
check(
  "a configured RPC stays first even when measured slow",
  orderEndpoints(["https://slow.example", "https://fast.example"], true, look)[0] ===
    "https://slow.example"
);
check("a single endpoint is left alone", orderEndpoints(["https://only.example"], false, look).length === 1);
check("and an empty list does not throw", orderEndpoints([], false, look).length === 0);
// Unmeasured nodes keep the order the registries gave, which is their own
// ranking and better than nothing.
check(
  "unmeasured nodes keep the registries' order",
  orderEndpoints(["https://a.example", "https://b.example", "https://c.example"], false, () => undefined).join() ===
    "https://a.example,https://b.example,https://c.example"
);

// A native pool's precision comes from the chain, not from a constant. It
// was hardcoded to 18 on the grounds that every chain carrying one used 18 -
// true of a table kept by hand, and not something a discovered table can
// promise. Tron and Tempo are already 6, and a native pool on one of those
// would have been reported a trillion times small.
check(
  "the table still contains chains whose coin is not 18 decimals",
  CHAINS.some((c) => c.viemChain.nativeCurrency?.decimals !== 18)
);
check(
  "and six decimals render as themselves, not as a trillionth",
  formatAmount(1_500_000n, 6).replace(/\u00a0/g, " ") === "1,5"
);

check(
  "a contract that refuses is not blamed on the node",
  renderLiquidityReport({
    symbol: "X",
    name: "X",
    balances: [],
    checkedCount: 0,
    failuresByChain: {},
    attemptsByChain: {},
    supplyOnly: [{ chainKey: "bsc", unreadable: true }],
  }).includes("контракт не отдаёт выпуск")
);
check(
  "and the reader is told it cannot be withdrawn that way",
  withSupplyOnly.includes("вывести его через мосты из этого отчёта нельзя")
);
check("the report is still valid HTML", tagsBalanced(withSupplyOnly));

// It must not appear when there is nothing to say, or every report grows a
// paragraph explaining an absence that is not there.
const noSupplyOnly = renderLiquidityReport({
  symbol: "X",
  name: "X",
  balances: [],
  checkedCount: 0,
  failuresByChain: {},
  attemptsByChain: {},
  supplyOnly: [],
});
check("and it is silent when there is nothing to report", !noSupplyOnly.includes("ни один отслеживаемый мост"));

// The real answer to the customer's question, and it was in the bot all
// along. PENGU's report said it had checked seven contracts and showed one.
// The other six were on four chains that were read, came back empty, and
// were never named - the blocks are built from rows that have a balance, so
// a chain with nothing left in it produced no block, and the "пусто" line
// only ever printed inside a block that already existed.
const zeroRow = (chainKey: string, protocol: "wormhole" | "across") => ({
  protocol,
  chainKey,
  custodyAddress: PORTAL_ETH,
  tokenAddress: TOKEN,
  amount: 0n,
  decimals: 18,
});
const withEmptyChains = renderLiquidityReport({
  symbol: "PENGU",
  name: "Pudgy Penguins",
  balances: [
    {
      protocol: "hyperlane",
      chainKey: "ethereum",
      custodyAddress: PORTAL_ETH,
      tokenAddress: TOKEN,
      amount: 2_067n * 10n ** 18n,
      decimals: 18,
    },
    zeroRow("bsc", "wormhole"),
    zeroRow("bsc", "across"),
    zeroRow("robinhood", "across"),
  ],
  checkedCount: 4,
  failuresByChain: {},
  attemptsByChain: {},
  nativeOftChains: ["abstract"],
});
check("a chain read and found empty is named", withEmptyChains.includes("Robinhood Chain"));
check("with the bridge that was empty", /Robinhood Chain \(Across\)/.test(withEmptyChains));
check("and several bridges are listed together", /BNB Chain \(Wormhole, Across\)/.test(withEmptyChains));
check(
  "and the reader is told the route exists but is empty",
  withEmptyChains.includes("выводить оттуда нечего")
);
check(
  "a chain that still holds something is not called empty",
  !/Ethereum \(/.test(withEmptyChains)
);
// A minted-side chain has no custody contract by construction, and it was
// mentioned only in reports that found nothing anywhere.
check("an omnichain chain is named even when liquidity was found", withEmptyChains.includes("Abstract"));
// The claim must be about LayerZero, not about the chain: the line above it
// names vaults on chains that appear in this list too, and "there is no
// vault here" beside "here is the vault, it is empty" is the report
// contradicting itself inside one message.
check("the omnichain claim is scoped to LayerZero", withEmptyChains.includes("У LayerZero там хранилища нет"));

// And it is never made about a chain where LayerZero was just shown holding
// something. USDT's report said both about Arbitrum One in one message: an
// OFT Adapter with 7.3 million in it, and a line underneath explaining that
// there is no vault there. Both readings come from real contracts - the
// token's own address answers like a native OFT while a separate adapter
// locks collateral - but the vault the report just printed settles it.
const lzRowAndOft = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether",
  balances: [
    {
      protocol: "layerzero",
      chainKey: "arbitrum",
      custodyAddress: PORTAL_ETH,
      tokenAddress: TOKEN,
      amount: 7_327_582n * 10n ** 18n,
      decimals: 18,
    },
  ],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: {},
  nativeOftChains: ["arbitrum", "fantom"],
});
check(
  "a chain holding LayerZero collateral is not called mint-only",
  !/омничейн[^.]*Arbitrum One/.test(lzRowAndOft)
);
check("while the chains that are stay named", lzRowAndOft.includes("Fantom"));

// An empty LayerZero vault is still a vault: the claim is about the bridge
// having no vault there at all, and an empty one disproves it just as well.
const emptyLzAndOft = renderLiquidityReport({
  symbol: "USDT",
  name: "Tether",
  balances: [
    {
      protocol: "hyperlane",
      chainKey: "ethereum",
      custodyAddress: PORTAL_ETH,
      tokenAddress: TOKEN,
      amount: 5n,
      decimals: 18,
    },
    {
      protocol: "layerzero",
      chainKey: "arbitrum",
      custodyAddress: PORTAL_ETH,
      tokenAddress: TOKEN,
      amount: 0n,
      decimals: 18,
    },
  ],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: {},
  nativeOftChains: ["arbitrum"],
});
check(
  "an empty LayerZero vault also disproves the claim",
  !emptyLzAndOft.includes("омничейн")
);
check("the report stays valid HTML", tagsBalanced(withEmptyChains));

const nothingCalledEmpty = renderLiquidityReport({
  symbol: "X",
  name: "X",
  balances: [
    {
      protocol: "hyperlane",
      chainKey: "ethereum",
      custodyAddress: PORTAL_ETH,
      tokenAddress: TOKEN,
      amount: 1n,
      decimals: 18,
    },
  ],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: {},
});
check("and nothing is claimed empty when nothing was", !nothingCalledEmpty.includes("хранилища пусты"));

const overlapping = renderLiquidityReport({
  symbol: "PENGU",
  name: "Pudgy Penguins",
  balances: [
    {
      protocol: "hyperlane",
      chainKey: "solanamainnet",
      custodyAddress: "9WzD",
      tokenAddress: "2zMM",
      amount: 1n,
      decimals: 6,
    },
    zeroRow("bsc", "across"),
  ],
  checkedCount: 2,
  failuresByChain: {},
  attemptsByChain: {},
  nativeOftChains: ["bsc"],
});
check(
  "a chain in both lists is told where to read the other one",
  overlapping.includes("проверены отдельно")
);
const noOverlap = renderLiquidityReport({
  symbol: "PENGU",
  name: "Pudgy Penguins",
  balances: [
    {
      protocol: "hyperlane",
      chainKey: "solanamainnet",
      custodyAddress: "9WzD",
      tokenAddress: "2zMM",
      amount: 1n,
      decimals: 6,
    },
  ],
  checkedCount: 1,
  failuresByChain: {},
  attemptsByChain: {},
  nativeOftChains: ["bsc"],
});
check("and without an overlap that pointer is not added", !noOverlap.includes("проверены отдельно"));
// Two-letter tickers must not count as variants of each other. "AAA" sorts
// first, so it can only lose here if "OP" was wrongly treated as a variant
// of "OPX" - which is the whole thing being guarded against.
check("a short prefix is not a variant", preferredRouteId(["OP/route", "AAA/route"], "OPX") === "AAA/route");
check("while a long enough one is", preferredRouteId(["USDC/route", "AAA/route"], "USDCE") === "USDC/route");

// The cut must not leave half an entity or half a tag behind, which is what
// makes Telegram reject the whole message rather than render it short.
const cutMidTag = capToTelegramLimit(`<b>${"а".repeat(4200)}<code>хвост`);
check("a cut never ends inside a tag", !/<[^>]*$/.test(cutMidTag));
check("nor inside an entity", !/&[^;\s]*$/.test(cutMidTag.replace(/\n.*$/s, "")));

// --- chains the bot adds by itself -------------------------------------------
//
// Last in the file on purpose: these register a chain, and registering
// mutates the table every check above reads.

check("a slug becomes a stable key", keyForSlug("polygon-pos") === "polygonpos");
check("and an empty one still becomes something", keyForSlug("---") === "chain");
check(
  "the key does not change between runs",
  keyForSlug("Arbitrum-One") === keyForSlug("arbitrum-one")
);

// The registries that ship with the bot have to describe a chain before it
// can be added: the token API says a network exists, not how to reach it.
const soneium = factsFor(1868);
check("a chain both registries know is described", (soneium?.rpcUrls.length ?? 0) > 0);
check("with its native currency", soneium?.nativeCurrency.symbol === "ETH");
check("a chain neither registry knows is not", factsFor(424_242_424_242) === undefined);
// viem ships testnets beside mainnets, and this bot answers questions about
// real liquidity: a testnet added under a name that looks like the real
// chain would report balances in play money. 999999999 is Zora Sepolia.
check("a testnet is not a chain to add", factsFor(999_999_999) === undefined);
check(
  "endpoints wanting a key are left out",
  factsFor(1868)?.rpcUrls.every((u) => !/\$\{|API_KEY/i.test(u)) === true
);

const invented: Parameters<typeof registerChain>[0] = {
  key: "selftestchain",
  label: "Selftest Chain",
  viemChain: {
    id: 987_654_321,
    name: "Selftest Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://example.invalid"] } },
  } as any,
  rpcEnvVar: "SELFTESTCHAIN_RPC_URL",
  defaultRpcUrls: ["https://example.invalid"],
  explorerTxUrl: (h) => h,
  explorerAddressUrl: (a) => a,
  // "ethereum" is deliberately included: a discovered chain must not take a
  // name a person already types for another one.
  aliases: ["selftestchain", "ethereum"],
};

check("a new chain is registered", registerChain(invented) === true);
check("and is then findable by key", getChain("selftestchain")?.label === "Selftest Chain");
check("and by chain id", getChainByChainId(987_654_321)?.key === "selftestchain");
check("registering it twice changes nothing", registerChain(invented) === false);
check(
  "a different key on the same chain id is refused",
  registerChain({ ...invented, key: "selftestchaintwo", aliases: ["selftestchaintwo"] }) === false
);
check(
  "the same key on a different chain id is refused",
  registerChain({
    ...invented,
    viemChain: { ...invented.viemChain, id: 987_654_322 } as any,
    aliases: [],
  }) === false
);
// The alias guard: Ethereum was there first and must stay reachable.
check("an existing alias is not taken over", resolveChain("ethereum")?.key === "ethereum");
check("the chain's own alias does resolve", resolveChain("selftestchain")?.key === "selftestchain");

// The canonical registry is asked only for the chains the local ones cannot
// describe, and its answers need the same filtering: it keeps testnets in
// the same directory as mainnets and does not label them.
const moonbeamEntry = {
  name: "Moonbeam",
  chainId: 1284,
  nativeCurrency: { name: "Glimmer", symbol: "GLMR", decimals: 18 },
  faucets: [],
  rpc: ["https://rpc.api.moonbeam.network", "wss://wss.api.moonbeam.network"],
  explorers: [{ name: "moonscan", url: "https://moonbeam.moonscan.io" }],
};
const moonbeam = factsFromRegistryEntry(moonbeamEntry, 1284);
check("a registry entry becomes usable facts", moonbeam?.nativeCurrency.symbol === "GLMR");
check("with only the https endpoints", moonbeam?.rpcUrls.length === 1);
check("and its explorer", moonbeam?.explorerUrl === "https://moonbeam.moonscan.io");

check(
  "a faucet gives a testnet away",
  factsFromRegistryEntry({ ...moonbeamEntry, faucets: ["https://faucet.example"] }, 1284) === undefined
);
check(
  "a deprecated chain is not added",
  factsFromRegistryEntry({ ...moonbeamEntry, status: "deprecated" }, 1284) === undefined
);
check(
  "an entry for another chain id is refused",
  factsFromRegistryEntry(moonbeamEntry, 1285) === undefined
);
check(
  "an entry with no reachable endpoint is not facts",
  factsFromRegistryEntry({ ...moonbeamEntry, rpc: ["https://rpc.example/${API_KEY}"] }, 1284) === undefined
);
check("nothing at all is not facts", factsFromRegistryEntry(undefined, 1284) === undefined);

// -----------------------------------------------------------------------------
// A registry refusing a chain and a registry never having heard of it are
// opposite answers, and treating them as one put Sepolia in the live table.
// Every registry refuses it - viem and Hyperlane by their testnet flag, the
// canonical one by its faucet list - so "described by nobody" came back for
// it too, and the bridge's own facts stood in for the missing description.
// Play money under a real chain's name is the worst thing this table can do.
// -----------------------------------------------------------------------------

check(
  "a chain the registry names a testnet is refused",
  refusalFromRegistryEntry({ chainId: 9070, name: "Apex Fusion - Nexus testnet", faucets: [] }, 9070) !== undefined
);
check(
  "and so is a deprecated one",
  refusalFromRegistryEntry({ chainId: 1284, faucets: [], status: "deprecated" }, 1284) !== undefined
);
check(
  "a faucet list is the last hint, and still a refusal on its own",
  refusalFromRegistryEntry({ chainId: 11155111, name: "Sepolia", faucets: ["https://faucet.example"] }, 11155111) !== undefined
);
// A live mainnet must not be refused, and neither must an entry the registry
// simply does not carry - unknown still goes to the probe, which is how the
// chains no price API lists get read at all.
check("a mainnet is not refused", refusalFromRegistryEntry({ chainId: 1284, name: "Moonbeam", faucets: [] }, 1284) === undefined);
check("an entry for another chain id is not a refusal of this one", refusalFromRegistryEntry({ chainId: 1285, faucets: ["x"] }, 1284) === undefined);
check("and a registry with nothing to say refuses nothing", refusalFromRegistryEntry(undefined, 1284) === undefined);
// The faucet list must never outrank a registry that says "mainnet" outright.
// Read as a verdict it threw fourteen live chains out of the table in one
// scan - Meter, Skale, Beam, Rollux, EDU Chain and Injective among them,
// every one of which viem describes as a mainnet.
check(
  "a mainnet name is not read as a testnet name",
  refusalFromRegistryEntry({ chainId: 82, name: "Meter Mainnet", chain: "METER", faucets: [] }, 82) === undefined
);

// -----------------------------------------------------------------------------
// Why a candidate's endpoints failed. "No node answered" hid the difference
// between a server refusing this bot's IP, which a key opens, and a hostname
// that does not resolve, which needs a different endpoint entirely.
// -----------------------------------------------------------------------------

check("no endpoints at all says so", reasonForChain([]) === "нет публичных узлов");
// The most actionable failure wins rather than the first: a chain where one
// node refuses this server is a chain a key opens, and reporting the dead
// hosts instead sends the reader hunting for an endpoint they already have.
check(
  "a refusal outranks a dead host",
  /отказывают/.test(
    reasonForChain([
      { url: "https://a.example", ok: false, reason: "ENOTFOUND (a.example)" },
      { url: "https://b.example", ok: false, reason: "HTTP 403 (b.example)" },
    ])
  )
);
check(
  "a node serving another network is named as such",
  /отдаёт сеть/.test(reasonForChain([{ url: "https://a.example", ok: false, reason: "узел отдаёт сеть 1, а не 1996" }]))
);
check(
  "one reason shared by every endpoint is said once",
  reasonForChain([
    { url: "https://a.example", ok: false, reason: "ENOTFOUND (a.example)" },
    { url: "https://b.example", ok: false, reason: "ENOTFOUND (a.example)" },
  ]) === "ENOTFOUND (a.example) и ещё 1"
);
check(
  "and different reasons are both shown",
  /ни один из 2 узлов/.test(
    reasonForChain([
      { url: "https://a.example", ok: false, reason: "ENOTFOUND (a.example)" },
      { url: "https://b.example", ok: false, reason: "не ответил вовремя (b.example)" },
    ])
  )
);

// Node wraps the real network error in an opaque "fetch failed", so the cause
// has to be unwrapped or every dead endpoint reports the same sentence.
check("the cause's code is what gets reported", describeProbeError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } })) === "ENOTFOUND");
check("a timeout is named as one", describeProbeError(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })) === "не ответил вовремя");
check("and a bare error still says something", describeProbeError(new Error("боль")) === "боль");

// Naming the failing host made every reason unique, so forty-five chains
// became forty-five groups and the report ran past Telegram's limit - taking
// with it the part that says what the bot added, which is the half nobody
// can reconstruct. Grouped by the kind of problem instead, because that is
// what decides the response.
check("every testnet wording lands in one group", reasonClass("viem знает её как тестовую сеть") === reasonClass("реестр помечает её устаревшей"));
check("and so does every dead endpoint", reasonClass("ENOTFOUND (a.example)") === reasonClass("ни один из 2 узлов не отозвался: ETIMEDOUT (b.example); HTTP 502 (c.example)"));
// These four need four different responses, so they must not merge.
const classes = [
  reasonClass("viem знает её как тестовую сеть"),
  reasonClass("узлы отказывают этому серверу: HTTP 403 (rpc.ankr.com)"),
  reasonClass("нет публичных узлов"),
  reasonClass("ни один реестр её не описывает"),
  reasonClass("ENOTFOUND (a.example)"),
];
check("problems needing different answers stay apart", new Set(classes).size === 5, classes.join(" | "));
check("a refusal is labelled as fixable with a key", /RPC/.test(reasonClass("узлы отказывают этому серверу: HTTP 429 (x)")));

// -----------------------------------------------------------------------------
// Injective is two chains with one name: a Cosmos chain read over REST and,
// since LayerZero named it, an EVM chain read over JSON-RPC. Both landed on
// the key "injective" - and a key is what /track stores, what a chain filter
// matches and what a report labels a row with.
// -----------------------------------------------------------------------------

check("a free name is kept as it is", freeKeyFor("polygon-pos", () => false) === "polygonpos");
check("a name another table already answers to is suffixed", freeKeyFor("injective", (k) => k === "injective") === "injectiveevm");
check("and suffixed again if that is taken too", freeKeyFor("injective", (k) => k !== "injectiveevmchain") === "injectiveevmchain");

// A file is not a decision. Sepolia was written to the stored table by a scan
// that could not yet tell a refusal from a silence, and a restart would have
// put it straight back - so the rule is applied on the way in as well.
check(
  "a stored testnet is not restored",
  defFromDiscovered({
    slug: "sepolia",
    chainId: 11155111,
    name: "Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.sepolia.org"],
    rpcUrl: "https://rpc.sepolia.org",
  }) === undefined
);
check(
  "while a stored mainnet still is",
  defFromDiscovered({
    slug: "sanko",
    chainId: 1996,
    name: "Sanko",
    nativeCurrency: { name: "DMT", symbol: "DMT", decimals: 18 },
    rpcUrls: ["https://mainnet.sanko.xyz"],
    rpcUrl: "https://mainnet.sanko.xyz",
  }) !== undefined
);

// The registries are merged, not tried in order, and that is the whole
// point: forty-four candidates were refused with "the one node did not
// answer" - one node, because that is all the local registries carried.
// Ethereum Classic has five in the canonical registry, ThunderCore three,
// Boba BNB four. Live chains whose first listed endpoint went stale.
const localFacts = {
  name: "Astar zkEVM",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://one.example"],
  explorerUrl: undefined,
};
const registryFacts2 = {
  name: "Astar zkEVM Mainnet",
  nativeCurrency: { name: "Something Else", symbol: "XXX", decimals: 6 },
  rpcUrls: ["https://one.example", "https://two.example", "https://three.example"],
  explorerUrl: "https://explorer.example",
};
const merged = mergeFacts(localFacts, registryFacts2);
check("endpoints from both registries are kept", merged?.rpcUrls.length === 3);
check("and the same node is not counted twice", merged?.rpcUrls.filter((u) => u === "https://one.example").length === 1);
check("the local name wins", merged?.name === "Astar zkEVM");
check("and so does the local currency", merged?.nativeCurrency.symbol === "ETH");
check("an explorer is taken from whichever has one", merged?.explorerUrl === "https://explorer.example");
check("either side alone still works", mergeFacts(undefined, registryFacts2)?.rpcUrls.length === 3);
check("and neither side is nothing", mergeFacts(undefined, undefined) === undefined);

// Every candidate has to land in exactly one bucket. When one did not, the
// only sign was arithmetic: 120 known plus 0 added plus 68 refused, out of
// 275 listed. Eighty-seven chains had passed every check and been dropped
// without a word, because a second scan had started while the first was
// still running and the table was already full by the time it finished.
const balanced: DiscoveryReport = {
  at: new Date(),
  listed: 275,
  fromBridges: 9,
  learnedEndpoints: 31,
  known: 120,
  added: [{ key: "a", label: "A", chainId: 1, rpcUrl: "https://a.example" }],
  rejected: [{ label: "B", chainId: 2, reason: "нет узлов" }],
  duplicates: 153,
};
// -----------------------------------------------------------------------------
// Endpoints learned at runtime. /diag found fourteen chains whose node
// refuses this server and seven whose only listed node is broken; the
// bridges publish endpoints for the chains they are on, and those were being
// used only for chains being ADDED and thrown away for chains already in the
// table - exactly backwards, since a chain already in the table with one
// dead node is the one that needs an alternate.
// -----------------------------------------------------------------------------

forgetLearnedEndpoints();
check("nothing is known before anything is learned", learnedEndpoints(1).length === 0);
check(
  "endpoints are recorded against their chain id",
  learnEndpoints(1, ["https://one.example", "https://two.example"]) === 2 &&
    learnedEndpoints(1).length === 2
);
// Additive on purpose: a later refresh publishing fewer endpoints must not
// take away the one that is currently the only working node.
check("a second batch adds rather than replaces", learnEndpoints(1, ["https://three.example"]) === 1 && learnedEndpoints(1).length === 3);
check("and the same endpoint is not counted twice", learnEndpoints(1, ["https://one.example"]) === 0 && learnedEndpoints(1).length === 3);
check("a trailing slash is the same endpoint", learnEndpoints(1, ["https://one.example/"]) === 0);
// An endpoint needing a key the bot does not have is not an endpoint, and
// plain http is not one either.
check("a templated endpoint is refused", learnEndpoints(2, ["https://rpc.example/${API_KEY}"]) === 0);
check("and so is an insecure one", learnEndpoints(2, ["http://rpc.example"]) === 0);
check("a nonsense chain id is refused rather than stored", learnEndpoints(0, ["https://x.example"]) === 0);
check("the summary counts chains and endpoints apart", learnedSummary().chains === 1 && learnedSummary().endpoints === 3);
forgetLearnedEndpoints();
check("and clearing leaves nothing behind", learnedSummary().endpoints === 0);

check(
  "a report accounts for every candidate",
  balanced.known + balanced.added.length + balanced.rejected.length + balanced.duplicates ===
    balanced.listed
);

// Two sources, one candidate list. The price API names the chains worth
// pricing tokens on and the bridge registry names the chains it is deployed
// on; only the second knew about Sanko, Glue and Apex Fusion Nexus, and all
// three carry Stargate pools.
const bridgeOnly = {
  slug: "sanko",
  chainId: 1996,
  name: "Sanko",
  nativeCurrency: { name: "DMT", symbol: "DMT", decimals: 18 },
  rpcUrls: ["https://mainnet.sanko.xyz"],
  explorerUrl: "https://explorer.sanko.xyz",
};
const bothKnow = {
  slug: "base-lz-spelling",
  chainId: 8453,
  name: "Base, as the bridge spells it",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://from-the-bridge.example"],
  explorerUrl: undefined,
};
const candidates = mergeCandidates(
  [{ id: "base", chainId: 8453, name: "Base" }],
  [bridgeOnly, bothKnow]
);
check("a chain only the bridge names is still a candidate", candidates.some((c) => c.chainId === 1996));
check("and is counted as coming from there", candidates.find((c) => c.chainId === 1996)?.fromBridgeOnly === true);
check("with the endpoints the bridge published", candidates.find((c) => c.chainId === 1996)?.facts?.rpcUrls.length === 1);
check("a chain both name appears once", candidates.filter((c) => c.chainId === 8453).length === 1);
// The slug becomes the chain key, and that key is already in the database
// behind every /track subscription. Letting a second source rename it would
// orphan them all.
check("and keeps the slug it already had", candidates.find((c) => c.chainId === 8453)?.slug === "base");
check("but takes the bridge's endpoints too", candidates.find((c) => c.chainId === 8453)?.facts?.rpcUrls.length === 1);
check("without being counted as a bridge-only find", candidates.find((c) => c.chainId === 8453)?.fromBridgeOnly === false);
// A platform the price API lists without an EVM chain id is not something a
// chain id can be probed for.
check(
  "a platform with no chain id is not a candidate",
  mergeCandidates([{ id: "ton", chainId: undefined, name: "TON" }], []).length === 0
);
check("either source alone works", mergeCandidates([], [bridgeOnly]).length === 1 && mergeCandidates([{ id: "base", chainId: 8453, name: "Base" }], []).length === 1);


// -----------------------------------------------------------------------------

asyncChecks().then(
  () => {
    console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
    if (failures > 0) process.exit(1);
  },
  (err) => {
    console.error("async checks threw:", err);
    process.exit(1);
  }
);
