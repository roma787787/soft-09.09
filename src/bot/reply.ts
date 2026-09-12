import type { Context } from "telegraf";
import { splitForTelegram } from "./render";

/**
 * Sends a reply that may be longer than one message.
 *
 * Telegram limits a message, not a reply, and every command here was paying
 * that limit out of its own content: thirteen of them cut the tail off and
 * said so in one line, which on a bot whose chain table grows by itself is a
 * guarantee that the newest chains are the ones nobody ever sees. /help was
 * already at 3 381 of 4 000 characters - two more commands and the list of
 * commands would have started truncating itself.
 *
 * The report learned this first and the rest follow. Splitting is on a line
 * boundary and every line these commands build is self-contained markup, so
 * nothing needs repairing across the break.
 */
export async function replyInParts(
  ctx: Context,
  text: string,
  extra: Parameters<Context["reply"]>[1] = { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
): Promise<void> {
  for (const part of splitForTelegram(text)) {
    await ctx.reply(part, extra);
  }
}
