import type { Address } from "viem";
import type { Custodian, BridgeProtocol } from "./types";
import { CHAINS, getChain } from "../config/chains";
import { getClient } from "../services/rpcClient";
import { ACROSS_SPOKE_POOL_BY_CHAIN_ID } from "../protocols/addresses/across.generated";

/**
 * Some bridges keep one contract per chain that holds every token they carry,
 * rather than a contract per token. Wormhole's Token Bridge works that way,
 * and so does Across's SpokePool: the funds a relayer pays out of sit right
 * there, so its balance is exactly the liquidity available to withdraw.
 *
 * That shape is worth a lot here. A per-token bridge only shows up in the
 * report if some registry happens to list the ticker; a shared vault answers
 * for any token at all, because the question is just "what is your balance".
 */
interface SharedVault {
  protocol: BridgeProtocol;
  byChainId: Record<number, Address>;
  /**
   * A view function the genuine contract answers and an unrelated one does
   * not. Reading a balance off the wrong contract would put a confident
   * wrong number in front of someone about to move money, so an address is
   * not used until the contract at it identifies itself.
   */
  verify: { name: string; abi: readonly unknown[] };
}

const SPOKE_POOL_ABI = [
  {
    type: "function",
    name: "wrappedNativeToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const VAULTS: SharedVault[] = [
  {
    protocol: "across",
    byChainId: ACROSS_SPOKE_POOL_BY_CHAIN_ID,
    verify: { name: "wrappedNativeToken", abi: SPOKE_POOL_ABI },
  },
];

/**
 * Verification is per contract, not per report: what a deployed contract
 * answers does not change, and re-asking on every /info would add an RPC
 * round-trip per chain for nothing.
 *
 * A confirmation is therefore kept for good and a refusal only briefly. The
 * refusal is not a fact about the contract - it is a fact about the node
 * that minute - and keeping it for the life of the process means one bad
 * minute at boot silently drops the bridge on that chain until the next
 * deploy, which on a server that runs for weeks is not "temporary".
 */
const verified = new Map<string, boolean>();
const refusedAt = new Map<string, number>();

const REFUSAL_TTL_MS = 10 * 60 * 1000;

async function isGenuine(vault: SharedVault, chainKey: string, address: Address): Promise<boolean> {
  const key = `${vault.protocol}:${chainKey}:${address.toLowerCase()}`;
  if (verified.get(key)) return true;

  const refused = refusedAt.get(key);
  if (refused !== undefined && Date.now() - refused < REFUSAL_TTL_MS) return false;

  let ok = false;
  try {
    const result = await getClient(chainKey).readContract({
      address,
      abi: vault.verify.abi as never,
      functionName: vault.verify.name as never,
    });
    ok = result !== undefined && result !== null;
  } catch {
    ok = false;
  }

  if (ok) {
    verified.set(key, true);
    refusedAt.delete(key);
  } else {
    refusedAt.set(key, Date.now());
  }
  if (!ok) {
    console.warn(`[vaults] ${vault.protocol} на ${chainKey}: контракт ${address} не подтвердил себя, пропускаю`);
  }
  return ok;
}

/** Our chain key for an EVM chain id, or undefined if we do not support it. */
function chainKeyForId(chainId: number): string | undefined {
  return CHAINS.find((c) => c.viemChain.id === chainId)?.key;
}

/**
 * The vault address for each supported chain, keyed the way the rest of the
 * bot thinks about chains. Pure, so the chain-id mapping is covered by a
 * test: a table that resolves to nothing produces a report with no vault
 * rows, which reads as "no liquidity" rather than as a broken lookup.
 */
export function vaultAddressesByChain(): Partial<Record<BridgeProtocol, Record<string, Address>>> {
  const out: Partial<Record<BridgeProtocol, Record<string, Address>>> = {};
  for (const vault of VAULTS) {
    const perChain: Record<string, Address> = {};
    for (const [rawId, address] of Object.entries(vault.byChainId)) {
      const chainKey = chainKeyForId(Number(rawId));
      if (chainKey && getChain(chainKey)) perChain[chainKey] = address;
    }
    out[vault.protocol] = perChain;
  }
  return out;
}

/**
 * Every shared vault holding this token, on the chains we support.
 *
 * A vault with a zero balance is dropped downstream by the renderer, so a
 * bridge that simply does not carry this token costs a read and nothing
 * more.
 */
export async function findVaultCustodians(tokenByChain: Map<string, Address>): Promise<Custodian[]> {
  const candidates: Array<{ vault: SharedVault; chainKey: string; address: Address; token: Address }> = [];
  const byChain = vaultAddressesByChain();

  for (const vault of VAULTS) {
    for (const [chainKey, address] of Object.entries(byChain[vault.protocol] ?? {})) {
      const token = tokenByChain.get(chainKey);
      if (!token) continue;
      candidates.push({ vault, chainKey, address, token });
    }
  }

  const checks = await Promise.all(candidates.map((c) => isGenuine(c.vault, c.chainKey, c.address)));

  return candidates
    .filter((_, i) => checks[i])
    .map(({ vault, chainKey, address, token }) => ({
      protocol: vault.protocol,
      chainKey,
      custodyAddress: address,
      tokenAddress: token,
    }));
}

/** How many chains each shared vault covers, for the /sources report. */
export function vaultCoverage(): Array<{ protocol: BridgeProtocol; chains: number }> {
  const byChain = vaultAddressesByChain();
  return VAULTS.map((v) => ({ protocol: v.protocol, chains: Object.keys(byChain[v.protocol] ?? {}).length }));
}
