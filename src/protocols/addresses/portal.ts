import type { Address } from "viem";

/**
 * Portal = Wormhole's Token Bridge contract ("Wormhole: Token Bridge" on
 * explorers). Different address per chain. Entries below were confirmed via
 * block explorer listings; chains not listed are left out on purpose rather
 * than guessed - detection still works through live ABI probing
 * (Bridge.wormhole() / Bridge.chainId()), this table only raises confidence
 * and lets us label known peer bridges.
 *
 * Source: https://wormhole.com/docs/build/reference/contract-addresses/
 * and explorer listings (Etherscan/Polygonscan/Arbiscan/Optimistic Etherscan/
 * BscScan). Snapshot 2026-09-09.
 */
export const PORTAL_TOKEN_BRIDGE_BY_CHAIN: Partial<Record<string, Address>> = {
  ethereum: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
  polygon: "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE",
  arbitrum: "0x0b2402144B366A632D14B83F244D2E0e21bD39c",
  optimism: "0x1D68124e65faFC907325E3EDbF8c4d84499DAa8b",
  bsc: "0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E",
};

/**
 * Wormhole chain IDs (protocol-wide constants, stable for years).
 * Source: https://wormhole.com/docs/build/reference/chain-ids/
 */
export const WORMHOLE_CHAIN_ID_BY_CHAIN: Record<string, number> = {
  ethereum: 2,
  bsc: 4,
  polygon: 5,
  avalanche: 6,
  arbitrum: 23,
  optimism: 24,
  base: 30,
};
