import { Telegraf } from "telegraf";
import { env } from "../config/env";
import { registerHelpCommands } from "./commands/help";
import { registerInfoCommand } from "./commands/info";
import { registerTrackCommand } from "./commands/track";
import { registerUntrackCommand } from "./commands/untrack";
import { registerListCommand } from "./commands/list";
import { registerDiagCommand } from "./commands/diag";
import { registerLiquidityCommand } from "./commands/liquidity";
import { registerSourcesCommand } from "./commands/sources";
import { registerCcipCommand } from "./commands/ccip";
import { registerLzMeshCommand } from "./commands/lzmesh";
import { registerLzChainsCommand } from "./commands/lzchains";
import { registerSvmCommand } from "./commands/svm";
import { registerLzProbeCommand } from "./commands/lzprobe";

export function createBot(): Telegraf {
  const bot = new Telegraf(env.telegramBotToken);

  registerHelpCommands(bot);
  registerInfoCommand(bot);
  registerTrackCommand(bot);
  registerUntrackCommand(bot);
  registerListCommand(bot);
  registerDiagCommand(bot);
  registerLiquidityCommand(bot);
  registerSourcesCommand(bot);
  registerCcipCommand(bot);
  registerLzMeshCommand(bot);
  registerLzChainsCommand(bot);
  registerSvmCommand(bot);
  registerLzProbeCommand(bot);

  bot.catch((err, ctx) => {
    console.error(`[bot] error while handling update ${ctx.updateType}:`, err);
    ctx.reply("Произошла ошибка при обработке команды. Попробуйте ещё раз.").catch(() => {});
  });

  return bot;
}
