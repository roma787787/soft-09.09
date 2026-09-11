/**
 * TON, where the only bridge with a readable vault is LayerZero.
 *
 * Its four registry entries are all OFT_ADAPTER - adapters that lock what
 * they carry - which is exactly what this bot measures. Wormhole does not
 * list TON at all, and neither does Hyperlane.
 *
 * Addresses arrive from the registry as a bare 32-byte hash. TON writes an
 * address as workchain and hash together, so the workchain has to be put
 * back before anything will answer.
 */
export const TON_CHAIN = {
  key: "ton",
  label: "TON",
  rpcEnvVar: "TON_API_URL",
  /**
   * Toncenter's v3 API, and only it. A jetton balance is one GET here;
   * asking the chain directly would mean encoding a get-method call into a
   * cell, which is a great deal of machinery for a number the index already
   * publishes.
   *
   * One entry on purpose. tonapi.io was listed behind it as a fallback and
   * could never have worked: it is a different API with different paths, so
   * every request to it was a 404 dressed up as a second chance. A fallback
   * that cannot answer is worse than none - it hides the fact that there
   * isn't one.
   */
  apiUrls: ["https://toncenter.com/api/v3"],
  explorerAddressUrl: (address: string) => `https://tonviewer.com/${address}`,
  aliases: ["ton", "toncoin"],
  platformNames: ["TON", "Toncoin", "The Open Network"],
} as const;

/**
 * The registry's 32-byte hash as TON writes an address.
 *
 * Workchain 0 is the basechain, where every ordinary contract lives; the
 * masterchain is -1 and carries validators and configuration, not jettons.
 */
export function toTonAddress(registryAddress: string): string | undefined {
  const hex = registryAddress.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
  return `0:${hex.toLowerCase()}`;
}
