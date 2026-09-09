import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env";

const dir = path.dirname(env.dbPath);
if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(env.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    protocol TEXT,
    role TEXT,
    label TEXT,
    last_block TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(chat_id, chain, address)
  );
  CREATE INDEX IF NOT EXISTS idx_tracked_chain ON tracked_contracts(chain);
  CREATE INDEX IF NOT EXISTS idx_tracked_chat ON tracked_contracts(chat_id);
`);

export interface TrackedRow {
  id: number;
  chat_id: string;
  chain: string;
  address: string;
  protocol: string | null;
  role: string | null;
  label: string | null;
  last_block: string | null;
  created_at: string;
}

export function addTracked(row: {
  chatId: string;
  chain: string;
  address: string;
  protocol?: string;
  role?: string;
  label?: string;
  lastBlock: bigint;
}): void {
  db.prepare(
    `INSERT INTO tracked_contracts (chat_id, chain, address, protocol, role, label, last_block)
     VALUES (@chatId, @chain, @address, @protocol, @role, @label, @lastBlock)
     ON CONFLICT(chat_id, chain, address) DO UPDATE SET
       protocol = excluded.protocol,
       role = excluded.role,
       label = excluded.label`
  ).run({
    chatId: row.chatId,
    chain: row.chain,
    address: row.address.toLowerCase(),
    protocol: row.protocol ?? null,
    role: row.role ?? null,
    label: row.label ?? null,
    lastBlock: row.lastBlock.toString(),
  });
}

export function removeTracked(chatId: string, chain: string, address: string): boolean {
  const res = db
    .prepare(`DELETE FROM tracked_contracts WHERE chat_id = ? AND chain = ? AND address = ?`)
    .run(chatId, chain, address.toLowerCase());
  return res.changes > 0;
}

export function listTrackedForChat(chatId: string): TrackedRow[] {
  return db
    .prepare(`SELECT * FROM tracked_contracts WHERE chat_id = ? ORDER BY created_at DESC`)
    .all(chatId) as TrackedRow[];
}

export function listAllTracked(): TrackedRow[] {
  return db.prepare(`SELECT * FROM tracked_contracts`).all() as TrackedRow[];
}

export function listTrackedByChain(chain: string): TrackedRow[] {
  return db.prepare(`SELECT * FROM tracked_contracts WHERE chain = ?`).all(chain) as TrackedRow[];
}

export function updateLastBlock(id: number, lastBlock: bigint): void {
  db.prepare(`UPDATE tracked_contracts SET last_block = ? WHERE id = ?`).run(lastBlock.toString(), id);
}
