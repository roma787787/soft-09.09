import type { Address } from "viem";

/**
 * LayerZero V2 EndpointV2 is deployed at the SAME address on essentially every
 * EVM chain LayerZero V2 supports (deterministic deployment). Confirmed across
 * Ethereum/Polygon/BSC/Linea/Taiko explorers.
 * Source: https://docs.layerzero.network/v2/deployments/deployed-contracts
 */
export const LZ_ENDPOINT_V2: Address = "0x1a44076050125825900e736c501f859c50fE728c";

/**
 * Best-effort static table of LayerZero V2 Endpoint IDs (eid), used only to
 * LABEL peers that live on chains we don't have an RPC connection to. For any
 * chain we DO have an RPC client for, the bot resolves its eid live by
 * calling `eid()` on that chain's EndpointV2 contract instead of trusting
 * this table, so the numbers below never gate detection logic - only display.
 *
 * Cross-check / refresh from:
 * https://docs.layerzero.network/v2/deployments/deployed-contracts
 */
export const LZ_V2_EID_BY_CHAIN: Record<string, number> = {
  ethereum: 30101,
  bsc: 30102,
  avalanche: 30106,
  polygon: 30109,
  arbitrum: 30110,
  optimism: 30111,
  base: 30184,
};
