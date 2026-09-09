import type { Address } from "viem";
import type { DetectionResult } from "../protocols/types";
import { PROTOCOL_LABELS } from "../protocols/types";
import { getChain } from "../config/chains";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CONFIDENCE_EMOJI: Record<string, string> = { high: "🟢", medium: "🟡", low: "🟠" };

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
      "Не удалось распознать этот адрес как контракт LayerZero / Hyperlane / Transporter (CCIP или CCTP) / Portal на этой сети.\n\n" +
      "Возможные причины: это не мост, это не контракт, либо мост развёрнут на другой сети — попробуйте указать сеть явно: <code>/info " +
      esc(address) +
      " arbitrum</code>."
    );
  }

  const blocks = results.map((r) => {
    const lines: string[] = [];
    lines.push(`${CONFIDENCE_EMOJI[r.confidence]} <b>${esc(PROTOCOL_LABELS[r.protocol])}</b> (${esc(r.confidence)} confidence)`);
    lines.push(esc(r.role));
    if (r.facts.length) {
      lines.push("");
      for (const [k, v] of r.facts) lines.push(`• ${esc(k)}: <code>${esc(v)}</code>`);
    }
    if (r.peers.length) {
      lines.push("");
      lines.push(`<b>Связанные сети (${r.peers.length}):</b>`);
      for (const p of r.peers) {
        lines.push(`• ${esc(p.chainLabel)} (${p.remoteId}) → <code>${esc(p.peerAddress)}</code>`);
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
