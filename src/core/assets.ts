// The download queue. Every model file and picture the game fetches after its own code comes through here, so that
//  - the order is the order of need: main.ts hands over the list before the world is built, and the downloads run
//    under the build instead of starting when it ends;
//  - only a few run at once: twenty fetches on one connection share the line evenly, and the file the player is
//    standing next to arrives with the last of them;
//  - the bytes are read off the network by a worker: while the world is being built the page's own thread is busy
//    for hundreds of milliseconds at a time, and a download nobody is reading from stops (`?fetchworker=0`: read
//    them here instead, for comparing);
//  - the title card can say truthfully how much has arrived, and hold the start until what is round the player is in.
//
// Sizes: vite.config.ts writes the bytes of every file in public/models into the build as __MODEL_BYTES__, so the
// total is known before the first response. What has arrived is counted from the response bodies as they stream.
// (The live site sends .glb files gzipped; these are the unpacked bytes on both sides of the fraction.)

declare const __MODEL_BYTES__: Record<string, number> | undefined;

const SIZES: Record<string, number> = typeof __MODEL_BYTES__ === 'object' && __MODEL_BYTES__ ? __MODEL_BYTES__ : {};
/** Downloads in flight at once. */
const LANES = 4;

/** The worker: fetch a file, say now and then how much of it is in, hand the bytes over without copying them. */
const WORKER = `onmessage = async (e) => {
  const { id, url, priority } = e.data;
  try {
    const res = await fetch(url, { priority });
    if (!res.ok) { postMessage({ id, done: true }); return; }
    const type = res.headers.get('content-type') || '';
    const reader = res.body && res.body.getReader();
    if (!reader) { const b = await res.arrayBuffer(); postMessage({ id, done: true, buf: b, got: b.byteLength, type }, [b]); return; }
    const parts = []; let got = 0, told = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.byteLength;
      const now = performance.now();
      if (now - told > 90) { told = now; postMessage({ id, got }); }
    }
    const out = new Uint8Array(got); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    postMessage({ id, done: true, buf: out.buffer, got, type }, [out.buffer]);
  } catch (err) { postMessage({ id, done: true }); }
};`;

interface Item {
  url: string;
  /** Part of the opening view. */
  opening: boolean;
  /** Expected bytes until the file is in, then its true size. */
  size: number;
  got: number;
  done: boolean;
  begun: boolean;
  type: string;
  body: Promise<ArrayBuffer | null>;
  begin: () => void;
}

interface Told { id: number; got?: number; done?: boolean; buf?: ArrayBuffer; type?: string }

export interface LoadState {
  /** Bytes arrived and expected, over every file asked for or planned. */
  got: number; total: number;
  /** The same for the files of the opening view. */
  openGot: number; openTotal: number;
  files: number; filesDone: number;
  /** ms after navigation when the latest file was complete. */
  lastAt: number;
}

class Assets {
  private items = new Map<string, Item>();
  private queue: Item[] = [];
  private running = 0;
  private holds: Promise<unknown>[] = [];
  /** undefined: not tried yet. null: this browser will not start one, or it died. */
  private worker: Worker | null | undefined = new URLSearchParams(location.search).get('fetchworker') === '0' ? null : undefined;
  private owed = new Map<number, { it: Item; resolve: (b: ArrayBuffer | null | Promise<ArrayBuffer | null>) => void }>();
  private seq = 0;
  private lastAt = 0;
  /** ms after navigation when each named hold settled, and `opening` when the last of them did. */
  readonly marks: Record<string, number> = {};

  /** Say what will be wanted, most needed first. The first `opening` of them are what the opening view shows. */
  plan(urls: readonly string[], opening: number): void {
    urls.forEach((u, i) => { if (!this.items.has(u)) this.queue.push(this.make(u, i < opening)); });
    this.pump();
  }

  private make(url: string, opening: boolean): Item {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const it: Item = {
      url, opening, size: SIZES[url.replace(/^.*\//, '')] ?? 0, got: 0, done: false, begun: false, type: '', body: null!,
      begin: () => { if (!it.begun) { it.begun = true; this.running++; open(); } },
    };
    it.body = gate.then(() => this.viaWorker(it) ?? this.direct(it)).then((b) => {
      it.done = true; it.size = it.got; this.lastAt = performance.now(); this.running--; this.pump();
      return b;
    });
    this.items.set(url, it);
    return it;
  }

  private pump(): void {
    while (this.running < LANES && this.queue.length) this.queue.shift()!.begin();
  }

  /** Ask the worker for a file, or null if there is no worker. Never rejects. */
  private viaWorker(it: Item): Promise<ArrayBuffer | null> | null {
    if (this.worker === undefined) {
      try {
        const w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })));
        w.onmessage = (e: MessageEvent<Told>) => {
          const d = e.data, x = this.owed.get(d.id);
          if (!x) return;
          if (d.got !== undefined) x.it.got = d.got;
          if (!d.done) return;
          this.owed.delete(d.id);
          x.it.type = d.type ?? '';
          if (!d.buf) x.it.got = 0;
          x.resolve(d.buf ?? null);
        };
        // It would not start, or died: whatever it owed is fetched here instead.
        w.onerror = () => {
          this.worker = null;
          for (const x of this.owed.values()) x.resolve(this.direct(x.it));
          this.owed.clear();
        };
        this.worker = w;
      } catch {
        this.worker = null;
      }
    }
    const w = this.worker;
    if (!w) return null;
    return new Promise((resolve) => {
      const id = ++this.seq;
      this.owed.set(id, { it, resolve });
      // A worker made from a blob has no folder of its own to resolve a relative address against.
      w.postMessage({ id, url: new URL(it.url, document.baseURI).href, priority: it.opening ? 'high' : 'low' });
    });
  }

  /** The same on the page's own thread. Never throws: a file that is missing or cut short is null. */
  private async direct(it: Item): Promise<ArrayBuffer | null> {
    try {
      it.got = 0;
      const res = await fetch(it.url, { priority: it.opening ? 'high' : 'low' } as RequestInit);
      if (!res.ok) return null;
      it.type = res.headers.get('content-type') ?? '';
      const reader = res.body?.getReader();
      if (!reader) { const b = await res.arrayBuffer(); it.got = b.byteLength; return b; }
      const parts: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); it.got += value.byteLength;
      }
      const out = new Uint8Array(it.got);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.byteLength; }
      return out.buffer;
    } catch {
      it.got = 0;
      return null;
    }
  }

  /**
   * A file's bytes, once. A planned file is already on its way or waiting its turn (and is fetched now if it is
   * still waiting: someone needs it); any other is fetched at once. The bytes are handed over, not kept.
   */
  bytes(url: string): Promise<ArrayBuffer | null> {
    let it = this.items.get(url);
    if (!it) it = this.make(url, false);
    if (!it.begun) {
      const i = this.queue.indexOf(it);
      if (i >= 0) this.queue.splice(i, 1);
      it.begin();
    }
    const item = it, body = it.body;
    return body.then((b) => { if (item.body === body) item.body = Promise.resolve(null); return b; });
  }

  /** The same as a Blob carrying the server's content type, which is how a picture is told from the dev server's stand-in page. */
  async blob(url: string): Promise<Blob | null> {
    const b = await this.bytes(url);
    return b ? new Blob([b], { type: this.items.get(url)?.type ?? '' }) : null;
  }

  state(): LoadState {
    const s: LoadState = { got: 0, total: 0, openGot: 0, openTotal: 0, files: 0, filesDone: 0, lastAt: Math.round(this.lastAt) };
    for (const it of this.items.values()) {
      const size = Math.max(it.size, it.got);
      s.got += it.got; s.total += size; s.files++;
      if (it.done) s.filesDone++;
      if (it.opening) { s.openGot += it.got; s.openTotal += size; }
    }
    return s;
  }

  /** A loader's promise that its share of the opening view is in the scene (not merely downloaded). */
  hold(p: Promise<unknown>, name: string): void {
    this.holds.push(p.catch(() => undefined).then(() => { this.marks[name] = Math.round(performance.now()); }));
  }

  /**
   * Wait until every hold made so far has settled, or `limit` ms, whichever is first: a slow line is made to wait
   * for a better first picture, but not locked out. `tick` runs about ten times a second meanwhile. True if all arrived.
   */
  async opening(limit: number, tick: () => void): Promise<boolean> {
    let done = false;
    void Promise.all(this.holds).then(() => { done = true; this.marks.opening = Math.round(performance.now()); });
    const t0 = performance.now();
    // One turn of the task queue first: holds that are already settled must not cost a tenth of a second.
    await new Promise((r) => setTimeout(r, 0));
    while (!done) {
      if (performance.now() - t0 > limit) return false;
      tick();
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  }
}

export const assets = new Assets();
