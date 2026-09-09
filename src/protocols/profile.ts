import type { Address, PublicClient } from "viem";
import { safeRead, isNonZero } from "./util";

const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const OWNABLE_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** EIP-1967 admin slot: keccak256("eip1967.proxy.admin") - 1. */
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

function slotToAddress(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  const hex = value.replace(/^0x/, "");
  if (hex.length < 40) return undefined;
  const addr = `0x${hex.slice(-40)}`;
  return isNonZero(addr) ? (addr as Address) : undefined;
}

/**
 * Describes a contract that matched no bridge protocol, so the answer is
 * "here is what this actually is" rather than a dead end. Covers the two
 * questions that resolve most of these cases: is it just a token, and is it
 * a proxy (whose implementation may be what you actually want to look at).
 */
export async function profileUnknownContract(
  client: PublicClient,
  address: Address
): Promise<Array<[string, string]>> {
  const [name, symbol, decimals, owner, implSlot, adminSlot] = await Promise.all([
    safeRead<string>(client, address, ERC20_ABI as any, "name"),
    safeRead<string>(client, address, ERC20_ABI as any, "symbol"),
    safeRead<number>(client, address, ERC20_ABI as any, "decimals"),
    safeRead<Address>(client, address, OWNABLE_ABI as any, "owner"),
    client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT }).catch(() => undefined),
    client.getStorageAt({ address, slot: EIP1967_ADMIN_SLOT }).catch(() => undefined),
  ]);

  const facts: Array<[string, string]> = [];

  if (symbol || name) {
    const token = [name, symbol && `(${symbol})`].filter(Boolean).join(" ");
    facts.push(["Похож на токен ERC-20", token || "да"]);
    if (decimals !== undefined) facts.push(["Знаков после запятой", String(decimals)]);
  }

  const implementation = slotToAddress(implSlot);
  if (implementation) {
    facts.push(["Это прокси, за ним реализация", implementation]);
  }

  const admin = slotToAddress(adminSlot);
  if (admin) facts.push(["Администратор прокси", admin]);

  if (owner && isNonZero(owner)) facts.push(["Владелец", owner]);

  return facts;
}
