/**
 * Offline self-test: exercises the pure logic that would otherwise only be
 * observable against a live RPC and a live Telegram bot. No network needed.
 *
 * Run with: npm run selftest
 */
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
import { getChain } from "../src/config/chains";
import { renderLiquidityReport } from "../src/bot/render";
import { extractDeployments } from "../src/bridges/layerzero";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`ok    ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

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
  heavyReport.length < 4096,
  `length=${heavyReport.length}`
);
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
    wormhole: 2,
    hyperlane: 0,
    layerzero: 0,
  },
});
check("the report breaks down where its contracts came from", scoped.includes("Откуда взялись контракты"));
check("it names the counts per bridge", scoped.includes("Hyperlane — 0") && scoped.includes("Wormhole — 2"));
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

// -----------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
if (failures > 0) process.exit(1);
