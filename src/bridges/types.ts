import type { Address } from "viem";

export type BridgeProtocol = "layerzero" | "hyperlane" | "wormhole" | "across";

export const BRIDGE_LABELS: Record<BridgeProtocol, string> = {
  layerzero: "LayerZero (OFT Adapter)",
  hyperlane: "Hyperlane (Warp Route)",
  wormhole: "Wormhole (Token Bridge)",
  across: "Across (SpokePool)",
};

/** Short name for the "where did these contracts come from" line. */
export const BRIDGE_SHORT_LABELS: Record<BridgeProtocol, string> = {
  layerzero: "LayerZero",
  hyperlane: "Hyperlane",
  wormhole: "Wormhole",
  across: "Across",
};

/**
 * What one contract of this bridge is called, in the three Russian forms the
 * count needs. A warp route, an adapter and a shared vault are different
 * things, and calling them all "контракты" loses the distinction that
 * explains why one bridge contributes twelve rows and another contributes
 * one.
 */
export const BRIDGE_UNITS: Record<BridgeProtocol, [one: string, few: string, many: string]> = {
  layerzero: ["адаптер", "адаптера", "адаптеров"],
  hyperlane: ["маршрут", "маршрута", "маршрутов"],
  wormhole: ["сеть", "сети", "сетей"],
  across: ["сеть", "сети", "сетей"],
};

/** Declaration order, so the report lists bridges the same way every time. */
export const BRIDGE_ORDER: BridgeProtocol[] = ["wormhole", "hyperlane", "layerzero", "across"];

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
