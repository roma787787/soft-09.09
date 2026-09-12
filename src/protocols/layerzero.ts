import type { Address, PublicClient } from "viem";
import type { DetectionResult, RemotePeer } from "./types";
import { safeRead, isNonZero, bytes32ToAddress, chainLabel } from "./util";
import { LZ_ENDPOINT_V2 } from "./addresses/layerzero";
import { getLzEidMap } from "../services/idMaps";
import { formatAmount } from "../services/balances";

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

const TRUSTED_REMOTE_ABI = [
  {
    type: "function",
    name: "trustedRemoteLookup",
    stateMutability: "view",
    inputs: [{ type: "uint16" }],
    outputs: [{ type: "bytes" }],
  },
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
/** Just enough of ERC-20 to say how much an adapter is holding. */
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

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

    // The number this bot exists to report. An adapter's whole job is to
    // hold what the far side has minted against it, and the card described
    // one holding three billion USDT without saying so - leaving the reader
    // to go and run /info on the ticker to find the figure they were
    // already looking at the contract for.
    //
    // Only for an adapter: an OFT mints its own supply and holds nothing, so
    // a balance line there would be a zero that means nothing.
    if (wrapsExternalToken && tokenAddr) {
      const [locked, decimals, lockedSymbol] = await Promise.all([
        safeRead<bigint>(client, tokenAddr, ERC20_ABI as any, "balanceOf", [address]),
        safeRead<number>(client, tokenAddr, ERC20_ABI as any, "decimals"),
        safeRead<string>(client, tokenAddr, ERC20_ABI as any, "symbol"),
      ]);
      if (locked !== undefined && decimals !== undefined) {
        facts.push(["Заблокировано", `${formatAmount(locked, decimals)}${lockedSymbol ? ` ${lockedSymbol}` : ""}`]);
      }
    }

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
    // V1 stores its remotes under trustedRemoteLookup, keyed by V1's own
    // chain numbering. V2 numbered its chains by adding 30000 to those, so
    // the eids read from live endpoints give V1's ids without a table.
    const eidMap = await getLzEidMap();
    const peers: RemotePeer[] = [];
    for (const [eid, remoteChainKey] of eidMap.idToChainKey) {
      const remoteId = eid - 30000;
      if (remoteId <= 0 || remoteId >= 1000) continue;

      const packed = await safeRead<string>(client, address, TRUSTED_REMOTE_ABI as any, "trustedRemoteLookup", [
        remoteId,
      ]);
      // The value is abi.encodePacked(remote, local): the remote OApp is the
      // first twenty bytes, and anything shorter was never configured.
      const hex = (packed ?? "").replace(/^0x/, "");
      if (hex.length < 40) continue;

      const peerAddress = `0x${hex.slice(0, 40)}` as Address;
      if (!isNonZero(peerAddress)) continue;

      peers.push({
        chainKey: remoteChainKey,
        chainLabel: chainLabel(remoteChainKey, `V1 chainId ${remoteId}`),
        remoteId,
        peerAddress,
      });
    }

    return {
      protocol: "layerzero",
      confidence: "medium",
      role: "Контракт LayerZero V1 (устаревшая версия протокола)",
      facts: [["Endpoint (V1)", lzEndpointAddr]],
      peers,
      notes:
        peers.length > 0
          ? [
              "Первая версия LayerZero: адреса Endpoint у каждой сети свои, а связи хранятся в формате trustedRemote. Показаны только сети, подключённые к боту.",
            ]
          : [
              "Первая версия LayerZero. Связанных сетей у контракта не настроено — среди подключённых к боту сетей во всяком случае. Обычно так выглядит выведенный из обращения деплой.",
            ],
    };
  }

  return undefined;
}
