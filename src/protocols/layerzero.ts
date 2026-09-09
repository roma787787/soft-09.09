import type { Address, PublicClient } from "viem";
import type { DetectionResult, RemotePeer } from "./types";
import { safeRead, isNonZero, bytes32ToAddress, chainLabel } from "./util";
import { LZ_ENDPOINT_V2 } from "./addresses/layerzero";
import { getLzEidMap } from "../services/idMaps";

const OAPP_ABI = [
  { type: "function", name: "endpoint", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "peers",
    stateMutability: "view",
    inputs: [{ type: "uint32" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "oAppVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }, { type: "uint64" }],
  },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const OAPP_V1_ABI = [
  { type: "function", name: "lzEndpoint", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "getTrustedRemoteAddress",
    stateMutability: "view",
    inputs: [{ type: "uint16" }],
    outputs: [{ type: "bytes" }],
  },
] as const;

/**
 * Detects LayerZero OApp / OFT (and OFT Adapter) contracts - the full,
 * general-purpose LayerZero messaging standard, not just Stargate's
 * particular usage of it. Works against both LayerZero V2 (verified via the
 * well-known EndpointV2 constant) and, on a best-effort basis, legacy V1
 * User Applications.
 */
export async function detectLayerZero(
  client: PublicClient,
  chainKey: string,
  address: Address
): Promise<DetectionResult | undefined> {
  const endpointAddr = await safeRead<Address>(client, address, OAPP_ABI as any, "endpoint");

  if (endpointAddr && isNonZero(endpointAddr)) {
    const isKnownEndpoint = endpointAddr.toLowerCase() === LZ_ENDPOINT_V2.toLowerCase();
    const oAppVersion = await safeRead<[bigint, bigint]>(client, address, OAPP_ABI as any, "oAppVersion");
    const tokenAddr = await safeRead<Address>(client, address, OAPP_ABI as any, "token");
    const symbol = await safeRead<string>(client, address, OAPP_ABI as any, "symbol");
    const owner = await safeRead<Address>(client, address, OAPP_ABI as any, "owner");

    // LayerZero V2 OFT.sol returns address(this) from token(), while
    // OFTAdapter.sol returns the external ERC-20 it wraps - so the address
    // comparison, not the mere presence of token(), is what tells them apart.
    const wrapsExternalToken =
      !!tokenAddr && isNonZero(tokenAddr) && tokenAddr.toLowerCase() !== address.toLowerCase();

    let role: string;
    if (wrapsExternalToken) {
      role = `OFT Adapter: обёртка над внешним токеном ERC-20 ${tokenAddr}`;
    } else if (tokenAddr && isNonZero(tokenAddr)) {
      role = `OFT: собственный омничейн-токен${symbol ? ` (${symbol})` : ""}`;
    } else if (symbol) {
      role = `OApp с интерфейсом ERC-20${symbol ? ` (${symbol})` : ""}`;
    } else {
      role = "OApp: контракт кросс-чейн сообщений";
    }

    const facts: Array<[string, string]> = [
      ["Endpoint", endpointAddr],
      ["Официальный Endpoint LayerZero V2", isKnownEndpoint ? "да" : "нет, адрес не совпадает с известным"],
    ];
    if (oAppVersion) facts.push(["Версия OApp", `отправка ${oAppVersion[0]}, приём ${oAppVersion[1]}`]);
    if (owner && isNonZero(owner)) facts.push(["Владелец", owner]);

    const eidMap = await getLzEidMap();
    const localEid = eidMap.chainKeyToId.get(chainKey);
    if (localEid !== undefined) facts.push(["Идентификатор сети (eid)", String(localEid)]);

    const peers: RemotePeer[] = [];
    for (const [remoteId, remoteChainKey] of eidMap.idToChainKey) {
      if (localEid !== undefined && remoteId === localEid) continue;
      const peerValue = await safeRead<string>(client, address, OAPP_ABI as any, "peers", [remoteId]);
      if (peerValue && isNonZero(peerValue)) {
        peers.push({
          chainKey: remoteChainKey,
          chainLabel: chainLabel(remoteChainKey, `eid ${remoteId}`),
          remoteId,
          peerAddress: bytes32ToAddress(peerValue),
        });
      }
    }

    return {
      protocol: "layerzero",
      confidence: isKnownEndpoint ? "high" : oAppVersion ? "medium" : "low",
      role,
      facts,
      peers,
      notes: isKnownEndpoint
        ? []
        : ["Адрес Endpoint не совпадает с официальным адресом LayerZero V2. Стоит перепроверить, действительно ли это контракт LayerZero."],
    };
  }

  // Fall back to legacy V1 detection.
  const lzEndpointAddr = await safeRead<Address>(client, address, OAPP_V1_ABI as any, "lzEndpoint");
  if (lzEndpointAddr && isNonZero(lzEndpointAddr)) {
    return {
      protocol: "layerzero",
      confidence: "medium",
      role: "Контракт LayerZero V1 (устаревшая версия протокола)",
      facts: [["Endpoint (V1)", lzEndpointAddr]],
      peers: [],
      notes: [
        "Похоже на контракт первой версии LayerZero. В ней адреса Endpoint у каждой сети свои, а связи хранятся в устаревшем формате, поэтому список связанных сетей автоматически не собирается. Посмотреть его можно вручную через функцию getTrustedRemoteAddress в эксплорере.",
      ],
    };
  }

  return undefined;
}
