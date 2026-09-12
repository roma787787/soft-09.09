import type { Telegraf, Context } from "telegraf";
import {
  oftRegistryByChain,
  registryChainResolver,
  resolveByOwnAliases,
  type ChainResolver,
  type RegistryChainUse,
} from "../../bridges/layerzero";
import { getChain } from "../../config/chains";
import { lzChainKeyIndex, normaliseLzKey } from "../../bridges/lzMetadata";
import { resolveSvmChain } from "../../config/svmChains";
import { resolveCosmosChain } from "../../config/cosmosChains";
import { resolveOtherChain } from "../../config/otherChains";
import { resolvePortalChain } from "../../config/portalChains";
import { TON_CHAIN } from "../../config/tonChain";
import { replyInParts } from "../reply";

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
export type LzReader = "evm" | "svm" | "ton" | "aptos" | "нет" | "сеть неизвестна";

export interface ChainCoverage extends RegistryChainUse {
  label: string;
  reader: LzReader;
}

export function classifyChain(
  use: RegistryChainUse,
  resolve: ChainResolver = resolveByOwnAliases
): ChainCoverage {
  const name = use.lzChainKey;

  // Through the same resolver the report uses, or this lists ten chains as
  // unreachable that the report reads perfectly well.
  const evm = getChain(resolve(name) ?? "");
  if (evm) return { ...use, label: evm.label, reader: "evm" };

  const svm = resolveSvmChain(name);
  if (svm) return { ...use, label: svm.label, reader: "svm" };

  if (name.toLowerCase() === TON_CHAIN.key || (TON_CHAIN.aliases as readonly string[]).includes(name.toLowerCase())) {
    return { ...use, label: TON_CHAIN.label, reader: "ton" };
  }

  const portal = resolvePortalChain(name);
  if (portal?.key === "aptos") return { ...use, label: portal.label, reader: "aptos" };

  // Known to the bot, but only through some other bridge. Wormhole reads
  // Near; nothing reads what LayerZero locks there.
  const known = resolveCosmosChain(name) ?? resolveOtherChain(name) ?? portal;
  if (known) return { ...use, label: known.label, reader: "нет" };

  return { ...use, label: name, reader: "сеть неизвестна" };
}

/**
 * The chains carrying LayerZero deployments the bot cannot read, worst
 * first. "Worst" is by how many of them lock collateral: a chain of minting
 * deployments holds nothing to miss, while one locking deployment can be the
 * whole supply of a token, as Solana was.
 */
export function gapsFrom(uses: RegistryChainUse[], resolve?: ChainResolver): ChainCoverage[] {
  return uses
    .map((u) => classifyChain(u, resolve ?? resolveByOwnAliases))
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

    const resolve = await registryChainResolver();
    const all = uses.map((u) => classifyChain(u, resolve));
    const covered = all.filter((c) => c.reader !== "нет" && c.reader !== "сеть неизвестна");
    const gaps = gapsFrom(uses, resolve);
    const totalDeployments = uses.reduce((n, u) => n + u.deployments, 0);
    const missedLocking = gaps.reduce((n, g) => n + g.locking, 0);

    const lines = [
      "<b>LayerZero: что бот не читает</b>",
      "",
      `Сетей в реестре: ${uses.length}, деплойментов: ${totalDeployments}.`,
      `Читаются: ${covered.length} ${covered.length === 1 ? "сеть" : "сетей"} ` +
        `(EVM — ${all.filter((c) => c.reader === "evm").length}, ` +
        `VM Solana — ${all.filter((c) => c.reader === "svm").length}, ` +
        `TON — ${all.filter((c) => c.reader === "ton").length}, ` +
        `Aptos — ${all.filter((c) => c.reader === "aptos").length}).`,
    ];

    if (gaps.length === 0) {
      lines.push("", "Сетей с непрочитанными деплойментами нет.");
      await replyInParts(ctx, lines.join("\n"));
      return;
    }

    lines.push(
      "",
      `<b>Не читаются: ${gaps.length}</b> — в них ${missedLocking} ` +
        "деплойментов реестр считает блокирующими, и их сейчас не видно ни в одном отчёте.",
      ""
    );

    // Sorted so the first line is the one worth writing a reader for, and
    // each says why it is a gap: a chain nobody could name and a chain with
    // no reader need opposite fixes, and "not read" says neither.
    const index = await lzChainKeyIndex();
    for (const gap of gaps.slice(0, 25)) {
      const mark = gap.locking > 0 ? "❗" : "·";
      const detail = gap.locking > 0 ? `${gap.locking} с залогом из ${gap.deployments}` : `${gap.deployments}, все чеканят`;
      const why =
        gap.reader !== "сеть неизвестна"
          ? "ридера LayerZero под это семейство сетей нет"
          : index.has(normaliseLzKey(gap.lzChainKey))
            ? "имя сопоставлено, но сети нет в боте"
            : "этого имени нет в метаданных LayerZero — сопоставить не с чем";
      lines.push(`${mark} <b>${esc(gap.label)}</b> — ${detail}\n   <i>${esc(why)}</i>`);
    }
    if (gaps.length > 25) lines.push(`… и ещё ${gaps.length - 25}.`);

    lines.push(
      "",
      "❗ — там есть что мерить. Строки без метки чеканят свой выпуск, " +
        "хранилища у них нет по устройству, и читать там нечего.",
      "Счёт идёт по полю type из реестра, а оно ошибается: на Aptos три метки " +
        "«адаптер» из четырёх оказались чеканящими. Сколько там на самом деле, " +
        "говорит только контракт — отчёт его и спрашивает.",
      "Сырые данные по сети: <code>/lzprobe &lt;сеть&gt;</code>"
    );

    await replyInParts(ctx, lines.join("\n"));
  });
}
