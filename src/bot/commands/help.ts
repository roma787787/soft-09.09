import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { SVM_CHAINS } from "../../config/svmChains";
import { COSMOS_CHAINS } from "../../config/cosmosChains";
import { OTHER_CHAINS } from "../../config/otherChains";
import { PORTAL_CHAINS } from "../../config/portalChains";
import { capToTelegramLimit } from "../render";

/**
 * Built per call, not once at import.
 *
 * The chain table grows after startup - the bot adds networks it discovers -
 * so a help text frozen at import time would keep quoting the number the
 * table had before any of them arrived.
 */
function helpText(): string {
  const total = CHAINS.length + SVM_CHAINS.length + COSMOS_CHAINS.length + OTHER_CHAINS.length + PORTAL_CHAINS.length;
  return `🌉 <b>Bridge Liquidity Tracker</b>

Показывает, сколько токена лежит в контрактах-хранилищах мостов по всем сетям. Это нужно, чтобы понять, хватит ли ликвидности на вывод, прежде чем заводить туда деньги.

Поддерживаемые протоколы:
• <b>LayerZero</b> — OApp / OFT / OFT Adapter (V2, best-effort V1), не только Stargate
• <b>Hyperlane</b> — Warp Route TokenRouter / MailboxClient
• <b>Transporter</b> — Chainlink CCIP Router и Circle CCTP (TokenMessenger/MessageTransmitter), которые Transporter использует под капотом
• <b>Portal</b> — Wormhole Token Bridge (сам мост и токены, которые он выпустил)
• <b>Stargate</b> — пулы Stargate, включая нативные
• <b>Across</b> — SpokePool, одно хранилище на сеть

<b>Команды:</b>
<code>/info &lt;тикер&gt;</code> — сколько токена лежит в хранилищах мостов по всем сетям. Пример: <code>/info ARB</code>
<code>/liquidity &lt;тикер&gt;</code> — то же самое, второе имя команды.
<code>/info &lt;тикер&gt; &lt;сеть&gt;</code> — то же, но только по одной сети. Пример: <code>/info USDC base</code>
<code>/info &lt;адрес&gt; [сеть]</code> — определить, что за контракт по адресу: протокол, пиры, endpoint/mailbox, владелец.
<code>/track &lt;адрес&gt; [сеть]</code> — включить оповещения о новых событиях этого контракта в этот чат.
<code>/untrack &lt;адрес&gt; [сеть]</code> — выключить оповещения.
<code>/list</code> — список того, что вы отслеживаете.
<code>/sources</code> — что бот знает: сколько сетей, маршрутов и хранилищ в реестрах.
<code>/ccip &lt;сеть&gt;</code> — по шагам показать, как бот ищет пулы CCIP в этой сети.
<code>/lzmesh &lt;тикер&gt;</code> — откуда взялось покрытие LayerZero по этому тикеру.
<code>/lzchains</code> — у каких сетей известен eid LayerZero и откуда.
<code>/svm &lt;тикер&gt;</code> — как бот находит хранилища на сетях VM Solana, по шагам.
<code>/cosmos &lt;тикер&gt;</code> — то же для сетей Cosmos.
<code>/other &lt;тикер&gt;</code> — то же для Starknet, Radix и Aleo.
<code>/portal &lt;тикер&gt;</code> — то же для Near и Aptos, где единственный мост — Portal.
<code>/diag</code> — проверить связь с нодами всех сетей.
<code>/chains</code> — какие сети бот добавил сам и какие отверг.
<code>/gecko</code> — работает ли ключ CoinGecko и сколько квоты осталось.
<code>/lzprobe &lt;тикер&gt;</code> — сырой ответ реестра LayerZero по тикеру.

Сетей сейчас ${total}: ${CHAINS.length} EVM, ${SVM_CHAINS.length} на VM Solana, ${COSMOS_CHAINS.length} Cosmos, ${OTHER_CHAINS.length + PORTAL_CHAINS.length} прочих. Список рос сам и будет расти дальше, поэтому здесь только счёт — имена показывают <code>/diag</code> и <code>/chains</code>.

<b>Откуда берутся адреса хранилищ:</b>
• Wormhole — фиксированный Token Bridge на каждую сеть, зашит в бот
• Hyperlane — публичный реестр warp-маршрутов, обновляется вместе с пакетом
• LayerZero — единого реестра нет, адаптеры ведутся вручную в конфиге

Пример: <code>/info ARB</code>`;
}

export function registerHelpCommands(bot: Telegraf) {
  const send = (ctx: Context) =>
    ctx.reply(capToTelegramLimit(helpText()), { parse_mode: "HTML" });
  bot.start(async (ctx: Context) => send(ctx));
  bot.help(async (ctx: Context) => send(ctx));
}
