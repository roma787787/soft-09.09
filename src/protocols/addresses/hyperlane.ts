import type { Address } from "viem";

/**
 * Hyperlane Mailbox addresses, one per chain (NOT the same address across
 * chains, unlike LayerZero's EndpointV2).
 *
 * Source: hyperlane-xyz/hyperlane-registry, chains/<name>/addresses.yaml
 * https://github.com/hyperlane-xyz/hyperlane-registry
 * Snapshot taken 2026-09-09 - re-check against the registry if a chain adds
 * a new deployment or migrates its mailbox.
 */
export const HYPERLANE_MAILBOX_BY_CHAIN: Record<string, Address> = {
  ethereum: "0xc005dc82818d67AF737725bD4bf75435d065D239",
  arbitrum: "0x979Ca5202784112f4738403dBec5D0F3B9daabB9",
  optimism: "0xd4C1905BB1D26BC93DAC913e13CaCC278CdCC80D",
  base: "0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D",
  polygon: "0x5d934f4e2f797775e53561bB72aca21ba36B96BB",
  bsc: "0x2971b9Aec44bE4eb673DF1B88cDB57b96eefe8a4",
  avalanche: "0xFf06aFcaABaDDd1fb08371f9ccA15D73D51FeBD6",
};

/**
 * Hyperlane domain IDs generally match the chain's EVM chainId, but this is
 * a convention, not a guarantee (Hyperlane also runs on non-EVM chains with
 * their own ID spaces). The bot resolves each configured chain's REAL domain
 * live via `Mailbox.localDomain()`, so this table is only a display fallback
 * for chains we don't have an RPC client for.
 */
export const HYPERLANE_DOMAIN_BY_CHAIN: Record<string, number> = {
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  polygon: 137,
  bsc: 56,
  avalanche: 43114,
};
