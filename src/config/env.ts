import "dotenv/config";
import { CHAINS } from "./chains";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

export const env = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  dbPath: process.env.DB_PATH || "./data/bot.db",
  trackPollIntervalMs: Number(process.env.TRACK_POLL_INTERVAL_MS || 60_000),
  trackMaxBlockRange: BigInt(process.env.TRACK_MAX_BLOCK_RANGE || 2000),
  trackInitialLookbackBlocks: BigInt(process.env.TRACK_INITIAL_LOOKBACK_BLOCKS || 1000),
  layerZeroScanApi: process.env.LAYERZERO_SCAN_API || "https://scan.layerzero-api.com/v1",
  wormholescanApi: process.env.WORMHOLESCAN_API || "https://api.wormholescan.io",
  circleIrisApi: process.env.CIRCLE_IRIS_API || "https://iris-api.circle.com/v2",
};

export function rpcUrlFor(chainKey: string): string {
  const chain = CHAINS.find((c) => c.key === chainKey);
  if (!chain) throw new Error(`Unknown chain "${chainKey}"`);
  return process.env[chain.rpcEnvVar] || chain.defaultRpcUrl;
}
