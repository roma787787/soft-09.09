import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { SVM_CHAINS } from "../../config/svmChains";
import { COSMOS_CHAINS } from "../../config/cosmosChains";
import { OTHER_CHAINS } from "../../config/otherChains";
import { PORTAL_CHAINS } from "../../config/portalChains";
import { PORTAL_COSMOS_CHAINS, portalCosmosUnreachable } from "../../config/portalCosmosChains";
import { TON_CHAIN } from "../../config/tonChain";
import { PORTAL_TOKEN_BRIDGE_BY_CHAIN } from "../../protocols/addresses/portal";
import { hyperlaneRouteCount, hyperlaneSkippedRoutes } from "../../bridges/hyperlane";
import { layerZeroRegistrySize, layerZeroConfigSize } from "../../bridges/layerzero";
import { vaultCoverage } from "../../bridges/vaults";
import { ccipChainCount } from "../../bridges/ccip";
import { stargateCoverage } from "../../bridges/stargate";
import { BRIDGE_SHORT_LABELS } from "../../bridges/types";
import { env } from "../../config/env";
import { plural } from "../render";

/**
 * What the bot actually knows. "Checked 4 contracts" is only meaningful next
 * to how many it could have checked, and when a report looks thin the first
 * question is always whether the token is thinly bridged or the bot is
 * thinly stocked. This answers that without guessing.
 */
export function registerSourcesCommand(bot: Telegraf) {
  bot.command("sources", async (ctx: Context) => {
    const lines: string[] = ["<b>Что бот знает о мостах</b>", ""];

    lines.push(
      `Сетей подключено: <b>${CHAINS.length + SVM_CHAINS.length + COSMOS_CHAINS.length + OTHER_CHAINS.length + PORTAL_CHAINS.length + 1}</b>`,
      `  ${CHAINS.length} EVM (включая Tron — у него EVM-совместимый RPC)`,
      `  ${SVM_CHAINS.length} на VM Solana: ${SVM_CHAINS.map((c) => c.label).join(", ")}`,
      `  ${COSMOS_CHAINS.length} Cosmos: ${COSMOS_CHAINS.map((c) => c.label).join(", ")}`,
      `  ${OTHER_CHAINS.length} прочих: ${OTHER_CHAINS.map((c) => c.label).join(", ")}`,
      `  ${PORTAL_CHAINS.length} только через Portal: ${PORTAL_CHAINS.map((c) => c.label).join(", ")}`,
      `  1 только через LayerZero: ${TON_CHAIN.label}`
    );
    lines.push("");

    const wormholeChains = Object.keys(PORTAL_TOKEN_BRIDGE_BY_CHAIN).length;
    const unreachable = portalCosmosUnreachable();
    lines.push(
      `<b>Wormhole</b> — Token Bridge в ${wormholeChains} из ${CHAINS.length} сетей EVM, плюс Solana.`,
      "Адреса из официального реестра Wormhole, держит любой токен, который через него проходил.",
      `На Near и Aptos это единственный мост, который бот умеет читать: ни warp-маршрутов, ни пулов там нет.`,
      ...(PORTAL_COSMOS_CHAINS.length > 0
        ? [
            `В Cosmos читается в ${PORTAL_COSMOS_CHAINS.length} ${plural(PORTAL_COSMOS_CHAINS.length, "сети", "сетях", "сетях")}: ` +
              `${PORTAL_COSMOS_CHAINS.map((c) => c.wormholeChain).join(", ")}.`,
          ]
        : []),
      // Named rather than left out of both lists. A chain Wormhole is on and
      // the bot cannot reach is a gap in coverage, and a gap nobody can see
      // is indistinguishable from a bridge that holds nothing.
      ...(unreachable.length > 0 ? [`Не читается: ${unreachable.join(", ")} — нет публичного узла.`] : []),
      ""
    );

    lines.push(
      `<b>Hyperlane</b> — ${hyperlaneRouteCount()} ${plural(hyperlaneRouteCount(), "маршрут", "маршрута", "маршрутов")} в реестре.` +
        (hyperlaneSkippedRoutes() > 0
          ? ` Ещё ${hyperlaneSkippedRoutes()} не читается — это тестовые и staging-деплои самой команды, реестр их не помечает.`
          : ""),
      "Ищется по тикеру; показываются только collateral-маршруты, синтетические ничего не держат.",
      "На Solana признак другой — поле standard, а не наличие collateral: там оно есть и у синтетических.",
      ""
    );

    const stargate = stargateCoverage();
    const lzSize = layerZeroRegistrySize();
    lines.push(
      `<b>LayerZero</b> — реестр OFT: ${lzSize === undefined ? "загрузится при первом /info" : `${lzSize} ${plural(lzSize, "тикер", "тикера", "тикеров")}`}.`,
      `Ручной конфиг: ${layerZeroConfigSize()} ${plural(layerZeroConfigSize(), "тикер", "тикера", "тикеров")} (переопределяет реестр).`,
      "Плюс обход сети пиров: один найденный OFT разворачивается в остальные сети сам.",
      "",
      `<b>Stargate</b> — ${stargate.pools} ${plural(stargate.pools, "пул", "пула", "пулов")} по активам: ${stargate.assets.join(", ")}.`,
      "Это тоже LayerZero, но реестра по тикерам у него нет — адреса берутся из деплоев Stargate.",
      ""
    );

    for (const { protocol, chains } of vaultCoverage()) {
      lines.push(
        `<b>${BRIDGE_SHORT_LABELS[protocol]}</b> — общее хранилище в ${chains} из ${CHAINS.length} сетей.`,
        "Один контракт на сеть держит все токены, поэтому проверяется по любому тикеру.",
        ""
      );
    }

    lines.push(
      `<b>CCIP / Transporter</b> — роутер известен в ${ccipChainCount()} из ${CHAINS.length} сетей.`,
      "Пул под конкретный токен находится опросом контрактов, списка токенов не нужно. Проверить цепочку: <code>/ccip ethereum</code>.",
      "",
      "Реестр LayerZero подтягивается на лету, остальные — вместе со сборкой бота.",
      "",
      // Which build is answering. Without it, a fix that did not work and a
      // fix that did not deploy produce the same evidence: the bot replying
      // exactly as it did before.
      env.commitSha
        ? `Сборка: <code>${env.commitSha.slice(0, 7)}</code>${env.gitBranch ? ` (${env.gitBranch})` : ""}.`
        : "Сборка: коммит не передан хостингом — какая версия запущена, отсюда не видно."
    );

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
}
