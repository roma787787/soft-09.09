import { PublicKey } from "@solana/web3.js";
import { withSvmClient } from "../services/svmClient";
import { CCIP_SOLANA } from "../protocols/addresses/ccip.generated";
import type { NonEvmReadResult } from "./types";

/**
 * Chainlink CCIP on Solana.
 *
 * CCIP was read on EVM chains only, and not because Solana was left out of
 * CCIP: it is in Chainlink's directory with a router and three pool programs.
 * The reason was that every step of the EVM walk is a contract call, and
 * Solana has no contract to call - the pool is a program, and what it holds
 * sits in an account derived from the program and the mint.
 *
 * So this reads the way the rest of Solana is read here: derive candidates,
 * ask the chain about each, and let the chain decide. A wrong derivation
 * returns an account that does not exist, which is discarded; an account
 * that exists states its own mint, so a candidate either is this token's
 * custody or is not, with nothing inferred in between.
 *
 * The pool type is settled the same way rather than by decoding the
 * registry. Only a lock-release pool holds anything: a burn-mint pool mints
 * on arrival and holds nothing at any point, so finding the token under that
 * program is the answer "nothing is held here", not an empty vault - the
 * same distinction a MintBurnOFTAdapter needs on the EVM side.
 */

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Solana's key in this bot's chain table. */
export const SOLANA_KEY = "solanamainnet";

function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey | undefined {
  try {
    return PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM
    )[0];
  } catch {
    return undefined;
  }
}

function pda(seeds: Buffer[], programId: PublicKey): PublicKey | undefined {
  try {
    return PublicKey.findProgramAddressSync(seeds, programId)[0];
  } catch {
    return undefined;
  }
}

export interface CcipSvmCandidate {
  /** Which pool program it was derived under - lock-release, burn-mint, CCTP. */
  poolType: string;
  program: string;
  /** How it was derived, so a live check names the winner. */
  how: string;
  address: string;
}

/**
 * Where a CCIP pool on Solana might keep this mint's collateral.
 *
 * The seed the program signs with is what owns the custody account, and the
 * custody account itself is that owner's associated account for the mint.
 * Both spellings the programs have used are offered, plus the owner address
 * itself in case the account is held directly, and both token programs -
 * a Token-2022 mint derives a different associated account, and deriving it
 * under the wrong program yields an address that simply does not exist.
 */
export function ccipPoolCandidates(mint: string): CcipSvmCandidate[] {
  if (!CCIP_SOLANA) return [];

  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return [];
  }

  const seeds = [
    { how: 'PDA("ccip_tokenpool_signer", mint)', prefix: "ccip_tokenpool_signer" },
    { how: 'PDA("ccip_tokenpool_config", mint)', prefix: "ccip_tokenpool_config" },
    { how: 'PDA("ccip_tokenpool", mint)', prefix: "ccip_tokenpool" },
  ];

  const candidates: CcipSvmCandidate[] = [];
  for (const [poolType, programId] of Object.entries(CCIP_SOLANA.poolPrograms)) {
    let program: PublicKey;
    try {
      program = new PublicKey(programId);
    } catch {
      continue;
    }

    for (const { how, prefix } of seeds) {
      const owner = pda([Buffer.from(prefix), mintKey.toBuffer()], program);
      if (!owner) continue;

      candidates.push({ poolType, program: programId, how, address: owner.toBase58() });
      for (const [label, tokenProgram] of [
        ["ATA", TOKEN_PROGRAM],
        ["ATA-2022", TOKEN_2022_PROGRAM],
      ] as const) {
        const account = ata(owner, mintKey, tokenProgram);
        if (account) {
          candidates.push({ poolType, program: programId, how: `${how} → ${label}`, address: account.toBase58() });
        }
      }
    }
  }

  return candidates;
}

export interface CcipSvmCheck extends CcipSvmCandidate {
  outcome: string;
  amount?: bigint;
  decimals?: number;
  ok: boolean;
}

/**
 * Asks the chain about each candidate. Kept whole rather than stopping at
 * the first hit, so the diagnostic can show which derivations resolved and
 * which did not - when a pool stops being found, the only useful question
 * is which derivation changed.
 */
export async function checkCcipCandidates(
  mint: string,
  candidates: CcipSvmCandidate[]
): Promise<CcipSvmCheck[]> {
  const results: CcipSvmCheck[] = [];

  for (const candidate of candidates) {
    try {
      const parsed = await withSvmClient(SOLANA_KEY, (c) =>
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
      results.push({
        ...candidate,
        outcome: `баланс ${info.tokenAmount?.uiAmountString ?? amount}`,
        amount,
        decimals,
        ok: true,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message.split("\n")[0] : String(err);
      results.push({ ...candidate, outcome: `ошибка: ${text.slice(0, 70)}`, ok: false });
    }
  }

  return results;
}

/** Only this pool type holds anything; the others mint on arrival. */
export function holdsCollateral(poolType: string): boolean {
  return /lock.?release/i.test(poolType);
}

export interface CcipSvmRow {
  protocol: "ccip";
  chainKey: string;
  custodyAddress: string;
  tokenAddress: string;
  note?: string;
  amount: bigint;
  decimals: number;
}

export interface CcipSvmRead extends NonEvmReadResult<CcipSvmRow> {
  /** True when the token was found under a pool that mints rather than holds. */
  mints: boolean;
}

/**
 * What CCIP holds on Solana for one mint.
 *
 * Picks the confirmed accounts out of the check rather than trusting any
 * derivation, and reports a burn-mint find as minting rather than as a
 * balance of zero - the zero is real, and calling it custody would say the
 * bridge is here and empty about a bridge that never holds anything.
 */
export async function findCcipSvmBalances(mint: string | undefined): Promise<CcipSvmRead> {
  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const empty: CcipSvmRead = { rows: [], attempts, failures, mints: false };
  if (!mint || !CCIP_SOLANA) return empty;

  const candidates = ccipPoolCandidates(mint);
  if (candidates.length === 0) return empty;

  attempts[SOLANA_KEY] = (attempts[SOLANA_KEY] ?? 0) + 1;

  let checks: CcipSvmCheck[];
  try {
    checks = await checkCcipCandidates(mint, candidates);
  } catch {
    failures[SOLANA_KEY] = (failures[SOLANA_KEY] ?? 0) + 1;
    return empty;
  }

  const confirmed = checks.filter((c) => c.ok);
  if (confirmed.length === 0) return empty;

  const holding = confirmed.filter((c) => holdsCollateral(c.poolType));
  const rows: CcipSvmRow[] = [];
  const seen = new Set<string>();
  for (const hit of holding) {
    // One row per account. Several derivations can land on the same address -
    // the config and signer seeds coincide on some programs - and reporting
    // it twice would double the balance, which for a report about whether a
    // withdrawal will go through is the worst error there is.
    if (seen.has(hit.address)) continue;
    seen.add(hit.address);

    rows.push({
      protocol: "ccip",
      chainKey: SOLANA_KEY,
      custodyAddress: hit.address,
      tokenAddress: mint,
      note: `CCIP ${hit.poolType}`,
      amount: hit.amount ?? 0n,
      decimals: hit.decimals ?? 0,
    });
  }

  return { rows, attempts, failures, mints: rows.length === 0 };
}
