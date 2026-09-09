import type { Address } from "viem";
import type { ProtocolId } from "./types";
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
      role: "EndpointV2: ядро протокола, через которое проходят все сообщения LayerZero в этой сети",
    };
  }

  if (is(HYPERLANE_MAILBOX_BY_CHAIN[chainKey])) {
    return {
      protocol: "hyperlane",
      role: "Mailbox: ядро протокола, через которое проходят все сообщения Hyperlane в этой сети",
    };
  }

  if (is(PORTAL_TOKEN_BRIDGE_BY_CHAIN[chainKey])) {
    return { protocol: "portal", role: "Token Bridge: контракт самого моста Portal в этой сети" };
  }

  if (is(CCIP_ROUTER_BY_CHAIN[chainKey])) {
    return { protocol: "transporter", role: "Router Chainlink CCIP: маршрутизатор, через который работает Transporter" };
  }

  if (is(CCTP_TOKEN_MESSENGER_BY_CHAIN[chainKey])) {
    return { protocol: "transporter", role: "TokenMessenger Circle CCTP: канал перевода нативного USDC" };
  }

  if (is(CCTP_MESSAGE_TRANSMITTER_BY_CHAIN[chainKey])) {
    return { protocol: "transporter", role: "MessageTransmitter Circle CCTP: канал перевода нативного USDC" };
  }

  return undefined;
}
