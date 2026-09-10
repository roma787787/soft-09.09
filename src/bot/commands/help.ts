import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";

const HELP_TEXT = `🌉 <b>Bridge Liquidity Tracker</b>

Показывает, сколько токена лежит в контрактах-хранилищах мостов по всем сетям. Это нужно, чтобы понять, хватит ли ликвидности на вывод, прежде чем заводить туда деньги.

Поддерживаемые протоколы:
• <b>LayerZero</b> — OApp / OFT / OFT Adapter (V2, best-effort V1), не только Stargate
• <b>Hyperlane</b> — Warp Route TokenRouter / MailboxClient
• <b>Transporter</b> — Chainlink CCIP Router и Circle CCTP (TokenMessenger/MessageTransmitter), которые Transporter использует под капотом
• <b>Portal</b> — Wormhole Token Bridge (сам мост и токены, которые он выпустил)

<b>Команды:</b>
<code>/info &lt;тикер&gt;</code> — сколько токена лежит в хранилищах мостов по всем сетям. Пример: <code>/info ARB</code>
<code>/info &lt;адрес&gt; [сеть]</code> — определить, что за контракт по адресу: протокол, пиры, endpoint/mailbox, владелец.
<code>/track &lt;адрес&gt; [сеть]</code> — включить оповещения о новых событиях этого контракта в этот чат.
<code>/untrack &lt;адрес&gt; [сеть]</code> — выключить оповещения.
<code>/list</code> — список того, что вы отслеживаете.
<code>/sources</code> — что бот знает: сколько сетей, маршрутов и хранилищ в реестрах.
<code>/ccip &lt;сеть&gt;</code> — по шагам показать, как бот ищет пулы CCIP в этой сети.
<code>/diag</code> — проверить связь с нодами всех сетей.

Поддерживаемые сети: ${CHAINS.map((c) => c.label).join(", ")}.

<b>Откуда берутся адреса хранилищ:</b>
• Wormhole — фиксированный Token Bridge на каждую сеть, зашит в бот
• Hyperlane — публичный реестр warp-маршрутов, обновляется вместе с пакетом
• LayerZero — единого реестра нет, адаптеры ведутся вручную в конфиге

Пример: <code>/info ARB</code>`;

export function registerHelpCommands(bot: Telegraf) {
  bot.start(async (ctx: Context) => ctx.reply(HELP_TEXT, { parse_mode: "HTML" }));
  bot.help(async (ctx: Context) => ctx.reply(HELP_TEXT, { parse_mode: "HTML" }));
}
