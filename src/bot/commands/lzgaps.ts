import type { Telegraf, Context } from "telegraf";
import { oftRegistryByChain, type RegistryChainUse } from "../../bridges/layerzero";
import { resolveChain } from "../../config/chains";
import { resolveSvmChain } from "../../config/svmChains";
import { resolveCosmosChain } from "../../config/cosmosChains";
import { resolveOtherChain } from "../../config/otherChains";
import { resolvePortalChain } from "../../config/portalChains";
import { TON_CHAIN } from "../../config/tonChain";
import { capToTelegramLimit } from "../render";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Which reader, if any, would see a LayerZero deployment on a chain.
 *
 * Named per family rather than per chain because that is how the gaps come:
 * every EVM chain is read the same way and so is every Solana one, so a
 * missing family is a missing reader, not a missing address. PENGU's escrow
 * was a whole family - the collateral for five EVM chains sat on Solana,
 * which no LayerZero reader covered - and nothing in any report could have
 * said so.
 */
export type LzReader = "evm" | "svm" | "ton" | "нет" | "сеть неизвестна";

export interface ChainCoverage extends RegistryChainUse {
  label: string;
  reader: LzReader;
}

export function classifyChain(use: RegistryChainUse): ChainCoverage {
  const name = use.lzChainKey;

  const evm = resolveChain(name);
  if (evm) return { ...use, label: evm.label, reader: "evm" };

  const svm = resolveSvmChain(name);
  if (svm) return { ...use, label: svm.label, reader: "svm" };

  if (name.toLowerCase() === TON_CHAIN.key || (TON_CHAIN.aliases as readonly string[]).includes(name.toLowerCase())) {
    return { ...use, label: TON_CHAIN.label, reader: "ton" };
  }

  // Known to the bot, but only through some other bridge. Wormhole reads
  // Aptos and Near; nothing reads what LayerZero locks there.
  const known = resolveCosmosChain(name) ?? resolveOtherChain(name) ?? resolvePortalChain(name);
  if (known) return { ...use, label: known.label, reader: "нет" };

  return { ...use, label: name, reader: "сеть неизвестна" };
}

/**
 * The chains carrying LayerZero deployments the bot cannot read, worst
 * first. "Worst" is by how many of them lock collateral: a chain of minting
 * deployments holds nothing to miss, while one locking deployment can be the
 * whole supply of a token, as Solana was.
 */
export function gapsFrom(uses: RegistryChainUse[]): ChainCoverage[] {
  return uses
    .map(classifyChain)
    .filter((c) => c.reader === "нет" || c.reader === "сеть неизвестна")
    .sort((a, b) => b.locking - a.locking || b.deployments - a.deployments);
}

export function registerLzGapsCommand(bot: Telegraf) {
  bot.command("lzgaps", async (ctx: Context) => {
    await ctx.sendChatAction("typing");

    const uses = await oftRegistryByChain();
    if (!uses) {
      await ctx.reply("Реестр OFT сейчас недоступен, повторите позже.");
      return;
    }

    const all = uses.map(classifyChain);
    const covered = all.filter((c) => c.reader !== "нет" && c.reader !== "сеть неизвестна");
    const gaps = gapsFrom(uses);
    const totalDeployments = uses.reduce((n, u) => n + u.deployments, 0);
    const missedLocking = gaps.reduce((n, g) => n + g.locking, 0);

    const lines = [
      "<b>LayerZero: что бот не читает</b>",
      "",
      `Сетей в реестре: ${uses.length}, деплойментов: ${totalDeployments}.`,
      `Читаются: ${covered.length} ${covered.length === 1 ? "сеть" : "сетей"} ` +
        `(EVM — ${all.filter((c) => c.reader === "evm").length}, ` +
        `VM Solana — ${all.filter((c) => c.reader === "svm").length}, ` +
        `TON — ${all.filter((c) => c.reader === "ton").length}).`,
    ];

    if (gaps.length === 0) {
      lines.push("", "Сетей с непрочитанными деплойментами нет.");
      await ctx.reply(capToTelegramLimit(lines.join("\n")), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    lines.push(
      "",
      `<b>Не читаются: ${gaps.length}</b> — в них ${missedLocking} ` +
        "деплойментов держат залог, и его сейчас не видно ни в одном отчёте.",
      ""
    );

    // Sorted so the first line is the one worth writing a reader for.
    for (const gap of gaps.slice(0, 25)) {
      const mark = gap.locking > 0 ? "❗" : "·";
      const detail = gap.locking > 0 ? `${gap.locking} с залогом из ${gap.deployments}` : `${gap.deployments}, все чеканят`;
      lines.push(
        `${mark} <b>${esc(gap.label)}</b> — ${detail}` +
          (gap.reader === "сеть неизвестна" ? " <i>(сети нет в боте)</i>" : "")
      );
    }
    if (gaps.length > 25) lines.push(`… и ещё ${gaps.length - 25}.`);

    lines.push(
      "",
      "❗ — там есть что мерить. Строки без метки чеканят свой выпуск, " +
        "хранилища у них нет по устройству, и читать там нечего.",
      "Сырые данные по сети: <code>/lzprobe &lt;сеть&gt;</code>"
    );

    await ctx.reply(capToTelegramLimit(lines.join("\n")), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
