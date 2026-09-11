/**
 * Regenerates the CCIP deployment table from Chainlink's own directory.
 *
 * Five routers were written down here by hand, out of the seventy-eight
 * Chainlink publishes - so CCIP was checked on five chains and silently
 * skipped on the rest, Robinhood Chain and Tempo among them. The directory
 * that backs the public CCIP docs carries every one of them, plus the
 * TokenAdminRegistry each chain's pool lookup starts from, which the bot was
 * otherwise deriving with a four-call walk through the OnRamp.
 *
 * It also carries Solana, which has no router contract to call and so could
 * not have been reached any other way: its entry names the router program
 * and the three token pool programs by id.
 *
 * The directory keys chains by Chainlink's own names, and the chain ids come
 * from the selector registry the same organisation publishes. The two are
 * joined on the CCIP chain selector, which both files carry: Ethereum is
 * "mainnet" in one and "ethereum-mainnet" in the other, BSC is "bsc-mainnet"
 * against "binance_smart_chain-mainnet", and four of the largest chains fell
 * out of the table when the join was on the name. A selector is a number
 * both sides agree on; a name is a spelling one of them invented.
 *
 * Run with: npm run sync:ccip
 */
import fs from "node:fs";

const OUT = "src/protocols/addresses/ccip.generated.ts";
const DIRECTORY =
  "https://raw.githubusercontent.com/smartcontractkit/documentation/main/src/config/data/ccip/v1_2_0/mainnet/chains.json";
const SELECTORS = "https://raw.githubusercontent.com/smartcontractkit/chain-selectors/main/selectors.yml";

interface EvmRow {
  chainId: number;
  ccipKey: string;
  selector: string;
  router: string;
  tokenAdminRegistry?: string;
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

/**
 * CCIP chain selector -> EVM chain id, from the selector registry.
 *
 * Parsed rather than pulled in as a dependency: the file is a flat block per
 * chain id and nothing else here needs YAML. Testnets are dropped by their
 * own label rather than guessed at from the name, because a testnet router
 * in this table would put play money in a liquidity report.
 */
export function parseSelectors(yaml: string): Map<string, number> {
  const bySelector = new Map<string, number>();

  let chainId: number | undefined;
  let selector: string | undefined;
  let mainnet = false;

  const flush = () => {
    if (chainId !== undefined && selector && mainnet && !bySelector.has(selector)) {
      bySelector.set(selector, chainId);
    }
    chainId = undefined;
    selector = undefined;
    mainnet = false;
  };

  for (const line of yaml.split("\n")) {
    const head = /^\s{2}"?(\d+)"?:\s*(?:#.*)?$/.exec(line);
    if (head) {
      flush();
      chainId = Number(head[1]);
      continue;
    }
    const selectorMatch = /^\s{4}selector:\s*"?(\d+)"?/.exec(line);
    if (selectorMatch) selector = selectorMatch[1];
    const typeMatch = /^\s{4}network_type:\s*"?([a-z]+)"?/.exec(line);
    if (typeMatch) mainnet = typeMatch[1] === "mainnet";
  }
  flush();

  return bySelector;
}

function address(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const nested = (value as { address?: unknown })?.address;
  return typeof nested === "string" ? nested : undefined;
}

async function main(): Promise<void> {
  const [directoryText, selectorsText] = await Promise.all([getText(DIRECTORY), getText(SELECTORS)]);
  const directory = JSON.parse(directoryText) as Record<string, any>;
  const chainIdBySelector = parseSelectors(selectorsText);

  const evm: EvmRow[] = [];
  let solana: { ccipKey: string; selector: string; router: string; poolPrograms: Record<string, string> } | undefined;
  const unmatched: string[] = [];

  for (const [ccipKey, entry] of Object.entries(directory)) {
    const router = address(entry?.router);
    if (!router) continue;
    const selector = String(entry?.chainSelector ?? "");

    // Solana is not an EVM chain and has no chain id to join on: its entry
    // names programs rather than contracts, and the pool programs are the
    // part that cannot be learned any other way.
    if (ccipKey === "solana-mainnet") {
      const poolPrograms: Record<string, string> = {};
      for (const [name, id] of Object.entries(entry?.poolPrograms ?? {})) {
        if (typeof id === "string") poolPrograms[name] = id;
      }
      solana = { ccipKey, selector, router, poolPrograms };
      continue;
    }

    // Only 0x contracts from here: the directory also carries Aptos and TON,
    // whose addresses are not EVM addresses and whose pools this bot has no
    // reader for. Filed as unmatched so the count says so out loud.
    if (!/^0x[0-9a-fA-F]{40}$/.test(router)) {
      unmatched.push(`${ccipKey} (не EVM)`);
      continue;
    }

    const chainId = chainIdBySelector.get(selector);
    if (chainId === undefined) {
      unmatched.push(`${ccipKey} (селектора ${selector} нет в реестре)`);
      continue;
    }

    evm.push({
      chainId,
      ccipKey,
      selector,
      router,
      tokenAdminRegistry: address(entry?.tokenAdminRegistry),
    });
  }

  evm.sort((a, b) => a.chainId - b.chainId);

  const body = evm
    .map(
      (r) => `  {
    chainId: ${r.chainId},
    ccipKey: ${JSON.stringify(r.ccipKey)},
    selector: ${JSON.stringify(r.selector)},
    router: ${JSON.stringify(r.router)},
    tokenAdminRegistry: ${r.tokenAdminRegistry ? JSON.stringify(r.tokenAdminRegistry) : "undefined"},
  },`
    )
    .join("\n");

  const solanaBody = solana
    ? `{
  ccipKey: ${JSON.stringify(solana.ccipKey)},
  selector: ${JSON.stringify(solana.selector)},
  router: ${JSON.stringify(solana.router)},
  poolPrograms: {
${Object.entries(solana.poolPrograms)
  .map(([name, id]) => `    ${JSON.stringify(name)}: ${JSON.stringify(id)},`)
  .join("\n")}
  },
}`
    : "undefined";

  fs.writeFileSync(
    OUT,
    `import type { Address } from "viem";

/**
 * Chainlink CCIP deployments, as Chainlink publishes them.
 *
 * GENERATED FILE. Do not edit by hand: run \\\`npm run sync:ccip\\\`, which reads
 * the directory behind the public CCIP docs and joins it to EVM chain ids
 * through Chainlink's own selector registry.
 */
export interface CcipEvmDeployment {
  chainId: number;
  /** Chainlink's own name for the chain, kept so a row can be traced back. */
  ccipKey: string;
  selector: string;
  router: Address;
  /**
   * Where the pool lookup starts. Published per chain, which saves the walk
   * from the Router through an OffRamp and an OnRamp to find it - four calls
   * that each had to succeed, on a chain that may answer none of them.
   */
  tokenAdminRegistry?: Address;
}

export const CCIP_EVM_DEPLOYMENTS: CcipEvmDeployment[] = [
${body}
];

/**
 * Solana, which has no router contract to call.
 *
 * Its pool programs are the part that could not have been learned any other
 * way: on Solana the pool is a program and the collateral sits in an account
 * derived from it, so without the program ids there is nothing to derive
 * from and nothing to ask.
 */
export interface CcipSvmDeployment {
  ccipKey: string;
  selector: string;
  /** The CCIP router program. */
  router: string;
  /** Pool program ids by Chainlink's name for the pool type. */
  poolPrograms: Record<string, string>;
}

export const CCIP_SOLANA: CcipSvmDeployment | undefined = ${solanaBody};
`,
    "utf8"
  );

  console.log(`${OUT}: ${evm.length} EVM-сетей${solana ? " + Solana" : ""}`);
  if (unmatched.length > 0) {
    // Said out loud: a chain in the directory that does not land in the table
    // is a chain where CCIP goes unchecked, and this is the only place that
    // is visible.
    console.log(`не попали (${unmatched.length}): ${unmatched.join(", ")}`);
  }
}

// Only when run as a script. The self-test imports the parser above to cover
// it offline, and a module that fetches on import would have made every test
// run depend on the network.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
