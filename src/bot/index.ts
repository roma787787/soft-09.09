import { Telegraf } from "telegraf";
import { env } from "../config/env";
import { registerHelpCommands } from "./commands/help";
import { registerInfoCommand } from "./commands/info";
import { registerTrackCommand } from "./commands/track";
import { registerUntrackCommand } from "./commands/untrack";
import { registerListCommand } from "./commands/list";
import { registerDiagCommand } from "./commands/diag";
import { registerChainsCommand } from "./commands/chains";
import { registerLiquidityCommand } from "./commands/liquidity";
import { registerSourcesCommand } from "./commands/sources";
import { registerCcipCommand } from "./commands/ccip";
import { registerLzMeshCommand } from "./commands/lzmesh";
import { registerLzChainsCommand } from "./commands/lzchains";
import { registerSvmCommand } from "./commands/svm";
import { registerCosmosCommand } from "./commands/cosmos";
import { registerOtherCommand } from "./commands/other";
import { registerLzProbeCommand } from "./commands/lzprobe";

export function createBot(): Telegraf {
  // Telegraf abandons a handler after 90 seconds by default and hands the
  // rejection to bot.catch, which answered with a generic "try again" - and
  // /diag, which asks a hundred and fifty nodes for a block number, tripped
  // it every time. The commands bound their own work now, so the guillotine
  // is here only to stop a genuinely stuck handler from living forever.
  const bot = new Telegraf(env.telegramBotToken, { handlerTimeout: 5 * 60_000 });

  registerHelpCommands(bot);
  registerInfoCommand(bot);
  registerTrackCommand(bot);
  registerUntrackCommand(bot);
  registerListCommand(bot);
  registerDiagCommand(bot);
  registerChainsCommand(bot);
  registerLiquidityCommand(bot);
  registerSourcesCommand(bot);
  registerCcipCommand(bot);
  registerLzMeshCommand(bot);
  registerLzChainsCommand(bot);
  registerSvmCommand(bot);
  registerCosmosCommand(bot);
  registerOtherCommand(bot);
  registerLzProbeCommand(bot);

  bot.catch((err, ctx) => {
    console.error(`[bot] error while handling update ${ctx.updateType}:`, err);
    // With the reason, not without it. This bot is operated from a phone,
    // where the server log is not reachable, so a bare "try again" turns
    // every failure into a guessing game - and the reason is usually the
    // whole diagnosis ("timed out", "429 Too Many Requests", "chat not
    // found").
    const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
    const detail = reason ? `\n\nПричина: ${reason.slice(0, 200)}` : "";
    ctx
      .reply(`Произошла ошибка при обработке команды. Попробуйте ещё раз.${detail}`)
      .catch(() => {});
  });

  return bot;
}
