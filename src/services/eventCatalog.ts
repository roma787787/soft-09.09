import { decodeEventLog, type Log } from "viem";

/**
 * Best-effort catalog of event shapes emitted by contracts of the protocols
 * this bot understands. Used ONLY to pretty-print alerts - the tracker never
 * filters eth_getLogs by topic, so a wrong/missing signature here just means
 * a plainer (but still delivered) alert, never a silently dropped event.
 */
const CANDIDATE_EVENTS = [
  // LayerZero OFT
  "event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)",
  "event OFTReceived(bytes32 indexed guid, uint32 indexed srcEid, address indexed toAddress, uint256 amountReceivedLD)",
  // Hyperlane TokenRouter
  "event SentTransferRemote(uint32 indexed destination, bytes32 indexed recipient, uint256 amount)",
  "event ReceivedTransferRemote(uint32 indexed origin, bytes32 indexed recipient, uint256 amount)",
  // Circle CCTP (v1-style)
  "event DepositForBurn(uint64 nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)",
  "event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken)",
  // Wormhole / Portal Token Bridge
  "event TransferRedeemed(uint16 indexed emitterChainId, bytes32 indexed emitterAddress, uint64 indexed sequence)",
  // Generic ERC-20 fallback
  "event Transfer(address indexed from, address indexed to, uint256 value)",
] as const;

export function tryDecodeEvent(log: Log): { eventName: string; args: Record<string, unknown> } | undefined {
  for (const sig of CANDIDATE_EVENTS) {
    try {
      const decoded: any = decodeEventLog({
        abi: [sig] as any,
        data: log.data,
        topics: log.topics,
      });
      return { eventName: decoded.eventName as string, args: decoded.args as Record<string, unknown> };
    } catch {
      // not this shape, try next
    }
  }
  return undefined;
}
