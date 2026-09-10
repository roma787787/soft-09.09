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
import { parseCmcInfoResponse } from "../src/services/cmc";
import { formatAmount } from "../src/services/balances";
import { findHyperlaneCustodians } from "../src/bridges/hyperlane";
import { resolveCustodians } from "../src/bridges";
import { getChain, resolveChain, CHAINS } from "../src/config/chains";
import { renderLiquidityReport } from "../src/bot/render";
import { extractDeployments, aliasKeysFor, type RegistryDeploymentInfo } from "../src/bridges/layerzero";
import { dedupeCustodians } from "../src/bridges";
import { resolveRegistryDeployments } from "../src/bot/commands/liquidity";
import type { Custodian } from "../src/bridges/types";
import type { Address } from "viem";
import { validateAddress } from "../src/protocols/addresses/validate";
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

// --- CoinMarketCap response parsing ------------------------------------------

const cmcBody = {
  status: { error_code: 0 },
  data: {
    ARB: [
      {
        name: "Arbitrum",
        symbol: "ARB",
        platform: { name: "Ethereum", slug: "ethereum", token_address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1" },
        contract_address: [
          {
            contract_address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
            platform: { name: "Arbitrum", coin: { slug: "arbitrum" } },
          },
          {
            contract_address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",
            platform: { name: "Ethereum", coin: { slug: "ethereum" } },
          },
          {
            contract_address: "0xf2c2b3d6a5b1d4b2c8e0a9f7d6c5b4a3e2d1c0b9",
            platform: { name: "Some Chain We Do Not Support", coin: { slug: "whatever" } },
          },
          { contract_address: "not-an-address", platform: { name: "Broken", coin: { slug: "broken" } } },
        ],
      },
    ],
  },
};

const parsed = parseCmcInfoResponse(cmcBody, "ARB");
check("parses the CMC payload", parsed?.symbol === "ARB" && parsed?.name === "Arbitrum");
check(
  "maps CMC platform names onto our chain keys",
  parsed?.platforms.find((p) => p.chainKey === "arbitrum")?.tokenAddress ===
    "0x912CE59144191C1204E64559FE8253a0e49E6548"
);
check(
  "keeps an unsupported network without a chain key instead of dropping it",
  parsed?.platforms.some((p) => p.chainKey === undefined && p.platformName.includes("Do Not Support")) === true
);
check("skips malformed addresses", parsed?.platforms.every((p) => p.tokenAddress.length === 42) === true);
check(
  "does not duplicate a platform present in both fields",
  parsed?.platforms.filter((p) => p.chainKey === "ethereum").length === 1
);
check("returns undefined for an unknown ticker", parseCmcInfoResponse({ data: {} }, "NOPE") === undefined);

check("maps the BNB Chain spelling CMC uses", (() => {
  const body = {
    data: {
      X: [
        {
          name: "X",
          symbol: "X",
          contract_address: [
            {
              contract_address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
              platform: { name: "BNB Smart Chain (BEP20)", coin: { slug: "bnb" } },
            },
          ],
        },
      ],
    },
  };
  return parseCmcInfoResponse(body, "X")?.platforms[0]?.chainKey === "bsc";
})());

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
check("it names the networks CoinMarketCap listed", scoped.includes("Ethereum, BNB Chain"));
check("it names networks outside the bot's coverage", scoped.includes("TON"));
check("the scoped report still fits the message limit", scoped.length < 4096);

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
  // CoinMarketCap already told us which ERC-20 lives there.
  const fallback = await resolveRegistryDeployments(
    [deployment("ethereum", true)],
    [{ chainKey: "ethereum", platformName: "Ethereum", tokenAddress: TOKEN }],
    new Set(),
    "TKN",
    async () => undefined
  );
  check("an unreadable adapter falls back to the listed token", fallback.custodians[0]?.tokenAddress === TOKEN);

  // A deployment found under a neighbouring ticker must prove itself. The
  // interesting case is a chain CoinMarketCap does not list: that is exactly
  // where a bridged deployment adds coverage, so requiring CMC there would
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
  // one CoinMarketCap lists, and to anyone asking whether a transfer can be
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
  check("on a chain CMC does not list, the token's own symbol is the proof", aliasUnlisted.custodians.length === 1);

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
