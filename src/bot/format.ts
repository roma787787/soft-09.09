import { getAddress, type Address } from "viem";
import type { DetectionResult } from "../protocols/types";
import { PROTOCOL_LABELS } from "../protocols/types";
import { getChain } from "../config/chains";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Peer addresses in the spelling everything else uses.
 *
 * They arrive as the low 20 bytes of a bytes32 peer slot, so they come out
 * lowercased - beside a header that shows the queried address checksummed.
 * One card spelling addresses two ways reads as two kinds of address, and
 * the peers are the half a person copies out to look up next.
 */
function pretty(address: string): string {
  try {
    return getAddress(address as Address);
  } catch {
    return address;
  }
}

const CONFIDENCE_EMOJI: Record<string, string> = { high: "🟢", medium: "🟡", low: "🟠" };
const CONFIDENCE_LABEL: Record<string, string> = {
  high: "уверенно",
  medium: "вероятно",
  low: "под вопросом",
};

export function formatInfoCard(chainKey: string, address: Address, results: DetectionResult[]): string {
  const chain = getChain(chainKey);
  const chainLabel = chain?.label ?? chainKey;
  const explorerUrl = chain?.explorerAddressUrl(address);

  const header =
    `🔎 <b>${esc(chainLabel)}</b>\n` +
    (explorerUrl ? `<a href="${explorerUrl}">${esc(address)}</a>\n\n` : `<code>${esc(address)}</code>\n\n`);

  if (results.length === 0) {
    return (
      header +
      "Адрес не относится ни к LayerZero, ни к Hyperlane, ни к Transporter, ни к Portal на этой сети.\n\n" +
      "Попробуйте без указания сети, тогда бот проверит все: <code>/info " +
      esc(address) +
      "</code>"
    );
  }

  const blocks = results.map((r) => {
    const lines: string[] = [];
    lines.push(
      `${CONFIDENCE_EMOJI[r.confidence]} <b>${esc(PROTOCOL_LABELS[r.protocol])}</b> — ${esc(CONFIDENCE_LABEL[r.confidence] ?? r.confidence)}`
    );
    lines.push(esc(r.role));
    if (r.facts.length) {
      lines.push("");
      for (const [k, v] of r.facts) lines.push(`• ${esc(k)}: <code>${esc(v)}</code>`);
    }
    if (r.peers.length) {
      lines.push("");
      lines.push(`<b>Связанные сети (${r.peers.length}):</b>`);
      for (const p of r.peers) {
        lines.push(`• ${esc(p.chainLabel)} (${p.remoteId}) → <code>${esc(pretty(p.peerAddress))}</code>`);
      }
    }
    if (r.notes.length) {
      lines.push("");
      for (const n of r.notes) lines.push(`⚠️ ${esc(n)}`);
    }
    return lines.join("\n");
  });

  return header + blocks.join("\n\n———\n\n");
}
