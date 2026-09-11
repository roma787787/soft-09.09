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
import { isFragile, orderEndpoints } from "../src/services/rpcHealth";
import { attemptsFor, concurrencyFor } from "../src/services/balances";
import { EXTRA_RPC_URLS_BY_CHAIN_ID } from "../src/config/rpcs.generated";
import { PORTAL_CHAINS, portalCustodyAddress } from "../src/config/portalChains";
import { TON_CHAIN, toTonAddress } from "../src/config/tonChain";
import { entriesForSymbol, extractNonEvmDeployments, tallyDeploymentsByChain } from "../src/bridges/layerzero";
import { classifyChain, gapsFrom } from "../src/bot/commands/lzgaps";
import { describeBody, parseJettonMaster, parseJettonWallets, symbolsAgree } from "../src/bridges/ton";
import { aptosCalls } from "../src/bridges/portalNonEvm";
import {
  factsFor,
  factsFromRegistryEntry,
  keyForSlug,
  mergeFacts,
  type DiscoveryReport,
} from "../src/services/chainDiscovery";
import { describeError, groupByReason, mostActionable, splitFailures } from "../src/bot/commands/diag";
import { deploymentsOnChain } from "../src/bot/commands/lzprobe";
import { formatAmount } from "../src/services/balances";
import { findHyperlaneCustodians } from "../src/bridges/hyperlane";
import { svmEscrows } from "../src/bridges/svm";
import { resolveCustodians } from "../src/bridges";
import { getChain, getChainByChainId, registerChain, resolveChain, resolveAnyChain, CHAINS } from "../src/config/chains";
import { capToTelegramLimit, renderLiquidityReport } from "../src/bot/render";
import { preferredRouteId } from "../src/bridges/hyperlane";
import { extractDeployments, aliasKeysFor, type RegistryDeploymentInfo } from "../src/bridges/layerzero";
import { dedupeCustodians } from "../src/bridges";
import { extractEids, lastMetadataChainCount, explainMissing, normaliseLzKey } from "../src/bridges/lzMetadata";
import { resolveRegistryDeployments } from "../src/bot/commands/liquidity";
import type { Custodian } from "../src/bridges/types";
import type { Address } from "viem";
import { validateAddress } from "../src/protocols/addresses/validate";
import { endpointsWithOverride, rpcUrlsFor } from "../src/config/env";
import { EXTRA_RPC_URLS_BY_CHAIN_ID } from "../src/config/rpcs.generated";
import { PORTAL_CHAINS, portalCustodyAddress } from "../src/config/portalChains";
import { TON_CHAIN, toTonAddress } from "../src/config/tonChain";
import { entriesForSymbol, extractNonEvmDeployments, tallyDeploymentsByChain } from "../src/bridges/layerzero";
import { classifyChain, gapsFrom } from "../src/bot/commands/lzgaps";
import { describeBody, parseJettonMaster, parseJettonWallets, symbolsAgree } from "../src/bridges/ton";
import { aptosCalls } from "../src/bridges/portalNonEvm";
import { SVM_CHAINS } from "../src/config/svmChains";
import { COSMOS_CHAINS } from "../src/config/cosmosChains";
import { findCosmosRoutes, findNativeModuleRoutes } from "../src/bridges/cosmos";
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
check("and points at the manual LayerZero config", trulyNothing.includes("layerzero-lockboxes.json"));

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
check("the report names the bridges it asked and found nothing on", asked.includes("Проверены, но хранилищ"));
check("and lists them by name", asked.includes("Stargate") && asked.includes("CCIP"));
check("it does not list a bridge that did contribute", !/хранилищ[^\n]*Hyperlane/.test(asked));
check("a known reason for the gap is printed", asked.includes("пулы только под USDC, USDT."));
// Without the caller vouching for what it asked, the report must not invent
// a list of bridges it cannot stand behind.
check("no such line when the caller did not say what it checked", !scoped.includes("Проверены, но хранилищ"));

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
        aptos: { address: "0x2", type: "OFT" },
      },
    },
  ],
});
const byKey = (key: string) => tally.find((t) => t.lzChainKey === key);
check("every chain in the registry is counted", byKey("ethereum")?.deployments === 2);
check("a locking deployment is counted as such", byKey("ethereum")?.locking === 1);
check("a published escrow counts as locking", byKey("solana")?.locking === 2);
check("a minting deployment is not counted as locking", byKey("aptos")?.locking === 0);
check("chains are ordered by how much sits on them", tally[0].deployments >= tally[tally.length - 1].deployments);

const gaps = gapsFrom(tally);
check("a chain with a reader is not a gap", !gaps.some((g) => g.lzChainKey === "solana"));
check("and neither is an EVM one", !gaps.some((g) => g.lzChainKey === "ethereum"));
// Aptos the bot knows - Wormhole reads it - but nothing reads what LayerZero
// locks there, which is the distinction the command exists to draw.
check("a chain read by another bridge is still a LayerZero gap", gaps.some((g) => g.lzChainKey === "aptos"));
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

function deployment(chainKey: string, locksCollateral: boolean, address: Address = ADAPTER): RegistryDeploymentInfo {
  return { chainKey, address, locksCollateral, rawType: locksCollateral ? "OFTAdapter" : "OFT" };
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
}

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
check("with how much is there", /выпущено\s*5\s*000\s*000/.test(withSupplyOnly.replace(/\u00a0/g, " ")));
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
  known: 120,
  added: [{ key: "a", label: "A", chainId: 1, rpcUrl: "https://a.example" }],
  rejected: [{ label: "B", chainId: 2, reason: "нет узлов" }],
  duplicates: 153,
};
check(
  "a report accounts for every candidate",
  balanced.known + balanced.added.length + balanced.rejected.length + balanced.duplicates ===
    balanced.listed
);


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
