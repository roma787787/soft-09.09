import type { Address } from "viem";
import { getClient } from "../services/rpcClient";
import type { DetectionResult } from "./types";
import { detectLayerZero } from "./layerzero";
import { detectHyperlane } from "./hyperlane";
import { detectPortal } from "./portal";
import { detectTransporter } from "./transporter";

export interface DetectionOutcome {
  results: DetectionResult[];
  /** The node could not be reached, so "nothing found" proves nothing. */
  rpcError?: string;
  /** The node answered and there is no contract at this address here. */
  noContract?: boolean;
}

function describeRpcError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split("\n")[0].trim();
  return firstLine.length > 180 ? `${firstLine.slice(0, 180)}…` : firstLine;
}

/**
 * Runs every protocol detector against one (chain, address) pair.
 *
 * The bytecode probe up front does double duty. It skips the detectors
 * when there is no contract at the address, which keeps a no-chain /info
 * from firing ~20 eth_calls per chain at rate-limited public nodes. And
 * because every detector reads through `safeRead`, which cannot tell a
 * missing function from an unreachable node, this probe is the one place
 * that can distinguish the two - without it, an RPC outage is reported to
 * the user as "this is not a bridge", which is worse than saying nothing.
 */
export async function detectOnChain(chainKey: string, address: Address): Promise<DetectionOutcome> {
  const client = getClient(chainKey);

  try {
    const code = await client.getCode({ address });
    if (!code || code === "0x") return { results: [], noContract: true };
  } catch (err) {
    return { results: [], rpcError: describeRpcError(err) };
  }

  const settled = await Promise.allSettled([
    detectLayerZero(client, chainKey, address),
    detectHyperlane(client, chainKey, address),
    detectPortal(client, chainKey, address),
    detectTransporter(client, chainKey, address),
  ]);

  const results: DetectionResult[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) results.push(r.value);
  }

  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  results.sort((a, b) => order[a.confidence] - order[b.confidence]);
  return { results };
}
