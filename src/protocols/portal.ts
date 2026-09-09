import type { Address, PublicClient } from "viem";
import type { DetectionResult, RemotePeer } from "./types";
import { safeRead, isNonZero, bytes32ToAddress, isEvmAddressBytes32, chainLabel } from "./util";
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
      ["Ядро Wormhole", coreAddr],
      ["Официальный Token Bridge этой сети", isKnownBridge ? "да" : "нет, адреса нет в справочнике"],
    ];
    if (whChainId !== undefined) facts.push(["Идентификатор сети (Wormhole)", String(whChainId)]);

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
          chainLabel: chainLabel(remoteChainKey, `сеть Wormhole ${remoteId}`),
          remoteId,
          peerAddress: bytes32ToAddress(peerValue),
        });
      }
    }

    return {
      protocol: "portal",
      confidence: isKnownBridge ? "high" : whChainId !== undefined ? "medium" : "low",
      role: "Token Bridge: контракт самого моста",
      facts,
      peers,
      notes: isKnownBridge
        ? []
        : ["Этого адреса нет в справочнике мостов Portal. Стоит перепроверить результат вручную."],
    };
  }

  // Not the bridge itself - maybe a token that Portal minted on this chain.
  const nativeContractVal = await safeRead<string>(client, address, WRAPPED_TOKEN_ABI as any, "nativeContract");
  if (nativeContractVal && isNonZero(nativeContractVal)) {
    const originWhChainId = await safeRead<number>(client, address, WRAPPED_TOKEN_ABI as any, "chainId");
    const symbol = await safeRead<string>(client, address, WRAPPED_TOKEN_ABI as any, "symbol");

    // A Solana/Aptos origin fills all 32 bytes; only render an EVM address
    // when the value really is one, otherwise show the raw bytes32.
    const facts: Array<[string, string]> = [
      [
        "Исходный контракт токена",
        isEvmAddressBytes32(nativeContractVal) ? bytes32ToAddress(nativeContractVal) : nativeContractVal,
      ],
    ];
    let originLabel: string | undefined;
    if (originWhChainId !== undefined) {
      const whMap = await getWormholeChainIdMap();
      const originChainKey = whMap.idToChainKey.get(originWhChainId);
      originLabel = chainLabel(originChainKey, `сеть Wormhole ${originWhChainId}`);
      facts.push(["Исходная сеть", `${originLabel} (идентификатор Wormhole ${originWhChainId})`]);
    }

    return {
      protocol: "portal",
      confidence: "medium",
      role: `Обёрнутый токен, выпущенный мостом Portal${symbol ? ` (${symbol})` : ""}`,
      facts,
      peers: [],
      notes: ["Это токен-обёртка, выпущенная мостом Portal, а не сам контракт моста."],
    };
  }

  return undefined;
}
