import type { Address } from "viem";
import { getClient } from "../services/rpcClient";
import type { DetectionResult } from "./types";
import { detectLayerZero } from "./layerzero";
import { detectHyperlane } from "./hyperlane";
import { detectPortal } from "./portal";
import { detectTransporter } from "./transporter";

/**
 * Runs every protocol detector against one (chain, address) pair.
 *
 * Cheap guard first: if there is no contract code at the address on this
 * chain, skip the detectors entirely. Without this, an /info with no chain
 * argument fires ~20 eth_calls per chain across every configured chain,
 * which public rate-limited RPCs answer with 429s - and a throttled call is
 * indistinguishable from "function not present", so results silently degrade.
 */
export async function detectOnChain(chainKey: string, address: Address): Promise<DetectionResult[]> {
  const client = getClient(chainKey);

  try {
    const code = await client.getCode({ address });
    if (!code || code === "0x") return [];
  } catch {
    // Treat an RPC failure as "unknown" and fall through to the detectors
    // rather than reporting a false negative.
  }

  const results = await Promise.allSettled([
    detectLayerZero(client, chainKey, address),
    detectHyperlane(client, chainKey, address),
    detectPortal(client, chainKey, address),
    detectTransporter(client, chainKey, address),
  ]);

  const found: DetectionResult[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) found.push(r.value);
  }

  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  found.sort((a, b) => order[a.confidence] - order[b.confidence]);
  return found;
}
