import type { Address } from "viem";

export type BridgeProtocol = "layerzero" | "hyperlane" | "wormhole" | "across" | "ccip" | "stargate";

export const BRIDGE_LABELS: Record<BridgeProtocol, string> = {
  layerzero: "LayerZero (OFT Adapter)",
  hyperlane: "Hyperlane (Warp Route)",
  wormhole: "Wormhole (Token Bridge)",
  across: "Across (SpokePool)",
  ccip: "Chainlink CCIP / Transporter (Token Pool)",
  stargate: "Stargate (пул LayerZero)",
};

/** Short name for the "where did these contracts come from" line. */
export const BRIDGE_SHORT_LABELS: Record<BridgeProtocol, string> = {
  layerzero: "LayerZero",
  hyperlane: "Hyperlane",
  wormhole: "Wormhole",
  across: "Across",
  ccip: "CCIP",
  stargate: "Stargate",
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
  ccip: ["пул", "пула", "пулов"],
  stargate: ["пул", "пула", "пулов"],
};

/** Declaration order, so the report lists bridges the same way every time. */
export const BRIDGE_ORDER: BridgeProtocol[] = ["wormhole", "hyperlane", "layerzero", "stargate", "across", "ccip"];

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
  /**
   * Read the chain's own coin instead of an ERC-20. Stargate's native pools
   * hold ETH itself, and on an Ethereum L2 they hold far more of it than any
   * wrapped-token pool, so skipping them hid the largest ETH liquidity there
   * is. Their balance comes from getBalance, not balanceOf.
   */
  readsNativeCoin?: boolean;
}


/**
 * What a non-EVM reader found, and what it could not reach.
 *
 * A row that is simply absent reads as "this bridge holds nothing", and a
 * chain whose endpoint refused is the one case where that is exactly wrong.
 * The EVM side has counted its failures per chain from early on; these
 * readers returned rows alone, so a dead gateway looked identical to an
 * empty bridge.
 */
export interface NonEvmReadResult<Row> {
  rows: Row[];
  /** Reads attempted per chain. */
  attempts: Record<string, number>;
  /** Reads that failed to reach the chain, per chain. */
  failures: Record<string, number>;
}
