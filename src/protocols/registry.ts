import type { Address } from "viem";
import { getClient } from "../services/rpcClient";
import type { DetectionResult } from "./types";
import { detectLayerZero } from "./layerzero";
import { detectHyperlane } from "./hyperlane";
import { detectPortal } from "./portal";
import { detectTransporter } from "./transporter";

/** Runs every protocol detector against one (chain, address) pair. */
export async function detectOnChain(chainKey: string, address: Address): Promise<DetectionResult[]> {
  const client = getClient(chainKey);
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
