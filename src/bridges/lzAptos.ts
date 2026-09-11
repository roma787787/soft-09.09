import { getPortalChain } from "../config/portalChains";
import { findRegistryDeploymentsOnChain, type NonEvmDeployment } from "./layerzero";
import { readAptos, aptosOftShape } from "./portalNonEvm";
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

export interface AptosReadResult extends NonEvmReadResult<AptosBalanceRow> {
  /**
   * True when a deployment there mints its own supply. The report says that
   * of a chain rather than showing an empty vault, and the two are entirely
   * different answers to "can I withdraw here".
   */
  mints?: boolean;
}

export async function findLayerZeroAptosBalances(
  symbol: string,
  tokenByChain: Map<string, string>
): Promise<AptosReadResult> {
  const attempts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const reasons: Record<string, string> = {};

  if (!getPortalChain(APTOS)) return { rows: [], attempts, failures };

  const deployments = (await findRegistryDeploymentsOnChain(symbol, APTOS)).filter(
    (d) => d.locksCollateral
  );
  if (deployments.length === 0) return { rows: [], attempts, failures };

  const listed = tokenByChain.get(APTOS);
  attempts[APTOS] = deployments.length;
  const rows: AptosBalanceRow[] = [];
  let mints = false;

  for (const deployment of dedupe(deployments)) {
    const shape = await aptosOftShape(APTOS, deployment.address);
    if (!shape) {
      failures[APTOS] = (failures[APTOS] ?? 0) + 1;
      reasons[APTOS] = "объект адаптера не отдал ресурсы — определить, блокирует он или чеканит, нечем";
      continue;
    }

    // Minting deployments hold nothing by design, which is a different
    // answer from an empty vault and must not be reported as one. The
    // registry files USDe's Aptos entry as an adapter and the object says
    // otherwise; the object is the one that is right.
    if (shape.mints) {
      mints = true;
      continue;
    }
    if (!shape.escrow) {
      failures[APTOS] = (failures[APTOS] ?? 0) + 1;
      reasons[APTOS] = `${shape.module} не назвал объект эскроу`;
      continue;
    }

    // The price API's address first, where it has one: it is what the rest
    // of the report is about, and it has been read correctly here. The
    // object's own is the fallback that reaches what the price API does not
    // know - WBTC's adapter locks real collateral on a chain CoinGecko lists
    // no address for at all.
    const token = listed ?? shape.asset;
    if (!token) {
      failures[APTOS] = (failures[APTOS] ?? 0) + 1;
      reasons[APTOS] = `${shape.module} не назвал актив, и CoinGecko не знает токен в Aptos`;
      continue;
    }

    // Read against the escrow, not the adapter: the adapter's own store is
    // empty on every deployment here, which is exactly why this chain
    // reported nothing.
    const held = await readAptos(APTOS, token, shape.escrow);
    if (!held) {
      failures[APTOS] = (failures[APTOS] ?? 0) + 1;
      reasons[APTOS] = "эскроу не отдал баланс ни по одному из стандартов токенов Aptos";
      continue;
    }

    rows.push({
      protocol: "layerzero",
      chainKey: APTOS,
      custodyAddress: shape.escrow,
      tokenAddress: token,
      note: "эскроу OFT",
      amount: held.amount,
      decimals: held.decimals,
    });
  }

  return { rows, attempts, failures, reasons, mints };
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
