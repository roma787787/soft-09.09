import { PublicKey } from "@solana/web3.js";
import { contracts } from "@wormhole-foundation/sdk-base";
import { withSvmClient } from "../services/svmClient";
import { getSvmChain } from "../config/svmChains";
import { loadHyperlaneRegistry } from "./hyperlane";
import type { NonEvmReadResult } from "./types";

/**
 * Reading balances on Solana is not "one more chain in the table".
 *
 * On an EVM chain the custody contract holds the token itself, so its
 * address is the whole answer. On Solana the program holds nothing: the
 * tokens sit in a separate account whose address is derived from the
 * program and the mint. That address appears in no registry, so it has to be
 * computed - and a wrong computation returns an account that does not exist,
 * which is indistinguishable from an empty bridge unless the code says which
 * happened.
 *
 * So every derivation here is a candidate, each candidate is checked against
 * the chain, and the check is what decides. A candidate that resolves to a
 * real token account for the right mint is the custody account; everything
 * else is discarded rather than reported.
 */

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export interface SvmCandidate {
  /** How this address was derived, so a live check names the winner. */
  how: string;
  address: string;
}

export interface SvmCustody {
  chainKey: string;
  /** The token account actually holding the collateral. */
  custodyAddress: string;
  /** The SPL mint it holds. */
  mint: string;
  amount: bigint;
  decimals: number;
  how: string;
}

/** The associated token account of an owner for a mint. */
function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  )[0];
}

function pda(seeds: Buffer[], programId: PublicKey): PublicKey | undefined {
  try {
    return PublicKey.findProgramAddressSync(seeds, programId)[0];
  } catch {
    return undefined;
  }
}

/**
 * Where a Hyperlane Sealevel warp route might keep its collateral.
 *
 * Hyperlane's Solana programs derive an escrow from a fixed seed prefix, and
 * the collateral may sit either in that account directly or in its
 * associated token account for the mint. Both are offered; the chain decides.
 */
export function hyperlaneEscrowCandidates(programId: string, mint: string): SvmCandidate[] {
  let program: PublicKey;
  let mintKey: PublicKey;
  try {
    program = new PublicKey(programId);
    mintKey = new PublicKey(mint);
  } catch {
    return [];
  }

  const seedSets: Array<{ how: string; seeds: Buffer[] }> = [
    { how: "hyperlane_token-escrow", seeds: [Buffer.from("hyperlane_token"), Buffer.from("-"), Buffer.from("escrow")] },
    {
      how: "hyperlane_token--escrow",
      seeds: [Buffer.from("hyperlane_token"), Buffer.from("-"), Buffer.from("-"), Buffer.from("escrow")],
    },
    { how: "escrow", seeds: [Buffer.from("escrow")] },
  ];

  const candidates: SvmCandidate[] = [];
  for (const { how, seeds } of seedSets) {
    const derived = pda(seeds, program);
    if (!derived) continue;
    candidates.push({ how, address: derived.toBase58() });
    candidates.push({ how: `${how} → ATA`, address: associatedTokenAddress(derived, mintKey).toBase58() });
  }
  // Some routes hold collateral in the program's own associated account.
  candidates.push({ how: "программа → ATA", address: associatedTokenAddress(program, mintKey).toBase58() });
  return candidates;
}

/**
 * Where Wormhole's Token Bridge keeps a Solana-native token it has locked.
 * The custody account is derived from the mint under the bridge program.
 */
export function wormholeCustodyCandidates(mint: string): SvmCandidate[] {
  const bridge = solanaTokenBridge();
  if (!bridge) return [];

  let program: PublicKey;
  let mintKey: PublicKey;
  try {
    program = new PublicKey(bridge);
    mintKey = new PublicKey(mint);
  } catch {
    return [];
  }

  const out: SvmCandidate[] = [];
  const byMint = pda([mintKey.toBuffer()], program);
  if (byMint) out.push({ how: "PDA(mint)", address: byMint.toBase58() });

  const byCustody = pda([Buffer.from("custody"), mintKey.toBuffer()], program);
  if (byCustody) out.push({ how: 'PDA("custody", mint)', address: byCustody.toBase58() });

  return out;
}

/** Wormhole's Token Bridge program on Solana, from its own registry. */
export function solanaTokenBridge(): string | undefined {
  try {
    return contracts.tokenBridge("Mainnet", "Solana");
  } catch {
    return undefined;
  }
}

export interface CandidateCheck extends SvmCandidate {
  /** What the chain said: a balance, a different mint, or nothing at all. */
  outcome: string;
  amount?: bigint;
  decimals?: number;
  ok: boolean;
}

/**
 * Asks the chain about each candidate and reports what it found. This is the
 * step that turns a guess into a fact: a token account states its own mint,
 * so a candidate either is the custody account for this token or is not,
 * with no inference in between.
 */
export async function checkCandidates(
  chainKey: string,
  mint: string,
  candidates: SvmCandidate[]
): Promise<CandidateCheck[]> {
  const results: CandidateCheck[] = [];

  for (const candidate of candidates) {
    try {
      const parsed = await withSvmClient(chainKey, (c) =>
        c.getParsedAccountInfo(new PublicKey(candidate.address))
      );
      const info = (parsed.value?.data as any)?.parsed?.info;
      if (!info) {
        results.push({ ...candidate, outcome: "аккаунта нет", ok: false });
        continue;
      }
      if (info.mint !== mint) {
        results.push({ ...candidate, outcome: `другой минт: ${info.mint ?? "неизвестно"}`, ok: false });
        continue;
      }

      const amount = BigInt(info.tokenAmount?.amount ?? "0");
      const decimals = Number(info.tokenAmount?.decimals ?? 0);
      results.push({ ...candidate, outcome: `баланс ${info.tokenAmount?.uiAmountString ?? amount}`, amount, decimals, ok: true });
    } catch (err) {
      const text = err instanceof Error ? err.message.split("\n")[0] : String(err);
      results.push({ ...candidate, outcome: `ошибка: ${text.slice(0, 70)}`, ok: false });
    }
  }

  return results;
}

/**
 * The confirmed derivations, checked against the chain on four Hyperlane
 * routes and two Wormhole custodies. The candidate list above stays for the
 * diagnostic: when a route stops resolving, the question is which derivation
 * changed, and that is only answerable by trying them all again.
 */
const HYPERLANE_ESCROW_SEEDS = [Buffer.from("hyperlane_token"), Buffer.from("-"), Buffer.from("escrow")];

/** The account a Hyperlane Sealevel route keeps its collateral in. */
export function hyperlaneEscrow(programId: string): string | undefined {
  try {
    return pda(HYPERLANE_ESCROW_SEEDS, new PublicKey(programId))?.toBase58();
  } catch {
    return undefined;
  }
}

/** The account Wormhole's Token Bridge locks a Solana-native token in. */
export function wormholeCustody(mint: string): string | undefined {
  const bridge = solanaTokenBridge();
  if (!bridge) return undefined;
  try {
    return pda([new PublicKey(mint).toBuffer()], new PublicKey(bridge))?.toBase58();
  } catch {
    return undefined;
  }
}

export interface SolanaRoute {
  routeId: string;
  chainKey: string;
  symbol: string;
  programId: string;
  mint: string;
  standard: string;
}

/**
 * Hyperlane routes on Solana that lock collateral.
 *
 * The EVM rule - "has collateralAddressOrDenom, therefore holds collateral" -
 * is wrong here: Sealevel synthetic routes carry that field too and mint
 * their supply. `standard` is what actually says, and using the EVM signal
 * would have reported twenty minting routes as custody with a zero balance.
 */
export function findSolanaHyperlaneRoutes(symbol: string): SolanaRoute[] {
  const registry = loadHyperlaneRegistry();
  const wanted = symbol.toUpperCase();
  const found: SolanaRoute[] = [];

  for (const [routeId, config] of Object.entries(registry)) {
    const routeSymbol = routeId.split("/")[0]?.toUpperCase();
    for (const token of (config as any).tokens ?? []) {
      if (!getSvmChain(token.chainName)) continue;
      const tokenSymbol = (token.symbol ?? routeSymbol ?? "").toUpperCase();
      if (tokenSymbol !== wanted && routeSymbol !== wanted) continue;
      if (!/Collateral|Native/i.test(token.standard ?? "")) continue;
      if (!token.addressOrDenom || !token.collateralAddressOrDenom) continue;

      found.push({
        routeId,
        chainKey: token.chainName,
        symbol: token.symbol ?? routeSymbol ?? wanted,
        programId: token.addressOrDenom,
        mint: token.collateralAddressOrDenom,
        standard: token.standard,
      });
    }
  }
  return found;
}


export interface SvmBalanceRow {
  protocol: "hyperlane" | "wormhole";
  chainKey: string;
  custodyAddress: string;
  tokenAddress: string;
  note?: string;
  amount: bigint;
  decimals: number;
}

/**
 * Every Solana account holding this token for a bridge, with its balance.
 *
 * Read in one call rather than one per account: a public Solana endpoint
 * rate-limits a burst of small requests far sooner than it refuses a single
 * batched one, and a chain that drops out of the report reads as "no
 * liquidity here".
 */
export async function findSvmBalances(
  symbol: string,
  solanaMint?: string
): Promise<NonEvmReadResult<SvmBalanceRow>> {
  interface Wanted {
    protocol: "hyperlane" | "wormhole";
    chainKey: string;
    address: string;
    mint: string;
    note?: string;
  }

  const wanted: Wanted[] = [];

  // Every Sealevel chain derives its escrow the same way, because they all
  // run the same VM and the same Hyperlane program. Adding Eclipse, SOON and
  // the rest therefore costs a row in the chain table and no new logic.
  for (const route of findSolanaHyperlaneRoutes(symbol)) {
    const escrow = hyperlaneEscrow(route.programId);
    if (escrow) {
      wanted.push({
        protocol: "hyperlane",
        chainKey: route.chainKey,
        address: escrow,
        mint: route.mint,
        note: route.routeId,
      });
    }
  }

  // Wormhole's Token Bridge lives on Solana itself, not on the rollups that
  // borrow its VM.
  if (solanaMint) {
    const custody = wormholeCustody(solanaMint);
    if (custody) {
      wanted.push({ protocol: "wormhole", chainKey: "solanamainnet", address: custody, mint: solanaMint });
    }
  }

  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  for (const entry of wanted) attempts[entry.chainKey] = (attempts[entry.chainKey] ?? 0) + 1;

  if (wanted.length === 0) return { rows: [], attempts, failures };

  // Grouped by chain: each is a separate network with its own endpoint, and
  // one batched call per chain keeps a rate-limited public node from
  // refusing a burst of small ones.
  const byChain = new Map<string, Wanted[]>();
  for (const entry of wanted) {
    if (!byChain.has(entry.chainKey)) byChain.set(entry.chainKey, []);
    byChain.get(entry.chainKey)!.push(entry);
  }

  const perChain = await Promise.all(
    [...byChain.entries()].map(async ([chainKey, entries]) => {
      let accounts: Array<any | null>;
      try {
        accounts = await withSvmClient(chainKey, (c) =>
          c.getMultipleParsedAccounts(entries.map((e) => new PublicKey(e.address))).then((r) => r.value)
        );
      } catch (err) {
        console.error(`[svm] ${chainKey}: не удалось прочитать аккаунты:`, err);
        // The whole chain went unread, which is not the same as its bridges
        // being empty - and only the count says which.
        failures[chainKey] = (failures[chainKey] ?? 0) + entries.length;
        return [];
      }

      const rows: SvmBalanceRow[] = [];
      entries.forEach((entry, i) => {
        const info = (accounts[i]?.data as any)?.parsed?.info;
        // An account that does not exist, or holds a different mint, is not
        // this token's custody - and inventing a zero for it would claim the
        // bridge was checked when it was not.
        if (!info || info.mint !== entry.mint) return;

        rows.push({
          protocol: entry.protocol,
          chainKey,
          custodyAddress: entry.address,
          tokenAddress: entry.mint,
          note: entry.note,
          amount: BigInt(info.tokenAmount?.amount ?? "0"),
          decimals: Number(info.tokenAmount?.decimals ?? 0),
        });
      });
      return rows;
    })
  );

  return { rows: perChain.flat(), attempts, failures };
}
