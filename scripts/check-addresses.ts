/**
 * Offline sanity check for every hard-coded contract address in
 * src/protocols/addresses/*.
 *
 * Contract addresses are the highest-risk data in this repo: a single
 * dropped or transposed character produces a constant that silently never
 * matches anything, degrading detection instead of failing loudly. This
 * check enforces correct length and, for mixed-case entries, a valid EIP-55
 * checksum - which catches transcription errors, since altering any hex
 * digit invalidates the expected capitalisation pattern.
 *
 * Run with: npm run check:addresses  (no network access required)
 */
import { getAddress, isAddress } from "viem";
import { LZ_ENDPOINT_V2 } from "../src/protocols/addresses/layerzero";
import { HYPERLANE_MAILBOX_BY_CHAIN } from "../src/protocols/addresses/hyperlane";
import { PORTAL_TOKEN_BRIDGE_BY_CHAIN } from "../src/protocols/addresses/portal";
import {
  CCIP_ROUTER_BY_CHAIN,
  CCTP_TOKEN_MESSENGER_BY_CHAIN,
  CCTP_MESSAGE_TRANSMITTER_BY_CHAIN,
} from "../src/protocols/addresses/transporter";

type Entry = [string, string];

function fromTable(prefix: string, table: Record<string, string | undefined>): Entry[] {
  return Object.entries(table)
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .map(([chain, addr]) => [`${prefix}.${chain}`, addr]);
}

const entries: Entry[] = [
  ["layerzero.endpointV2", LZ_ENDPOINT_V2],
  ...fromTable("hyperlane.mailbox", HYPERLANE_MAILBOX_BY_CHAIN),
  ...fromTable("portal.tokenBridge", PORTAL_TOKEN_BRIDGE_BY_CHAIN),
  ...fromTable("ccip.router", CCIP_ROUTER_BY_CHAIN),
  ...fromTable("cctp.tokenMessenger", CCTP_TOKEN_MESSENGER_BY_CHAIN),
  ...fromTable("cctp.messageTransmitter", CCTP_MESSAGE_TRANSMITTER_BY_CHAIN),
];

let failures = 0;

for (const [name, address] of entries) {
  const hexLength = address.replace(/^0x/, "").length;
  const problems: string[] = [];

  if (hexLength !== 40) problems.push(`expected 40 hex chars, got ${hexLength}`);
  if (!isAddress(address, { strict: false })) problems.push("not a well-formed address");

  const isMixedCase = address !== address.toLowerCase() && address !== address.toUpperCase();
  if (isMixedCase) {
    try {
      getAddress(address);
    } catch {
      problems.push("EIP-55 checksum mismatch (likely a typo)");
    }
  }

  if (problems.length > 0) {
    failures++;
    console.error(`FAIL  ${name}\n      ${address}\n      ${problems.join("; ")}`);
  } else {
    const verified = isMixedCase ? "checksum-verified" : "lowercase (checksum not applicable)";
    console.log(`ok    ${name.padEnd(32)} ${address}  [${verified}]`);
  }
}

console.log(`\n${entries.length - failures}/${entries.length} address entries passed.`);

if (failures > 0) {
  console.error(`${failures} address entr${failures === 1 ? "y" : "ies"} failed validation.`);
  process.exit(1);
}
