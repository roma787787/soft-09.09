import { env } from "./config/env";
import { CHAINS } from "./config/chains";
import { createBot } from "./bot";
import { startTracker } from "./services/tracker";
import "./services/db"; // ensure schema is created on boot

async function main() {
  console.log(`[startup] configured chains: ${CHAINS.map((c) => c.key).join(", ")}`);
  console.log(`[startup] db: ${env.dbPath}`);

  const bot = createBot();
  const stopTracker = startTracker(bot);

  const shutdown = (signal: string) => {
    console.log(`[shutdown] received ${signal}`);
    stopTracker();
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
