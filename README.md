# Bridge Contract Tracker

Telegram-бот, который по адресу контракта определяет, к какому кросс-чейн
мосту он относится, и умеет присылать оповещения о его новых событиях в
реальном времени.

Поддерживаемые протоколы:

| Протокол | Что определяется |
|---|---|
| **LayerZero** | Полный стандарт OApp / OFT / OFT Adapter (LayerZero V2, с best-effort поддержкой legacy V1) — не только контракты Stargate, а любой LayerZero-контракт |
| **Hyperlane** | Warp Route `TokenRouter` и другие `MailboxClient`-контракты |
| **Transporter** | У transporter.io нет собственного моста — это интерфейс поверх Chainlink CCIP (Router) и, для нативного USDC, напрямую поверх Circle CCTP (`TokenMessenger`/`MessageTransmitter`). Бот распознаёт оба этих рельса и помечает их как Transporter |
| **Portal** | Wormhole Token Bridge — как сам контракт моста, так и токены, которые он выпустил (wrapped assets) |

## Быстрый старт

```bash
npm install
cp .env.example .env
# впишите TELEGRAM_BOT_TOKEN (получить у @BotFather) и, по желанию, свои RPC
npm run dev      # разработка (tsx watch)
# либо
npm run build && npm start   # прод-сборка
```

## Команды бота

- `/info <адрес> [сеть]` — определить протокол моста и показать конфигурацию:
  endpoint/mailbox/core-bridge адрес, версию, владельца, список связанных
  сетей (peers) с их адресами на другой стороне. Без указания сети бот
  проверит адрес на всех поддерживаемых сетях параллельно.
- `/track <адрес> [сеть]` — включить отслеживание событий этого контракта в
  реальном времени с оповещениями в текущий чат.
- `/untrack <адрес> [сеть]` — выключить отслеживание.
- `/list` — список того, что отслеживается в этом чате.

Поддерживаемые сети «из коробки»: Ethereum, Arbitrum, Optimism, Base,
Polygon, BNB Chain, Avalanche (настраивается в `src/config/chains.ts`).

## Как устроено определение протокола

Определение построено в первую очередь на **прямых RPC-вызовах view-функций**
контракта (`endpoint()`, `mailbox()`, `wormhole()`, `typeAndVersion()`,
`localMessageTransmitter()` и т.д.), а не на слепом сравнении со списком
адресов — так бот распознаёт протокол даже если контракт не попал в наш
локальный справочник. Списки известных адресов (`src/protocols/addresses/*`)
используются как:

1. Дополнительное подтверждение уверенности результата (confidence: `high`
   вместо `medium`/`low`);
2. Источник адресов инфраструктуры моста на *других* сетях, чтобы можно было
   опросить peers/routers контракта.

Важно: числовые идентификаторы сетей у каждого протокола (LayerZero `eid`,
Hyperlane `domain`, Wormhole `chainId`, CCTP `domain`) бот **не берёт слепо из
статической таблицы** — для каждой настроенной в `chains.ts` сети он сам
спрашивает у соответствующего инфраструктурного контракта её "родной" id
(`eid()` / `localDomain()` / `chainId()`) через RPC и кеширует результат на
час (`src/services/idMaps.ts`). Статические таблицы используются только как
подпись для сетей, к которым у бота нет RPC-подключения.

### Известные адреса — источники и актуальность

Адреса эндпоинтов/мейлбоксов/мостов в `src/protocols/addresses/*.ts` собраны
из официальной документации и реестров протоколов (LayerZero deployed
contracts, `hyperlane-xyz/hyperlane-registry`, Wormhole contract addresses,
Circle CCTP docs, Chainlink CCIP directory) по состоянию на **2026-09-09** и
прокомментированы источником в коде. Перед использованием в
продакшене/принятием решений на основе этих данных стоит свериться с
официальной документацией — адреса мостов меняются редко, но не никогда.

## Реальное время (`/track`)

Раз в `TRACK_POLL_INTERVAL_MS` (по умолчанию 60с) бот проходит по всем
отслеживаемым контрактам, группирует их по сети и делает `eth_getLogs` по
диапазону новых блоков **без фильтра по topics** — то есть ловит вообще любое
событие контракта, а не только те, чью сигнатуру мы явно знаем. Это осознанный
выбор: неправильно угаданный topic0 означал бы тихо пропущенные события.
Дальше `src/services/eventCatalog.ts` пытается красиво декодировать лог по
каталогу известных сигнатур (`OFTSent`, `SentTransferRemote`,
`DepositForBurn`, `TransferRedeemed` и т.д.); если не получилось — алерт всё
равно приходит, просто в сыром виде (номер блока, ссылка на транзакцию).

Ограничения по `TRACK_MAX_BLOCK_RANGE` и `TRACK_INITIAL_LOOKBACK_BLOCKS` в
`.env` бережно относятся к публичным RPC — для более частого опроса и
большего охвата используйте собственный RPC-ключ (Alchemy/Infura/QuickNode).

## Структура проекта

```
src/
  config/          сети (chains.ts) и переменные окружения (env.ts)
  protocols/
    types.ts        общие типы результата детекции
    layerzero.ts     детектор LayerZero
    hyperlane.ts     детектор Hyperlane
    portal.ts        детектор Portal / Wormhole Token Bridge
    transporter.ts   детектор Transporter (CCIP + CCTP)
    registry.ts      прогоняет все детекторы по адресу
    addresses/       справочники известных адресов + числовых id
  services/
    rpcClient.ts     кеш viem PublicClient по сетям
    idMaps.ts        динамическое разрешение eid/domain/chainId по живым RPC
    eventCatalog.ts  best-effort декодирование логов для алертов
    tracker.ts       поллинг eth_getLogs и рассылка алертов
    db.ts            SQLite-хранилище отслеживаемых контрактов
  bot/
    index.ts         сборка Telegraf-бота
    format.ts        рендер /info в HTML для Telegram
    parse.ts          разбор аргументов команд
    commands/        /info, /track, /untrack, /list, /help
  index.ts           точка входа
```

## Расширение

- **Новая сеть**: добавить запись в `src/config/chains.ts` (укажет viem
  `Chain`, env-переменную RPC и алиасы), при желании — адреса моста для этой
  сети в `protocols/addresses/*`.
- **Новый протокол**: добавить `protocols/<name>.ts` с функцией
  `detectXxx(client, chainKey, address): Promise<DetectionResult | undefined>`,
  подключить её в `protocols/registry.ts`.

## Известные ограничения

- Списки известных адресов покрывают не все 7 сетей для каждого протокола
  (например, не для всех сетей найден официально подтверждённый адрес Portal
  Token Bridge или CCIP Router) — детекция в таких случаях всё равно работает
  через ABI-пробинг, но с более низким уровнем confidence.
- Для LayerZero V1 (legacy) энумерация peers не реализована — V1 использует
  формат `trustedRemote`, завязанный на устаревшую нумерацию chainId,
  специфичную для каждой сети.
- Бот использует публичные бесплатные RPC по умолчанию — они могут быть
  медленными или ограничивать частоту запросов; для продакшена используйте
  собственные RPC-эндпоинты.
