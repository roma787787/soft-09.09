import { contracts } from "@wormhole-foundation/sdk-base";
import { suiCall, SuiRpcError } from "../services/suiClient";
import { SUI_CHAIN, isSuiAddress, isSuiCoinType, normaliseSuiCoinType } from "../config/suiChain";

/**
 * What can be read on Sui, and what deliberately is not.
 *
 * Two questions are answered here, both with one RPC call each and neither
 * needing an address the bot had to guess:
 *
 *   - how much of a coin exists on Sui at all (`suix_getTotalSupply`), and
 *   - how much of it a named account holds (`suix_getBalance`).
 *
 * What is NOT here is walking a bridge's custody. On Sui the Wormhole token
 * bridge does not hold its collateral at an address; it holds it as a
 * `Balance<T>` inside a dynamic field of its own state object, reachable
 * only by traversing from the state id through the token registry. That is
 * real machinery, and shipping it unverified would put a number in the
 * report that nobody has ever checked against the chain - which is worse
 * than the honest gap. So the supply is read, the gap is stated, and the
 * custody walk comes when it can be tested.
 */

/** `suix_getTotalSupply` returns the value as a decimal string. */
export function parseSupply(result: unknown): bigint | undefined {
  const value = (result as { value?: unknown } | null)?.value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return undefined;
}

/** `suix_getBalance` reports the total across every coin object owned. */
export function parseBalance(result: unknown): bigint | undefined {
  const total = (result as { totalBalance?: unknown } | null)?.totalBalance;
  if (typeof total === "string" && /^\d+$/.test(total)) return BigInt(total);
  if (typeof total === "number" && Number.isSafeInteger(total)) return BigInt(total);
  return undefined;
}

export interface SuiCoinMetadata {
  decimals: number;
  symbol?: string;
}

export function parseCoinMetadata(result: unknown): SuiCoinMetadata | undefined {
  const meta = result as { decimals?: unknown; symbol?: unknown } | null;
  if (!meta || typeof meta.decimals !== "number" || !Number.isInteger(meta.decimals)) return undefined;
  return {
    decimals: meta.decimals,
    symbol: typeof meta.symbol === "string" ? meta.symbol : undefined,
  };
}

/**
 * Whether the coin Sui describes is the one that was asked about.
 *
 * The same rule the EVM side applies to a widened search, for the same
 * reason: a coin type that came from a price API is evidence, not proof,
 * and printing another project's supply under this ticker would be worse
 * than printing nothing. A coin with no metadata at all is accepted - the
 * type tag is already strong evidence, and refusing on silence would hide
 * real supply.
 */
export function suiSymbolAgrees(found: string | undefined, wanted: string): boolean {
  if (!found) return true;
  const strip = (s: string) => s.trim().toUpperCase().replace(/^W/, "").replace(/[^A-Z0-9]/g, "");
  const a = strip(found);
  const b = strip(wanted);
  return a === b || a.endsWith(b) || b.endsWith(a);
}

const metadataCache = new Map<string, SuiCoinMetadata | undefined>();

export async function suiCoinMetadata(coinType: string): Promise<SuiCoinMetadata | undefined> {
  const key = normaliseSuiCoinType(coinType) ?? coinType;
  if (metadataCache.has(key)) return metadataCache.get(key);
  let meta: SuiCoinMetadata | undefined;
  try {
    meta = parseCoinMetadata(await suiCall("suix_getCoinMetadata", [coinType]));
  } catch {
    meta = undefined;
  }
  metadataCache.set(key, meta);
  return meta;
}

export interface SuiSupply {
  chainKey: string;
  tokenAddress: string;
  amount?: bigint;
  decimals?: number;
  /** True when Sui answered and refused, rather than not answering at all. */
  unreadable?: boolean;
  /**
   * What Sui actually said, verbatim.
   *
   * A count of failures says a read did not work and nothing else, and this
   * chain cannot be tried from a laptop the way an EVM node can - so without
   * the node's own words the only way to find out why is to guess and
   * redeploy. Two calls can fail here and they need different fixes: the
   * supply refused means the coin type is wrong, the metadata refused means
   * the amount cannot be scaled.
   */
  reason?: string;
}

/**
 * How much of a coin exists on Sui.
 *
 * For a token whose home chain is elsewhere this is how much of it was
 * bridged in and is still there. For one issued on Sui - USDC is, natively
 * - it is simply the supply, and the useful thing it tells a trader is that
 * no bridge is holding collateral behind it anywhere.
 */
export async function readSuiSupply(coinType: string, symbol: string): Promise<SuiSupply | undefined> {
  if (!isSuiCoinType(coinType)) return undefined;

  let amount: bigint | undefined;
  let unreadable = false;
  let reason: string | undefined;
  try {
    const raw = await suiCall("suix_getTotalSupply", [coinType]);
    amount = parseSupply(raw);
    if (amount === undefined) {
      unreadable = true;
      // The shape, not just "it failed". A field we did not expect is a
      // different problem from a coin that does not exist, and the only way
      // to tell from here is to see what came back.
      reason = `выпуск пришёл в неожиданном виде: ${JSON.stringify(raw).slice(0, 120)}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Sui answering "no such coin" is a fact about the coin; a node that
    // could not be reached is a fact about the connection. The report says
    // different things about them, so they must not arrive as one.
    if (!(err instanceof SuiRpcError)) {
      return { chainKey: SUI_CHAIN.key, tokenAddress: coinType, reason: message };
    }
    unreadable = true;
    reason = message;
  }

  const meta = await suiCoinMetadata(coinType);
  if (!suiSymbolAgrees(meta?.symbol, symbol)) return undefined;

  // The supply read and the metadata read fail separately, and conflating
  // them sent the report saying "the contract will not give its supply"
  // about a supply that had been read perfectly well and only lacked the
  // decimals needed to scale it.
  if (!unreadable && amount !== undefined && meta?.decimals === undefined) {
    reason = "выпуск прочитан, но монета не публикует decimals — масштабировать нечем";
  }

  return {
    chainKey: SUI_CHAIN.key,
    tokenAddress: coinType,
    amount: unreadable ? undefined : amount,
    decimals: meta?.decimals,
    unreadable,
    reason,
  };
}

/** How much of a coin one Sui account holds, for a custody address we know. */
export async function readSuiBalance(owner: string, coinType: string): Promise<bigint | undefined> {
  if (!isSuiAddress(owner) || !isSuiCoinType(coinType)) return undefined;
  try {
    return parseBalance(await suiCall("suix_getBalance", [owner, coinType]));
  } catch {
    return undefined;
  }
}

/* ------------------------------ diagnostics ----------------------------- */

/** Wormhole's Sui Token Bridge, from Wormhole's own registry. */
export function suiTokenBridge(): string | undefined {
  try {
    return contracts.tokenBridge("Mainnet", "Sui");
  } catch {
    return undefined;
  }
}

export interface SuiDynamicField {
  /** The field's name as Sui prints it, which is how the collateral is keyed. */
  name: string;
  objectType: string;
  objectId: string;
}

/**
 * Pure half of the dynamic-field listing.
 *
 * The custody walk this chain needs starts here: on Sui the token bridge
 * does not own its collateral at an address, it keeps it in fields hanging
 * off its state object. Nothing is guessed from the shape - the shape is
 * printed, and the reader is written against what came back.
 */
export function parseDynamicFields(result: unknown): SuiDynamicField[] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const fields: SuiDynamicField[] = [];
  for (const raw of data.slice(0, 20)) {
    const entry = raw as { name?: { type?: unknown; value?: unknown }; objectType?: unknown; objectId?: unknown };
    const value = entry?.name?.value;
    fields.push({
      name: typeof value === "string" ? value : JSON.stringify(value ?? entry?.name?.type ?? "?").slice(0, 90),
      objectType: String(entry?.objectType ?? "?").slice(0, 120),
      objectId: String(entry?.objectId ?? "?"),
    });
  }
  return fields;
}

export interface SuiObjectShape {
  type: string;
  /** Top-level field names of the object's contents. */
  fields: string[];
  /**
   * Object ids named anywhere inside, at any depth.
   *
   * The collateral is never at the top: Sui writes a table as `{ id: { id:
   * "0x…" }, size }`, so the id that matters is always nested, and it is the
   * one the next call has to ask about.
   */
  ids: SuiNestedId[];
  note?: string;
}

export interface SuiNestedId {
  /** Where it sits, so the answer names the field rather than a bare id. */
  path: string;
  id: string;
}

/**
 * Object ids written anywhere in a Sui object's contents, each with the
 * field path it was found at.
 *
 * The path is the point. The token bridge's state carries eight fields and
 * three of them hold an id; a bare list of ids made the emitter registry and
 * the token registry indistinguishable, and the first walk followed the
 * wrong one.
 */
export function suiIdsIn(value: unknown, depth = 0, prefix = ""): SuiNestedId[] {
  if (depth > 6 || !value || typeof value !== "object") return [];
  const found: SuiNestedId[] = [];
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof inner === "string" && /^0x[0-9a-f]{64}$/i.test(inner)) found.push({ path, id: inner });
    else found.push(...suiIdsIn(inner, depth + 1, path));
  }
  const seen = new Set<string>();
  return found.filter((entry) => !seen.has(entry.id) && seen.add(entry.id));
}

/** Pure half of the object read, so the shape is covered without a live call. */
export function parseObjectShape(result: unknown): SuiObjectShape | undefined {
  const content = (result as { data?: { content?: unknown } } | null)?.data?.content as
    | { type?: unknown; fields?: unknown }
    | undefined;
  if (!content) return undefined;
  const fields = content.fields && typeof content.fields === "object" ? content.fields : undefined;
  return {
    type: String(content.type ?? "?").slice(0, 140),
    fields: fields ? Object.keys(fields) : [],
    ids: suiIdsIn(fields),
  };
}

/**
 * What one Sui object is made of.
 *
 * The dynamic fields of the token bridge's state came back empty, which does
 * not mean it holds nothing - it means the collateral hangs off something
 * inside it rather than off the object itself. The registry is a field of
 * the state and its table is an object of its own, so the walk is: read the
 * state, find the id, ask again. Printed rather than assumed, because that
 * assumption is exactly what has been wrong twice before.
 */
export async function probeSuiObject(id: string): Promise<SuiObjectShape> {
  try {
    const raw = await suiCall("sui_getObject", [id, { showContent: true, showType: true }]);
    return parseObjectShape(raw) ?? { type: "?", fields: [], ids: [], note: `не разобрано: ${JSON.stringify(raw).slice(0, 120)}` };
  } catch (err) {
    return { type: "?", fields: [], ids: [], note: `ошибка: ${(err instanceof Error ? err.message : String(err)).slice(0, 90)}` };
  }
}

export interface SuiHolderProbe {
  owner: string;
  /** What suix_getBalance said, verbatim. */
  balance: string;
  /** What hangs off the object, which is where Sui keeps a bridge's money. */
  fields: SuiDynamicField[];
  fieldsNote?: string;
}

/**
 * Everything Sui will say about one address holding one coin.
 *
 * Both halves, because they answer different questions: a balance covers
 * collateral held as owned `Coin<T>` objects, and the dynamic fields cover
 * collateral held inside the object - which is how Wormhole does it here, and
 * the reason this chain's custody is still unread.
 */
export async function probeSuiHolder(owner: string, coinType: string): Promise<SuiHolderProbe> {
  const probe: SuiHolderProbe = { owner, balance: "не спрошено", fields: [] };

  try {
    const raw = await suiCall("suix_getBalance", [owner, coinType]);
    const parsed = parseBalance(raw);
    probe.balance = parsed !== undefined ? parsed.toString() : `не разобрано: ${JSON.stringify(raw).slice(0, 90)}`;
  } catch (err) {
    probe.balance = `ошибка: ${(err instanceof Error ? err.message : String(err)).slice(0, 90)}`;
  }

  try {
    probe.fields = parseDynamicFields(await suiCall("suix_getDynamicFields", [owner, null, 20]));
    if (probe.fields.length === 0) probe.fieldsNote = "полей нет";
  } catch (err) {
    probe.fieldsNote = `ошибка: ${(err instanceof Error ? err.message : String(err)).slice(0, 90)}`;
  }

  return probe;
}
