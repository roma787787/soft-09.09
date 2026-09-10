/**
 * The offline suites import modules that pull in src/config/env.ts, which
 * demands a real bot token at import time - correct for the bot itself, since
 * a missing token should fail at startup rather than at the first message.
 * But the checks here touch no network and no Telegram API, and requiring a
 * token to run them would mean a contributor cannot verify the code without
 * first registering a bot. Placeholders keep the fail-fast rule where it
 * belongs and out of the test path.
 *
 * Imported for its side effect, and always first.
 */
process.env.TELEGRAM_BOT_TOKEN ||= "offline-selftest-placeholder";
