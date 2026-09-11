import { getPortalChain } from "../config/portalChains";
import { findRegistryDeploymentsOnChain, type NonEvmDeployment } from "./layerzero";
import { readAptos } from "./portalNonEvm";
import type { NonEvmReadResult } from "./types";

/**
 * What LayerZero locks on Aptos.
 *
 * Four adapters there hold collateral - APT, USDe, sUSDe and WBTC - and none
 * of it appeared in any report, because the only Aptos reader the bot had
 * was Wormhole's. The gap is the same shape as Solana's was: an adapter
 * locks on one chain while the EVM side mints, so every EVM row correctly
 * says "no custody here" and the collateral behind all of them is on a chain
 * nothing asks.
 *
 * The registry names the adapter; the price API names the token. Neither
 * alone is enough - the adapter's address says nothing about what sits in
 * it, and the token address says nothing about who holds it - so a chain
 * the price API does not list the token on produces no row rather than a
 * guessed one.
 */
const APTOS = "aptos";

export interface AptosBalanceRow {
  protocol: "layerzero";
  chainKey: string;
  custodyAddress: string;
  tokenAddress: string;
  note?: string;
  amount: bigint;
  decimals: number;
}

export async function findLayerZeroAptosBalances(
  symbol: string,
  tokenByChain: Map<string, string>
): Promise<NonEvmReadResult<AptosBalanceRow>> {
  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const reasons: Record<string, string> = {};

  if (!getPortalChain(APTOS)) return { rows: [], attempts, failures };

  const deployments = (await findRegistryDeploymentsOnChain(symbol, APTOS)).filter(
    (d) => d.locksCollateral
  );
  if (deployments.length === 0) return { rows: [], attempts, failures };

  const token = tokenByChain.get(APTOS);
  if (!token) {
    // Named rather than skipped: the adapters are there and hold something,
    // and a report that omits the chain says "nothing is bridged here",
    // which is the opposite of what this means.
    attempts[APTOS] = deployments.length;
    failures[APTOS] = deployments.length;
    reasons[APTOS] = "CoinGecko не указал адрес токена в Aptos — спросить адаптер не о чем";
    return { rows: [], attempts, failures, reasons };
  }

  attempts[APTOS] = deployments.length;
  const rows: AptosBalanceRow[] = [];

  for (const deployment of dedupe(deployments)) {
    const held = await readAptos(APTOS, token, deployment.address);
    if (!held) {
      failures[APTOS] = (failures[APTOS] ?? 0) + 1;
      reasons[APTOS] = "адаптер не отдал баланс ни по одному из стандартов токенов Aptos";
      continue;
    }

    rows.push({
      protocol: "layerzero",
      chainKey: APTOS,
      custodyAddress: deployment.address,
      tokenAddress: token,
      // The registry's own wording, so a native adapter is not silently
      // filed as an ordinary one: it locks the chain's own coin.
      note: deployment.rawType,
      amount: held.amount,
      decimals: held.decimals,
    });
  }

  return { rows, attempts, failures, reasons };
}

/**
 * One adapter per address. A ticker found under its own name and under an
 * alias returns the same deployment twice, and these rows go straight into
 * the report without passing the custodian dedupe - a repeated adapter would
 * read as twice the collateral there is.
 */
function dedupe(deployments: NonEvmDeployment[]): NonEvmDeployment[] {
  const seen = new Set<string>();
  return deployments.filter((d) => {
    const key = d.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
