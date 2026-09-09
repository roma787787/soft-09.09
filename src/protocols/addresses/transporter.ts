import type { Address } from "viem";

/**
 * "Transporter" (transporter.io) is a bridging front-end, not a protocol
 * with its own bridge contracts: it routes transfers through Chainlink CCIP
 * (Router contracts) and, for native USDC, directly through Circle's CCTP.
 * We therefore detect BOTH underlying rails and label them as "Transporter".
 *
 * CCIP Router addresses (chain-specific, unlike LayerZero's Endpoint).
 * Source: Chainlink CCIP directory / explorer listings, snapshot 2026-09-09.
 * https://docs.chain.link/ccip/directory/mainnet
 */
export const CCIP_ROUTER_BY_CHAIN: Partial<Record<string, Address>> = {
  ethereum: "0x80226fc0EE2b096224EeAc085Bb9a8cba1146f7D",
  optimism: "0x3206695CaE29952f4b0c22a169725A865bc8Ce0f",
  base: "0x881e3A65B4d4a04dD529061dd0071cf975F58bCD",
};

/**
 * Circle CCTP contracts. TokenMessenger/MessageTransmitter addresses are
 * deployed via CREATE2 and tend to repeat across chains for a given CCTP
 * version, but we only assert what we've confirmed rather than assuming
 * uniformity everywhere.
 * Source: https://developers.circle.com/stablecoins/evm-smart-contracts
 */
export const CCTP_TOKEN_MESSENGER_BY_CHAIN: Partial<Record<string, Address>> = {
  ethereum: "0xBd3fa81B58Ba92a82136038B25aDec7066af3155",
};

export const CCTP_MESSAGE_TRANSMITTER_BY_CHAIN: Partial<Record<string, Address>> = {
  ethereum: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  arbitrum: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
};

/**
 * CCTP domain IDs (protocol-wide constants).
 * Source: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
 */
export const CCTP_DOMAIN_BY_CHAIN: Record<string, number> = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  base: 6,
  polygon: 7,
};
