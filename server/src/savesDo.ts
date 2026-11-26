// The cloud saves as a Durable Object (SQLite): a thin Cloudflare wrapper round saves.ts, which decides everything.
// One object for all saves ("saves-1"), kept apart from the town so a resting or full town never touches it.
// It has no sockets, no alarm and no timers, so it hibernates between requests; it is billed for the Worker's fetch
// to it (one Durable Object request) and the rows each save writes. saves.ts keeps a daily allowance of operations
// well inside the share of the free limits the game may use.

import { DurableObject } from 'cloudflare:workers';
import { BODY_MAX, handleSave, newState } from './saves';
import type { CodeRow, SaveBackend, SaveRow, SaveState } from './saves';

class SqlBackend implements SaveBackend {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS saves (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, at INTEGER NOT NULL, doc TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS devices (hash TEXT PRIMARY KEY, id TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS devices_id ON devices (id)');
    sql.exec('CREATE TABLE IF NOT EXISTS codes (h TEXT PRIMARY KEY, id TEXT NOT NULL, exp INTEGER NOT NULL)');
  }
  deviceSave(hash: string): string | null {
    for (const r of this.sql.exec('SELECT id FROM devices WHERE hash = ?', hash)) return r.id as string;
    return null;
  }
  readSave(id: string): SaveRow | null {
    for (const r of this.sql.exec('SELECT rev, at, doc FROM saves WHERE id = ?', id)) return { rev: r.rev as number, at: r.at as number, doc: r.doc as string };
    return null;
  }
  writeSave(id: string, row: SaveRow): void {
    this.sql.exec('INSERT OR REPLACE INTO saves (id, rev, at, doc) VALUES (?, ?, ?, ?)', id, row.rev, row.at, row.doc);
  }
  addDevice(hash: string, id: string): void { this.sql.exec('INSERT OR REPLACE INTO devices (hash, id) VALUES (?, ?)', hash, id); }
  removeDevice(hash: string): void { this.sql.exec('DELETE FROM devices WHERE hash = ?', hash); }
  deviceCount(id: string): number {
    for (const r of this.sql.exec('SELECT COUNT(*) AS n FROM devices WHERE id = ?', id)) return r.n as number;
    return 0;
  }
  deleteSave(id: string): void {
    this.sql.exec('DELETE FROM saves WHERE id = ?', id);
    this.sql.exec('DELETE FROM devices WHERE id = ?', id);
    this.sql.exec('DELETE FROM codes WHERE id = ?', id);
  }
  putCode(h: string, id: string, exp: number): void {
    this.sql.exec('DELETE FROM codes WHERE id = ?', id);
    this.sql.exec('INSERT OR REPLACE INTO codes (h, id, exp) VALUES (?, ?, ?)', h, id, exp);
  }
  takeCode(h: string): CodeRow | null {
    let row: CodeRow | null = null;
    for (const r of this.sql.exec('SELECT h, id, exp FROM codes WHERE h = ?', h)) row = { h: r.h as string, id: r.id as string, exp: r.exp as number };
    if (row) this.sql.exec('DELETE FROM codes WHERE h = ?', h);
    return row;
  }
  purgeCodes(now: number): void { this.sql.exec('DELETE FROM codes WHERE exp < ?', now); }
  countSaves(): number {
    for (const r of this.sql.exec('SELECT COUNT(*) AS n FROM saves')) return r.n as number;
    return 0;
  }
}

export class Saves extends DurableObject {
  private st: SaveState | null = null;

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const text = await request.text();
    if (text.length > BODY_MAX) return Response.json({ ok: 0, err: 'too big' }, { status: 413 });
    this.st ??= newState(new SqlBackend(this.ctx.storage.sql));
    const r = await handleSave(text, this.st, Date.now());
    return Response.json(r.body, { status: r.status });
  }
}
