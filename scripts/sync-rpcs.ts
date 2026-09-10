/**
 * Regenerates fallback RPC endpoints from the public chain list that
 * chainlist.org is built on.
 *
 * viem carries one endpoint per chain, which is fine for the majors and not
 * fine for the long tail: fifty-two of a hundred and fifty-two chains had
 * their single endpoint refuse, and a chain that drops out of a report reads
 * as "no liquidity here" rather than as a node saying no.
 *
 * Only chains this bot actually has are written out, and only plain public
 * HTTPS endpoints - anything wanting a key would fail on every request and
 * cost a round trip each time.
 *
 * Run with: npm run sync:rpcs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHAINS } from "../src/config/chains";

const PACKAGE = "chainlist-rpcs";
const OUT = "src/config/rpcs.generated.ts";
const PER_CHAIN = 4;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rpcs-"));
const tarball = execFileSync("npm", ["pack", PACKAGE, "--pack-destination", tmp, "--silent"], {
  encoding: "utf8",
}).trim();
execFileSync("tar", ["xzf", path.join(tmp, tarball), "-C", tmp]);

const version = tarball.replace(/^.*-(\d+\.\d+\.\d+.*)\.tgz$/, "$1");
const modulePath = path.join(tmp, "package/constants/extraRpcs.js");

(async () => {
  const { extraRpcs } = await import(modulePath);

  const wanted = new Map<number, string>();
  for (const chain of CHAINS) wanted.set(chain.viemChain.id, chain.key);

  const rows: Array<[number, string, string[]]> = [];
  for (const chain of CHAINS) {
    const entry = extraRpcs[String(chain.viemChain.id)];
    const rpcs = Array.isArray(entry?.rpcs) ? entry.rpcs : [];

    const urls: string[] = [];
    for (const rpc of rpcs) {
      const url = typeof rpc === "string" ? rpc : rpc?.url;
      if (typeof url !== "string" || !url.startsWith("https://")) continue;
      // An endpoint with a placeholder for a key answers nothing without
      // one, so it is a guaranteed failed request on every report.
      if (/\$\{|API_KEY|\{.*\}/i.test(url)) continue;
      if (chain.defaultRpcUrls.includes(url) || urls.includes(url)) continue;
      urls.push(url);
      if (urls.length >= PER_CHAIN) break;
    }

    if (urls.length > 0) rows.push([chain.viemChain.id, chain.key, urls]);
  }

  const body = rows
    .sort((a, b) => a[0] - b[0])
    .map(([, key, urls]) => `  ${JSON.stringify(key)}: [${urls.map((u) => JSON.stringify(u)).join(", ")}],`)
    .join("\n");

  fs.writeFileSync(
    OUT,
    `/**
 * Extra public endpoints per chain, tried after the one viem carries.
 *
 * GENERATED FILE. Do not edit by hand: run \\\`npm run sync:rpcs\\\`.
 *
 * viem lists a single endpoint per chain. That is enough for the majors and
 * not enough for the long tail, where one refusal takes the whole chain out
 * of the report - and a missing chain reads as "no liquidity here", which is
 * the opposite of what it means.
 *
 * Source: ${PACKAGE}@${version}, the data behind chainlist.org.
 */
export const EXTRA_RPC_URLS: Record<string, string[]> = {
${body}
};
`,
    "utf8"
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  const total = rows.reduce((n, r) => n + r[2].length, 0);
  console.log(`${OUT}: ${rows.length} сетей, ${total} эндпоинтов`);
})();
