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

// -----------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
if (failures > 0) process.exit(1);
