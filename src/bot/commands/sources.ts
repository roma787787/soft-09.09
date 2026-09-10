import type { Telegraf, Context } from "telegraf";
import { CHAINS } from "../../config/chains";
import { PORTAL_TOKEN_BRIDGE_BY_CHAIN } from "../../protocols/addresses/portal";
import { hyperlaneRouteCount } from "../../bridges/hyperlane";
import { layerZeroRegistrySize, layerZeroConfigSize } from "../../bridges/layerzero";
import { vaultCoverage } from "../../bridges/vaults";
import { ccipChainCount } from "../../bridges/ccip";
import { BRIDGE_SHORT_LABELS } from "../../bridges/types";
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

    lines.push(`Сетей подключено: <b>${CHAINS.length}</b>`);
    lines.push("");

    const wormholeChains = Object.keys(PORTAL_TOKEN_BRIDGE_BY_CHAIN).length;
    lines.push(
      `<b>Wormhole</b> — Token Bridge в ${wormholeChains} из ${CHAINS.length} сетей.`,
      "Адреса из официального реестра Wormhole, держит любой токен, который через него проходил.",
      ""
    );

    lines.push(
      `<b>Hyperlane</b> — ${hyperlaneRouteCount()} ${plural(hyperlaneRouteCount(), "маршрут", "маршрута", "маршрутов")} в реестре.`,
      "Ищется по тикеру; показываются только collateral-маршруты, синтетические ничего не держат.",
      ""
    );

    const lzSize = layerZeroRegistrySize();
    lines.push(
      `<b>LayerZero</b> — реестр OFT: ${lzSize === undefined ? "загрузится при первом /info" : `${lzSize} ${plural(lzSize, "тикер", "тикера", "тикеров")}`}.`,
      `Ручной конфиг: ${layerZeroConfigSize()} ${plural(layerZeroConfigSize(), "тикер", "тикера", "тикеров")} (переопределяет реестр).`,
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
      "Реестр LayerZero подтягивается на лету, остальные — вместе со сборкой бота."
    );

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
}
