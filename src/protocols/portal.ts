import type { Address, PublicClient } from "viem";
import type { DetectionResult, RemotePeer } from "./types";
import { safeRead, isNonZero, bytes32ToAddress, chainLabel } from "./util";
import { PORTAL_TOKEN_BRIDGE_BY_CHAIN } from "./addresses/portal";
import { getWormholeChainIdMap } from "../services/idMaps";

const TOKEN_BRIDGE_ABI = [
  { type: "function", name: "wormhole", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "chainId", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  {
    type: "function",
    name: "bridgeContracts",
    stateMutability: "view",
    inputs: [{ type: "uint16" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const WRAPPED_TOKEN_ABI = [
  { type: "function", name: "nativeContract", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "chainId", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/**
 * Detects Portal (Wormhole Token Bridge) contracts: either the Token Bridge
 * contract itself (has `wormhole()` pointing at the Wormhole core contract,
 * plus a `bridgeContracts(chainId)` registry of peer bridges), or a wrapped
 * token minted BY Portal on a destination chain (has `nativeContract()` /
 * `chainId()` pointing back at its origin).
 */
export async function detectPortal(
  client: PublicClient,
  chainKey: string,
  address: Address
): Promise<DetectionResult | undefined> {
  const coreAddr = await safeRead<Address>(client, address, TOKEN_BRIDGE_ABI as any, "wormhole");

  if (coreAddr && isNonZero(coreAddr)) {
    const whChainId = await safeRead<number>(client, address, TOKEN_BRIDGE_ABI as any, "chainId");
    const known = PORTAL_TOKEN_BRIDGE_BY_CHAIN[chainKey];
    const isKnownBridge = !!known && known.toLowerCase() === address.toLowerCase();

    const facts: Array<[string, string]> = [
      ["Wormhole core bridge", coreAddr],
      ["Recognized canonical Token Bridge for this chain", isKnownBridge ? "yes" : "no / not in our address book"],
    ];
    if (whChainId !== undefined) facts.push(["Wormhole chain id", String(whChainId)]);

    const whMap = await getWormholeChainIdMap();
    const peers: RemotePeer[] = [];
    for (const [remoteId, remoteChainKey] of whMap.idToChainKey) {
      if (whChainId !== undefined && remoteId === whChainId) continue;
      const peerValue = await safeRead<string>(client, address, TOKEN_BRIDGE_ABI as any, "bridgeContracts", [
        remoteId,
      ]);
      if (peerValue && isNonZero(peerValue)) {
        peers.push({
          chainKey: remoteChainKey,
          chainLabel: chainLabel(remoteChainKey, `Wormhole chain ${remoteId}`),
          remoteId,
          peerAddress: bytes32ToAddress(peerValue),
        });
      }
    }

    return {
      protocol: "portal",
      confidence: isKnownBridge ? "high" : whChainId !== undefined ? "medium" : "low",
      role: "Portal Token Bridge (Wormhole)",
      facts,
      peers,
      notes: isKnownBridge
        ? []
        : ["Address is not in this bot's known Token Bridge list - verify manually before trusting this result."],
    };
  }

  // Not the bridge itself - maybe a token that Portal minted on this chain.
  const nativeContractVal = await safeRead<string>(client, address, WRAPPED_TOKEN_ABI as any, "nativeContract");
  if (nativeContractVal && isNonZero(nativeContractVal)) {
    const originWhChainId = await safeRead<number>(client, address, WRAPPED_TOKEN_ABI as any, "chainId");
    const symbol = await safeRead<string>(client, address, WRAPPED_TOKEN_ABI as any, "symbol");

    const facts: Array<[string, string]> = [["Native (origin) contract", bytes32ToAddress(nativeContractVal)]];
    let originLabel: string | undefined;
    if (originWhChainId !== undefined) {
      const whMap = await getWormholeChainIdMap();
      const originChainKey = whMap.idToChainKey.get(originWhChainId);
      originLabel = chainLabel(originChainKey, `Wormhole chain ${originWhChainId}`);
      facts.push(["Native chain", `${originLabel} (Wormhole chain id ${originWhChainId})`]);
    }

    return {
      protocol: "portal",
      confidence: "medium",
      role: `Wrapped token minted by Portal Token Bridge${symbol ? ` (${symbol})` : ""}`,
      facts,
      peers: [],
      notes: ["This is a wrapped asset produced by Portal, not the bridge contract itself."],
    };
  }

  return undefined;
}
