import type { Address, PublicClient } from "viem";
import type { DetectionResult, RemotePeer } from "./types";
import { safeRead, isNonZero, bytes32ToAddress, chainLabel } from "./util";
import { CCIP_ROUTER_BY_CHAIN, CCTP_DOMAIN_BY_CHAIN } from "./addresses/transporter";
import { getCctpDomainMap } from "../services/idMaps";

const CCIP_ROUTER_ABI = [
  { type: "function", name: "typeAndVersion", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const CCTP_TOKEN_MESSENGER_ABI = [
  {
    type: "function",
    name: "localMessageTransmitter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "messageBodyVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
  {
    type: "function",
    name: "remoteTokenMessengers",
    stateMutability: "view",
    inputs: [{ type: "uint32" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const CCTP_MESSAGE_TRANSMITTER_ABI = [
  { type: "function", name: "localDomain", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
] as const;

/**
 * "Transporter" (transporter.io) has no bridge contract of its own - it is a
 * front-end over Chainlink CCIP, and for native USDC transfers, over
 * Circle's CCTP directly. So detection here means recognizing either rail.
 */
export async function detectTransporter(
  client: PublicClient,
  chainKey: string,
  address: Address
): Promise<DetectionResult | undefined> {
  // --- Chainlink CCIP Router ---
  const typeAndVersion = await safeRead<string>(client, address, CCIP_ROUTER_ABI as any, "typeAndVersion");
  if (typeAndVersion && /router/i.test(typeAndVersion)) {
    const known = CCIP_ROUTER_BY_CHAIN[chainKey];
    const isKnownRouter = !!known && known.toLowerCase() === address.toLowerCase();
    return {
      protocol: "transporter",
      confidence: isKnownRouter ? "high" : "medium",
      role: `Chainlink CCIP Router (Transporter's routing layer) - ${typeAndVersion}`,
      facts: [
        ["typeAndVersion()", typeAndVersion],
        ["Recognized canonical CCIP Router for this chain", isKnownRouter ? "yes" : "no / not in our address book"],
      ],
      peers: [],
      notes: [
        "Chainlink CCIP Router. Per-lane peers (onRamp/offRamp per destination chain selector) are not enumerated here - see the Chainlink CCIP directory for this chain's supported lanes.",
      ],
    };
  }

  // --- Circle CCTP TokenMessenger (used directly by Transporter for native USDC) ---
  const localTransmitter = await safeRead<Address>(
    client,
    address,
    CCTP_TOKEN_MESSENGER_ABI as any,
    "localMessageTransmitter"
  );
  if (localTransmitter && isNonZero(localTransmitter)) {
    const bodyVersion = await safeRead<number>(client, address, CCTP_TOKEN_MESSENGER_ABI as any, "messageBodyVersion");
    const domainMap = await getCctpDomainMap();
    const localDomain = domainMap.chainKeyToId.get(chainKey);

    const peers: RemotePeer[] = [];
    for (const [remoteId, remoteChainKey] of domainMap.idToChainKey) {
      if (localDomain !== undefined && remoteId === localDomain) continue;
      const peerValue = await safeRead<string>(
        client,
        address,
        CCTP_TOKEN_MESSENGER_ABI as any,
        "remoteTokenMessengers",
        [remoteId]
      );
      if (peerValue && isNonZero(peerValue)) {
        peers.push({
          chainKey: remoteChainKey,
          chainLabel: chainLabel(remoteChainKey, `CCTP domain ${remoteId}`),
          remoteId,
          peerAddress: bytes32ToAddress(peerValue),
        });
      }
    }

    const facts: Array<[string, string]> = [["Local MessageTransmitter", localTransmitter]];
    if (bodyVersion !== undefined) facts.push(["Message body version", bodyVersion === 0 ? "CCTP v1" : "CCTP v2"]);
    if (localDomain !== undefined) facts.push(["Local CCTP domain", String(localDomain)]);

    return {
      protocol: "transporter",
      confidence: "high",
      role: "Circle CCTP TokenMessenger (native USDC rail used by Transporter)",
      facts,
      peers,
      notes: [],
    };
  }

  // --- Circle CCTP MessageTransmitter ---
  const localDomainSelf = await safeRead<number>(client, address, CCTP_MESSAGE_TRANSMITTER_ABI as any, "localDomain");
  const cctpVersion = await safeRead<number>(client, address, CCTP_MESSAGE_TRANSMITTER_ABI as any, "version");
  if (localDomainSelf !== undefined && cctpVersion !== undefined) {
    const knownDomain = CCTP_DOMAIN_BY_CHAIN[chainKey];
    const matches = knownDomain === localDomainSelf;
    return {
      protocol: "transporter",
      confidence: matches ? "high" : "medium",
      role: "Circle CCTP MessageTransmitter (native USDC rail used by Transporter)",
      facts: [
        ["Local CCTP domain", String(localDomainSelf)],
        ["Matches expected domain for this chain", matches ? "yes" : "no - double-check chain selection"],
      ],
      peers: [],
      notes: [],
    };
  }

  return undefined;
}
