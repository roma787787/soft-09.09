import type { Address } from "viem";

export type BridgeProtocol = "layerzero" | "hyperlane" | "wormhole";

export const BRIDGE_LABELS: Record<BridgeProtocol, string> = {
  layerzero: "LayerZero (OFT Adapter)",
  hyperlane: "Hyperlane (Warp Route)",
  wormhole: "Wormhole (Token Bridge)",
};

/**
 * A contract that holds the token on one chain: what the bot reads
 * balanceOf() against to answer "how much can actually come out here".
 */
export interface Custodian {
  protocol: BridgeProtocol;
  chainKey: string;
  /** The lock/custody contract holding the token. */
  custodyAddress: Address;
  /** The ERC-20 whose balance we read on that contract. */
  tokenAddress: Address;
  /** Extra detail for the reply, e.g. the warp route's registry id. */
  note?: string;
}
