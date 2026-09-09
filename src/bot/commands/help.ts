import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";

const HELP_TEXT = `🌉 <b>Bridge Contract Tracker</b>

Определяет, к какому кросс-чейн протоколу относится контракт, и умеет следить за его событиями в реальном времени.

Поддерживаемые протоколы:
• <b>LayerZero</b> — OApp / OFT / OFT Adapter (V2, best-effort V1), не только Stargate
• <b>Hyperlane</b> — Warp Route TokenRouter / MailboxClient
• <b>Transporter</b> — Chainlink CCIP Router и Circle CCTP (TokenMessenger/MessageTransmitter), которые Transporter использует под капотом
• <b>Portal</b> — Wormhole Token Bridge (сам мост и токены, которые он выпустил)

<b>Команды:</b>
<code>/info &lt;адрес&gt; [сеть]</code> — определить протокол и показать конфигурацию (пиры, endpoint/mailbox, владелец). Без сети — проверка по всем поддерживаемым сетям.
<code>/track &lt;адрес&gt; [сеть]</code> — включить оповещения о новых событиях этого контракта в этот чат.
<code>/untrack &lt;адрес&gt; [сеть]</code> — выключить оповещения.
<code>/list</code> — список того, что вы отслеживаете.

Поддерживаемые сети: ${CHAINS.map((c) => c.label).join(", ")}.

Пример (контракт моста Portal в Ethereum):
<code>/info 0x3ee18B2214AFF97000D974cf647E7C347E8fa585 ethereum</code>`;

export function registerHelpCommands(bot: Telegraf) {
  bot.start(async (ctx: Context) => ctx.reply(HELP_TEXT, { parse_mode: "HTML" }));
  bot.help(async (ctx: Context) => ctx.reply(HELP_TEXT, { parse_mode: "HTML" }));
}
