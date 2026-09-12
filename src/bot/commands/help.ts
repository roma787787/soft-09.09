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
/**
 * "A, B and C" - the chains a command covers, taken from the table rather
 * than typed beside it.
 *
 * /other promised "Starknet, Radix and Aleo" while its table held four
 * chains: Paradex had been added and the sentence describing the command
 * had not. A hand-typed list next to a table it describes drifts the moment
 * the table moves, and the drift is invisible - which is the same way the
 * chain count came to be one short of its own parts.
 */
function listOf(labels: string[]): string {
  if (labels.length === 0) return "—";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} и ${labels[labels.length - 1]}`;
}

export function helpText(): string {
  // TON counted here too. The line below adds it to the breakdown and this
  // sum did not, so the total came out one short of its own parts - and one
  // short of what /sources reports for the same tables.
  // The + 1 is TON. Sui is deliberately NOT counted: this total means
  // "chains whose bridge vaults are read", and on Sui only the token's own
  // supply is. Counting it would inflate the number with a chain that
  // cannot answer the question the bot exists to answer.
  const total =
    CHAINS.length + SVM_CHAINS.length + COSMOS_CHAINS.length + OTHER_CHAINS.length + PORTAL_CHAINS.length + 1;
  return `🌉 <b>Bridge Liquidity Tracker</b>

Показывает, сколько токена лежит в контрактах-хранилищах мостов по всем сетям. Это нужно, чтобы понять, хватит ли ликвидности на вывод, прежде чем заводить туда деньги.

Поддерживаемые протоколы:
• <b>LayerZero</b> — OApp / OFT / OFT Adapter (V2, best-effort V1), не только Stargate
• <b>Hyperlane</b> — Warp Route TokenRouter / MailboxClient
• <b>Transporter</b> — пулы Chainlink CCIP, включая Solana. Контракты Circle CCTP бот опознаёт по адресу, но балансов по ним не показывает: CCTP сжигает и чеканит, хранилища у него нет
• <b>Portal</b> — Wormhole Token Bridge (сам мост и токены, которые он выпустил)
• <b>Stargate</b> — пулы Stargate, включая нативные
• <b>Across</b> — SpokePool, одно хранилище на сеть

На <b>Sui</b> бот читает только выпуск токена — сколько его там есть. Хранилища мостов там устроены иначе (не баланс по адресу, а объект внутри состояния моста) и пока не читаются.

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
<code>/ccipsvm &lt;тикер&gt;</code> — то же для CCIP на Solana, где пул — программа, а не контракт.
<code>/lzmesh &lt;тикер&gt;</code> — откуда взялось покрытие LayerZero по этому тикеру.
<code>/lzchains</code> — у каких сетей известен eid LayerZero и откуда.
<code>/lzgaps</code> — в каких сетях реестра LayerZero бот не читает хранилища.
<code>/svm &lt;тикер&gt;</code> — как бот находит хранилища на сетях VM Solana, по шагам.
<code>/cosmos &lt;тикер&gt;</code> — то же для сетей Cosmos.
<code>/other &lt;тикер&gt;</code> — то же для ${listOf(OTHER_CHAINS.map((c) => c.label))}.
<code>/portal &lt;тикер&gt;</code> — то же для ${listOf(PORTAL_CHAINS.map((c) => c.label))}, где единственный мост — Portal.
<code>/ton &lt;тикер&gt;</code> — то же для TON, где единственный мост — LayerZero.
<code>/diag</code> — проверить связь с нодами всех сетей.
<code>/chains</code> — какие сети бот добавил сам и какие отверг.
<code>/gecko</code> — работает ли ключ CoinGecko и сколько квоты осталось.
<code>/lzprobe &lt;тикер|сеть&gt;</code> — сырой ответ реестра LayerZero: по тикеру или по сети.

Сетей сейчас ${total}: ${CHAINS.length} EVM, ${SVM_CHAINS.length} на VM Solana, ${COSMOS_CHAINS.length} Cosmos, ${OTHER_CHAINS.length + PORTAL_CHAINS.length + 1} прочих. Список рос сам и будет расти дальше, поэтому здесь только счёт — имена показывают <code>/diag</code> и <code>/chains</code>.

<b>Откуда берутся адреса хранилищ:</b>
Ни один адрес не вписан руками — все приходят из реестров самих мостов, поэтому новый деплой доезжает вместе с обновлением, а не после правки кода.
• Wormhole — официальный SDK моста, Token Bridge на каждой сети
• Hyperlane — публичный реестр warp-маршрутов
• LayerZero — реестр OFT по тикерам, плюс обход сети пиров: один найденный контракт разворачивается в остальные сети сам
• Stargate — опубликованные деплои Stargate
• Across — опубликованные деплои Across
• CCIP — справочник Chainlink, роутер и реестр пулов на каждой сети
Сети бот тоже находит сам — сверяя список у CoinGecko и у реестров мостов, и проверяя каждую ноду, прежде чем добавить. Что именно добавлено и что отвергнуто — <code>/chains</code>.

Пример: <code>/info ARB</code>`;
}

export function registerHelpCommands(bot: Telegraf) {
  const send = (ctx: Context) =>
    ctx.reply(capToTelegramLimit(helpText()), { parse_mode: "HTML" });
  bot.start(async (ctx: Context) => send(ctx));
  bot.help(async (ctx: Context) => send(ctx));
}
