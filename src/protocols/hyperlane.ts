import type { Address, PublicClient } from "viem";
import type { DetectionResult, RemotePeer } from "./types";
import { safeRead, isNonZero, bytes32ToAddress, chainLabel } from "./util";
import { HYPERLANE_MAILBOX_BY_CHAIN } from "./addresses/hyperlane";
import { getHyperlaneDomainMap } from "../services/idMaps";

const MAILBOX_CLIENT_ABI = [
  { type: "function", name: "mailbox", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "interchainSecurityModule",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "routers",
    stateMutability: "view",
    inputs: [{ type: "uint32" }],
    outputs: [{ type: "bytes32" }],
  },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/**
 * Detects Hyperlane Warp Route TokenRouters (and other MailboxClient
 * contracts). A contract counts as Hyperlane if it exposes `mailbox()`
 * pointing at a real address; `routers(domain)` entries confirm the Warp
 * Route / Router pattern specifically and let us list connected chains.
 */
export async function detectHyperlane(
  client: PublicClient,
  chainKey: string,
  address: Address
): Promise<DetectionResult | undefined> {
  const mailboxAddr = await safeRead<Address>(client, address, MAILBOX_CLIENT_ABI as any, "mailbox");
  if (!mailboxAddr || !isNonZero(mailboxAddr)) return undefined;

  const knownMailbox = HYPERLANE_MAILBOX_BY_CHAIN[chainKey];
  const isKnownMailbox = !!knownMailbox && knownMailbox.toLowerCase() === mailboxAddr.toLowerCase();

  const ism = await safeRead<Address>(client, address, MAILBOX_CLIENT_ABI as any, "interchainSecurityModule");
  const owner = await safeRead<Address>(client, address, MAILBOX_CLIENT_ABI as any, "owner");
  const symbol = await safeRead<string>(client, address, MAILBOX_CLIENT_ABI as any, "symbol");

  const domainMap = await getHyperlaneDomainMap();
  const localDomain = domainMap.chainKeyToId.get(chainKey);

  const peers: RemotePeer[] = [];
  for (const [remoteId, remoteChainKey] of domainMap.idToChainKey) {
    if (localDomain !== undefined && remoteId === localDomain) continue;
    const routerValue = await safeRead<string>(client, address, MAILBOX_CLIENT_ABI as any, "routers", [remoteId]);
    if (routerValue && isNonZero(routerValue)) {
      peers.push({
        chainKey: remoteChainKey,
        chainLabel: chainLabel(remoteChainKey, `домен ${remoteId}`),
        remoteId,
        peerAddress: bytes32ToAddress(routerValue),
      });
    }
  }

  const facts: Array<[string, string]> = [
    ["Mailbox", mailboxAddr],
    ["Официальный Mailbox этой сети", isKnownMailbox ? "да" : "нет, адреса нет в справочнике"],
  ];
  if (localDomain !== undefined) facts.push(["Идентификатор сети (domain)", String(localDomain)]);
  if (ism && isNonZero(ism)) facts.push(["Модуль безопасности (ISM)", ism]);
  if (owner && isNonZero(owner)) facts.push(["Владелец", owner]);

  const role =
    peers.length > 0
      ? `Warp Route: маршрутизатор токена${symbol ? ` (${symbol})` : ""}`
      : "Контракт Hyperlane без настроенных связей с другими сетями";

  let confidence: DetectionResult["confidence"];
  if (isKnownMailbox && peers.length > 0) confidence = "high";
  else if (isKnownMailbox) confidence = "medium";
  else confidence = "low";

  return {
    protocol: "hyperlane",
    confidence,
    role,
    facts,
    peers,
    notes: isKnownMailbox
      ? []
      : ["Адреса этого Mailbox нет в справочнике бота для данной сети. Стоит перепроверить результат вручную."],
  };
}
