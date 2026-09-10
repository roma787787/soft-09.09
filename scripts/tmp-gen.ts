import "./offline-env";
import * as viemChains from "viem/chains";
import { CHAINS } from "../src/config/chains";
import { ACROSS_SPOKE_POOL_BY_CHAIN_ID } from "../src/protocols/addresses/across.generated";
import { STARGATE_POOLS_BY_SYMBOL, STARGATE_NATIVE_POOLS_BY_CHAIN_ID } from "../src/protocols/addresses/stargate.generated";
const { nativeChainIds, contracts } = require("@wormhole-foundation/sdk-base");
const meta = require("../node_modules/@hyperlane-xyz/registry/dist/chainMetadata.js");
const cm = meta.chainMetadata ?? meta.default?.chainMetadata ?? meta.default ?? meta;

const have = new Set(CHAINS.map(c => c.viemChain.id));
const haveKeys = new Set(CHAINS.map(c => c.key));
const viemById = new Map<number, any>(); const varById = new Map<number, string>();
for (const [name, c] of Object.entries(viemChains) as any[]) {
  if (c && typeof c.id === "number" && !c.testnet && !viemById.has(c.id)) { viemById.set(c.id, c); varById.set(c.id, name); }
}
// Hyperlane's own name for a chain id, so warp routes need no translation.
const hypName = new Map<number, string>();
for (const [key, m] of Object.entries<any>(cm)) {
  if (m?.protocol === "ethereum" && !m?.isTestnet && Number.isFinite(m.chainId) && !hypName.has(m.chainId)) hypName.set(m.chainId, key);
}

const want = new Set<number>();
const add = (id: number) => { if (Number.isFinite(id) && !have.has(id) && viemById.has(id)) want.add(id); };
for (const id of Object.keys(ACROSS_SPOKE_POOL_BY_CHAIN_ID)) add(Number(id));
for (const byChain of Object.values(STARGATE_POOLS_BY_SYMBOL)) for (const id of Object.keys(byChain)) add(Number(id));
for (const id of Object.keys(STARGATE_NATIVE_POOLS_BY_CHAIN_ID)) add(Number(id));
for (const m of Object.values<any>(cm)) if (m?.protocol === "ethereum" && !m?.isTestnet) add(Number(m.chainId));
for (const [id] of viemById) { try { const [net, n] = nativeChainIds.platformNativeChainIdToNetworkChain("Evm", BigInt(id)); if (net === "Mainnet" && contracts.tokenBridge("Mainnet", n)) add(id); } catch {} }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const out: string[] = [];
let skipped = 0;
for (const id of [...want].sort((a,b)=>a-b)) {
  const v = viemById.get(id)!;
  const explorer = v.blockExplorers?.default?.url;
  const rpcs: string[] = [...(v.rpcUrls?.default?.http ?? [])];
  if (!explorer || rpcs.length === 0) { skipped++; continue; }

  let key = hypName.get(id) ?? slug(v.name);
  if (haveKeys.has(key)) { skipped++; continue; }
  haveKeys.add(key);

  const env = `${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_RPC_URL`;
  out.push(`  {
    key: ${JSON.stringify(key)},
    label: ${JSON.stringify(v.name)},
    viemChain: ${varById.get(id)},
    rpcEnvVar: ${JSON.stringify(env)},
    defaultRpcUrls: [${rpcs.map(r=>JSON.stringify(r)).join(", ")}],
    explorerTxUrl: (h) => \`${explorer}/tx/\${h}\`,
    explorerAddressUrl: (a) => \`${explorer}/address/\${a}\`,
    aliases: [${JSON.stringify(key)}${slug(v.name) !== key ? ", " + JSON.stringify(slug(v.name)) : ""}],
    cmcPlatformNames: [${JSON.stringify(v.name)}${/ Mainnet$| Chain$/.test(v.name) ? ", " + JSON.stringify(v.name.replace(/ (Mainnet|Chain)$/, "")) : ""}],
  },`);
}
require("node:fs").writeFileSync("/tmp/newchains.txt", out.join("\n") + "\n");
console.log(`сгенерировано: ${out.length}, пропущено: ${skipped}`);
console.log("нужны импорты:", [...want].filter(id=>viemById.has(id)).map(id=>varById.get(id)).slice(0,5).join(", "), "...");
