import type { Address, PublicClient } from "viem";
import type { ProtocolId } from "./types";
import { safeRead, isNonZero } from "./util";
import { LZ_ENDPOINT_V2 } from "./addresses/layerzero";
import { HYPERLANE_MAILBOX_BY_CHAIN } from "./addresses/hyperlane";
import { PORTAL_TOKEN_BRIDGE_BY_CHAIN } from "./addresses/portal";
import {
  CCIP_ROUTER_BY_CHAIN,
  CCTP_TOKEN_MESSENGER_BY_CHAIN,
  CCTP_MESSAGE_TRANSMITTER_BY_CHAIN,
} from "./addresses/transporter";

export interface InfrastructureMatch {
  protocol: ProtocolId;
  role: string;
  /** Which core contract this is, so we know what to read from it. */
  kind: "lz-endpoint" | "hyperlane-mailbox" | "portal-bridge" | "ccip-router" | "cctp";
}

const ENDPOINT_ABI = [
  { type: "function", name: "eid", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
] as const;

const PORTAL_ABI = [
  { type: "function", name: "wormhole", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "chainId", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

const TYPE_AND_VERSION_ABI = [
  { type: "function", name: "typeAndVersion", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const CCTP_ABI = [
  { type: "function", name: "localDomain", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
] as const;

const MAILBOX_ABI = [
  { type: "function", name: "localDomain", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "defaultIsm", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "defaultHook", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * Reads the live state worth showing for a core contract. Without this the
 * card says only "yes, this is infrastructure", which answers nothing the
 * user could not already see.
 */
export async function describeInfrastructure(
  client: PublicClient,
  address: Address,
  match: InfrastructureMatch
): Promise<Array<[string, string]>> {
  const facts: Array<[string, string]> = [];

  if (match.kind === "lz-endpoint") {
    const eid = await safeRead<number>(client, address, ENDPOINT_ABI as any, "eid");
    if (eid !== undefined) facts.push(["Идентификатор сети (eid)", String(eid)]);
    facts.push(["Адрес одинаков во всех сетях LayerZero V2", "да"]);
    return facts;
  }

  if (match.kind === "hyperlane-mailbox") {
    const [localDomain, nonce, defaultIsm, defaultHook, owner] = await Promise.all([
      safeRead<number>(client, address, MAILBOX_ABI as any, "localDomain"),
      safeRead<number>(client, address, MAILBOX_ABI as any, "nonce"),
      safeRead<Address>(client, address, MAILBOX_ABI as any, "defaultIsm"),
      safeRead<Address>(client, address, MAILBOX_ABI as any, "defaultHook"),
      safeRead<Address>(client, address, MAILBOX_ABI as any, "owner"),
    ]);
    if (localDomain !== undefined) facts.push(["Идентификатор сети (domain)", String(localDomain)]);
    if (nonce !== undefined) facts.push(["Отправлено сообщений за всё время", String(nonce)]);
    if (defaultIsm && isNonZero(defaultIsm)) facts.push(["Модуль безопасности по умолчанию", defaultIsm]);
    if (defaultHook && isNonZero(defaultHook)) facts.push(["Хук по умолчанию", defaultHook]);
    if (owner && isNonZero(owner)) facts.push(["Владелец", owner]);
    return facts;
  }

  if (match.kind === "portal-bridge") {
    const [core, whChainId] = await Promise.all([
      safeRead<Address>(client, address, PORTAL_ABI as any, "wormhole"),
      safeRead<number>(client, address, PORTAL_ABI as any, "chainId"),
    ]);
    if (core && isNonZero(core)) facts.push(["Ядро Wormhole", core]);
    if (whChainId !== undefined) facts.push(["Идентификатор сети (Wormhole)", String(whChainId)]);
    return facts;
  }

  if (match.kind === "ccip-router") {
    const tv = await safeRead<string>(client, address, TYPE_AND_VERSION_ABI as any, "typeAndVersion");
    if (tv) facts.push(["Тип и версия контракта", tv]);
    return facts;
  }

  if (match.kind === "cctp") {
    const [localDomain, version] = await Promise.all([
      safeRead<number>(client, address, CCTP_ABI as any, "localDomain"),
      safeRead<number>(client, address, CCTP_ABI as any, "version"),
    ]);
    if (localDomain !== undefined) facts.push(["Идентификатор сети (CCTP domain)", String(localDomain)]);
    if (version !== undefined) facts.push(["Версия протокола", version === 0 ? "CCTP v1" : "CCTP v2"]);
    return facts;
  }

  return facts;
}

/**
 * Matches an address against the protocols' own infrastructure contracts.
 *
 * The ABI probes identify contracts that *use* a protocol (an OApp, a Warp
 * Route, a Token Bridge). They do not identify the protocol's own core
 * contracts, because those don't implement the client-side interface: the
 * LayerZero Endpoint has no `endpoint()`, the Hyperlane Mailbox has no
 * `mailbox()`. Pasting one of those very reasonable addresses used to come
 * back as "not recognized", which is the least helpful answer possible.
 */
export function matchKnownInfrastructure(chainKey: string, address: Address): InfrastructureMatch | undefined {
  const target = address.toLowerCase();
  const is = (candidate: string | undefined) => !!candidate && candidate.toLowerCase() === target;

  if (is(LZ_ENDPOINT_V2)) {
    return {
      protocol: "layerzero",
      kind: "lz-endpoint",
      role: "EndpointV2: ядро протокола, через которое проходят все сообщения LayerZero в этой сети",
    };
  }

  if (is(HYPERLANE_MAILBOX_BY_CHAIN[chainKey])) {
    return {
      protocol: "hyperlane",
      kind: "hyperlane-mailbox",
      role: "Mailbox: ядро протокола, через которое проходят все сообщения Hyperlane в этой сети",
    };
  }

  if (is(PORTAL_TOKEN_BRIDGE_BY_CHAIN[chainKey])) {
    return { protocol: "portal", kind: "portal-bridge", role: "Token Bridge: контракт самого моста Portal в этой сети" };
  }

  if (is(CCIP_ROUTER_BY_CHAIN[chainKey])) {
    return {
      protocol: "transporter",
      kind: "ccip-router",
      role: "Router Chainlink CCIP: маршрутизатор, через который работает Transporter",
    };
  }

  if (is(CCTP_TOKEN_MESSENGER_BY_CHAIN[chainKey])) {
    return { protocol: "transporter", kind: "cctp", role: "TokenMessenger Circle CCTP: канал перевода нативного USDC" };
  }

  if (is(CCTP_MESSAGE_TRANSMITTER_BY_CHAIN[chainKey])) {
    return {
      protocol: "transporter",
      kind: "cctp",
      role: "MessageTransmitter Circle CCTP: канал перевода нативного USDC",
    };
  }

  return undefined;
}
