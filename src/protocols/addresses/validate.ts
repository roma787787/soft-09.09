import { getAddress, isAddress } from "viem";

/**
 * Checks a contract address for the mistakes that copying one by hand
 * actually produces: a dropped character, and a mistyped hex digit.
 *
 * The second one is only visible through the EIP-55 checksum, and the
 * obvious way to test it does not work: viem's getAddress() returns a
 * mixed-case input unchanged rather than validating it, so calling it inside
 * a try/catch passes everything. The checksum has to be recomputed from the
 * lowercase form and compared - anything less is a check that always agrees.
 */
export function validateAddress(address: string): string[] {
  const problems: string[] = [];

  const hexLength = address.replace(/^0x/, "").length;
  if (hexLength !== 40) problems.push(`expected 40 hex chars, got ${hexLength}`);
  if (!isAddress(address, { strict: false })) {
    problems.push("not a well-formed address");
    return problems;
  }

  const isMixedCase = address !== address.toLowerCase() && address !== address.toUpperCase();
  if (isMixedCase) {
    const canonical = getAddress(address.toLowerCase() as `0x${string}`);
    if (canonical !== address) {
      problems.push(`EIP-55 checksum mismatch (likely a typo); expected ${canonical}`);
    }
  }

  return problems;
}
