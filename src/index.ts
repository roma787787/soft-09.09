import { requestedThreadpoolSize } from "./config/threadpool"; // must be first: see the module
import { env } from "./config/env";
import { CHAINS } from "./config/chains";
import { createBot } from "./bot";
import { startTracker } from "./services/tracker";
import { startChainDiscovery } from "./services/chainDiscovery";
import "./services/db"; // ensure schema is created on boot

async function main() {
  console.log(`[startup] configured chains: ${CHAINS.map((c) => c.key).join(", ")}`);
  console.log(`[startup] db: ${env.dbPath}`);
  console.log(`[startup] сборка: ${env.commitSha ? env.commitSha.slice(0, 7) : "коммит не передан"}${env.gitBranch ? ` (${env.gitBranch})` : ""}`);
  console.log(`[startup] libuv threadpool requested: ${requestedThreadpoolSize} (DNS lookups queue here)`);

  const bot = createBot();
  const stopTracker = startTracker(bot);
  // Not awaited: a slow or rate-limited token API would delay the bot
  // answering at all, and what discovery adds is the long tail.
  const stopDiscovery = startChainDiscovery();

  const shutdown = (signal: string) => {
    console.log(`[shutdown] received ${signal}`);
    stopTracker();
    stopDiscovery();
    bot.stop(signal);
    process.exit(0);
  };

  // Registered BEFORE launch: telegraf's launch() promise only resolves once
  // the bot stops, so anything after the await would never run while polling.
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await bot.launch(() => {
    console.log("[startup] bot launched, long polling active");
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
