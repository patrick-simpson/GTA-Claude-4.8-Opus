// The cloud saves on the Node home (and the local test services): saves.ts's SaveBackend over a folder of files.
//
//   <state>/saves/<id>.json   {rev, at, doc, devices: [sha256 hex...]}   one file per save, written beside and renamed
//
// The index from a device's hash to its save is built in memory at start by reading the folder (a few thousand small
// files at most: saves.ts caps the count). Link codes live in memory only: they last ten minutes, so a restart
// costs a person one new code and nothing else. No names, addresses or secrets are written: only SHA-256 hashes.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeRow, SaveBackend, SaveRow } from '../src/saves.ts';

interface FileRow extends SaveRow { devices: string[] }
const ID = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;

export class FileBackend implements SaveBackend {
  private readonly dir: string;
  private readonly rows = new Map<string, FileRow>();
  private readonly byDevice = new Map<string, string>();
  private readonly codes = new Map<string, CodeRow>();

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'saves');
    try { mkdirSync(this.dir, { recursive: true }); } catch { /* reported when a write fails */ }
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { /* none yet */ }
    for (const n of names) {
      const id = n.endsWith('.json') ? n.slice(0, -5) : '';
      if (!ID.test(id)) continue;
      try {
        const r = JSON.parse(readFileSync(join(this.dir, n), 'utf8')) as Partial<FileRow>;
        if (typeof r.rev !== 'number' || typeof r.at !== 'number' || typeof r.doc !== 'string' || !Array.isArray(r.devices)) continue;
        const devices = r.devices.filter((d): d is string => typeof d === 'string' && HASH.test(d));
        this.rows.set(id, { rev: r.rev, at: r.at, doc: r.doc, devices });
        for (const d of devices) this.byDevice.set(d, id);
      } catch { /* a damaged file is skipped */ }
    }
  }

  private flush(id: string): void {
    const r = this.rows.get(id);
    const file = join(this.dir, id + '.json');
    try {
      if (!r) { rmSync(file, { force: true }); return; }
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(r));
      renameSync(file + '.tmp', file);
    } catch (e) {
      console.log(`cloud save not stored: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  }

  deviceSave(hash: string): string | null { return this.byDevice.get(hash) ?? null; }
  readSave(id: string): SaveRow | null {
    const r = this.rows.get(id);
    return r ? { rev: r.rev, at: r.at, doc: r.doc } : null;
  }
  writeSave(id: string, row: SaveRow): void {
    const old = this.rows.get(id);
    this.rows.set(id, { rev: row.rev, at: row.at, doc: row.doc, devices: old ? old.devices : [] });
    this.flush(id);
  }
  addDevice(hash: string, id: string): void {
    const was = this.byDevice.get(hash);
    if (was === id) return;
    if (was) this.removeDevice(hash);
    const r = this.rows.get(id);
    if (!r) return;
    r.devices.push(hash);
    this.byDevice.set(hash, id);
    this.flush(id);
  }
  removeDevice(hash: string): void {
    const id = this.byDevice.get(hash);
    if (!id) return;
    this.byDevice.delete(hash);
    const r = this.rows.get(id);
    if (r) { r.devices = r.devices.filter((d) => d !== hash); this.flush(id); }
  }
  deviceCount(id: string): number { return this.rows.get(id)?.devices.length ?? 0; }
  deleteSave(id: string): void {
    const r = this.rows.get(id);
    if (r) for (const d of r.devices) this.byDevice.delete(d);
    this.rows.delete(id);
    for (const [h, c] of this.codes) if (c.id === id) this.codes.delete(h);
    this.flush(id);
  }
  putCode(h: string, id: string, exp: number): void {
    for (const [k, c] of this.codes) if (c.id === id) this.codes.delete(k);
    this.codes.set(h, { h, id, exp });
  }
  takeCode(h: string): CodeRow | null {
    const c = this.codes.get(h) ?? null;
    if (c) this.codes.delete(h);
    return c;
  }
  purgeCodes(now: number): void { for (const [k, c] of this.codes) if (c.exp < now) this.codes.delete(k); }
  countSaves(): number { return this.rows.size; }
}
