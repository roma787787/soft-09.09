import type { Telegraf, Context } from "telegraf";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Candidate sources for a LayerZero OFT registry.
 *
 * The spec allowed automating LayerZero "if a suitable source is found".
 * These hosts are unreachable from the development environment, so the
 * deployed bot is asked to look instead: this command reports what each URL
 * actually returns, and the parser is then written against a real response
 * rather than a guessed one. The list is fixed on purpose - the bot never
 * fetches a URL someone hands it.
 */
const CANDIDATES = [
  "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list",
  "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts",
  "https://metadata.layerzero-api.com/v1/metadata",
];

/** Describes a value's shape without dumping the whole thing into a chat. */
function describe(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `массив[${value.length}]${value.length > 0 && depth < 2 ? ` из ${describe(value[0], depth + 1)}` : ""}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    const head = keys.slice(0, 12).join(", ");
    return `объект{${keys.length} ключей: ${head}${keys.length > 12 ? ", …" : ""}}`;
  }
  const text = String(value);
  return `${typeof value} "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;
}

async function probeOne(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return `❌ <code>${esc(url)}</code>\n   HTTP ${response.status}`;

    const text = await response.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return `⚠️ <code>${esc(url)}</code>\n   HTTP 200, но это не JSON (${text.length} байт)`;
    }

    const lines = [`✅ <code>${esc(url)}</code>`, `   размер: ${text.length} байт`, `   верхний уровень: ${esc(describe(parsed))}`];

    const firstKey = Array.isArray(parsed) ? "0" : Object.keys(parsed)[0];
    if (firstKey !== undefined) {
      const first = Array.isArray(parsed) ? parsed[0] : parsed[firstKey];
      lines.push(`   первый ключ: <code>${esc(String(firstKey))}</code>`);
      lines.push(`   его значение: ${esc(describe(first, 1))}`);

      if (first && typeof first === "object" && !Array.isArray(first)) {
        for (const [k, v] of Object.entries(first).slice(0, 6)) {
          lines.push(`      ${esc(k)}: ${esc(describe(v, 2))}`);
        }
      }
    }
    return lines.join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `❌ <code>${esc(url)}</code>\n   ${esc(message.slice(0, 120))}`;
  }
}

/**
 * One-off reconnaissance for wiring up an automatic LayerZero source.
 * Remove it once the source is either integrated or ruled out.
 */
export function registerLzProbeCommand(bot: Telegraf) {
  bot.command("lzprobe", async (ctx: Context) => {
    await ctx.sendChatAction("typing");
    const results = await Promise.all(CANDIDATES.map(probeOne));
    await ctx.reply(
      `🔬 Проверка источников LayerZero\n\n${results.join("\n\n")}\n\nПришлите этот ответ — по структуре я напишу разбор.`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  });
}
