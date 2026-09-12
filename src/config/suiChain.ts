/**
 * Sui, where a coin is not a contract.
 *
 * Every other chain in this bot answers one question - `balanceOf(address)`
 * on a token contract - and Sui has neither half of it. A coin type is a
 * Move type tag (`0x…::usdc::USDC`), not an address, and a balance is not a
 * mapping inside a contract but a set of `Coin<T>` objects owned by whoever
 * holds them. So the reads here go through Sui's own JSON-RPC methods
 * rather than through anything the EVM side shares.
 */
export const SUI_CHAIN = {
  key: "sui",
  label: "Sui",
  rpcEnvVar: "SUI_RPC_URL",
  /**
   * The official full node first, then two mirrors. Sui's public endpoint
   * rate-limits by IP like every other, and a chain that drops out of a
   * report reads as "no liquidity here" - the opposite of what it means.
   */
  defaultRpcUrls: [
    "https://fullnode.mainnet.sui.io:443",
    "https://sui-rpc.publicnode.com",
    "https://rpc-mainnet.suiscan.xyz",
  ],
  explorerAddressUrl: (address: string) => `https://suiscan.xyz/mainnet/object/${address}`,
  aliases: ["sui"],
  platformNames: ["Sui", "Sui Network"],
} as const;

/**
 * A Move coin type, as `package::module::Name`.
 *
 * Deliberately strict about the shape and deliberately loose about the
 * package length: Sui writes framework types short - `0x2::sui::SUI` is the
 * chain's own coin - while everything published later carries the full
 * thirty-two bytes. Both are the same address written two ways.
 */
const COIN_TYPE = /^0x([0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/;

export function isSuiCoinType(value: string): boolean {
  return COIN_TYPE.test(value.trim());
}

/**
 * The same coin type written the one way, so two spellings of one coin do
 * not read as two coins.
 *
 * The package id is an address and is padded to its full width; the module
 * and the struct name are Move identifiers and are case-sensitive, so they
 * are left exactly as they were written. Lowercasing them would turn USDC
 * into a type that does not exist.
 */
export function normaliseSuiCoinType(value: string): string | undefined {
  const match = COIN_TYPE.exec(value.trim());
  if (!match) return undefined;
  const [, pkg, module, name] = match;
  return `0x${pkg.toLowerCase().padStart(64, "0")}::${module}::${name}`;
}

/** Whether two coin types name the same coin, however each was written. */
export function sameSuiCoinType(a: string, b: string): boolean {
  const left = normaliseSuiCoinType(a);
  const right = normaliseSuiCoinType(b);
  return left !== undefined && left === right;
}

/**
 * A Sui object or account address: thirty-two bytes, and never a coin type.
 *
 * Kept separate from the coin-type test because CoinGecko files a Sui
 * deployment under whichever of the two it happens to have, and asking a
 * balance method for a type tag - or a supply method for an address - fails
 * in a way that looks like the chain being down.
 */
export function isSuiAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value.trim());
}
