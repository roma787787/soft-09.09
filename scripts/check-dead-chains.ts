/**
 * Names the chains whose every known endpoint has a hostname that no longer
 * resolves - anywhere, from any of the three registries the bot reads.
 *
 * This is the check that decides whether a chain is dead or merely having a
 * bad day, and it exists because guessing at that got it wrong twice.
 * chainlist had Astar zkEVM at rpc-zkevm.astar.network, gone; the canonical
 * registry had rpc.startale.com, also gone. Zero Network looked equally
 * dead in both and Hyperlane had two hosts for it that answer to this day.
 * A chain refusing with 403 or 429 is alive and saying no to a datacenter
 * IP - a private RPC fixes it. A chain whose names do not resolve has
 * nothing behind it to fix.
 *
 * Removal is a judgement call; this only supplies the evidence for it.
 * Nothing is changed on disk.
 *
 * Run with: npm run check:dead
 */
import "./offline-env";
import dns from "node:dns/promises";
import { CHAINS } from "../src/config/chains";
import { rpcUrlsFor } from "../src/config/env";

/** Hosts resolved at once. DNS is the bottleneck, so this is the whole run. */
const CONCURRENCY = 16;

interface Verdict {
  key: string;
  label: string;
  hosts: number;
  resolving: number;
  dead: string[];
}

function hostsOf(chainKey: string): string[] {
  const hosts = new Set<string>();
  for (const url of rpcUrlsFor(chainKey)) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      // A malformed entry is not a hostname question; the reader will drop it.
    }
  }
  return [...hosts];
}

async function resolves(host: string): Promise<boolean> {
  try {
    await dns.lookup(host);
    return true;
  } catch {
    return false;
  }
}

async function verdictFor(chainKey: string, label: string): Promise<Verdict> {
  const hosts = hostsOf(chainKey);
  const answers = await Promise.all(hosts.map(resolves));
  return {
    key: chainKey,
    label,
    hosts: hosts.length,
    resolving: answers.filter(Boolean).length,
    dead: hosts.filter((_, i) => !answers[i]),
  };
}

(async () => {
  const verdicts: Verdict[] = new Array(CHAINS.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= CHAINS.length) return;
      const chain = CHAINS[index];
      verdicts[index] = await verdictFor(chain.key, chain.label);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const gone = verdicts.filter((v) => v.hosts > 0 && v.resolving === 0);
  const thin = verdicts.filter((v) => v.resolving === 1 && v.hosts > 1);

  if (gone.length === 0) {
    console.log(`Ни одной мёртвой сети: у всех ${CHAINS.length} резолвится хотя бы один узел.`);
  } else {
    console.log(`Не резолвится ни один узел — ${gone.length} ${gone.length === 1 ? "сеть" : "сетей"}:\n`);
    for (const v of gone) {
      console.log(`  ${v.label} (${v.key})`);
      for (const host of v.dead) console.log(`      ${host}`);
    }
    console.log(
      `\nЭто кандидаты на удаление из src/config/chains.ts. Сначала прогони` +
        ` npm run sync:rpcs — узел мог просто переехать, и тогда сеть живая.`
    );
  }

  if (thin.length > 0) {
    console.log(`\nДержатся на одном резолвящемся узле — ${thin.length}:`);
    console.log(`  ${thin.map((v) => v.label).join(", ")}`);
  }
})();
