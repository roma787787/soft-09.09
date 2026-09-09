import type { Address } from "viem";

export type ProtocolId = "layerzero" | "hyperlane" | "transporter" | "portal";

export const PROTOCOL_LABELS: Record<ProtocolId, string> = {
  layerzero: "LayerZero",
  hyperlane: "Hyperlane",
  transporter: "Transporter (Chainlink CCIP / Circle CCTP)",
  portal: "Portal (Wormhole Token Bridge)",
};

export type Confidence = "high" | "medium" | "low";

export interface RemotePeer {
  /** Our internal chain key when we recognize the remote chain, else undefined. */
  chainKey?: string;
  chainLabel: string;
  /** Raw protocol-specific numeric id (eid / domain / wormhole chain id / selector). */
  remoteId: number;
  peerAddress: Address;
}

export interface DetectionResult {
  protocol: ProtocolId;
  confidence: Confidence;
  /** e.g. "OFT (native token)", "Mailbox client / TokenRouter", "CCIP Router" */
  role: string;
  /** Human-readable extra facts to render in the /info card, key -> value. */
  facts: Array<[string, string]>;
  peers: RemotePeer[];
  /** Free-text notes/caveats to surface to the user. */
  notes: string[];
}
