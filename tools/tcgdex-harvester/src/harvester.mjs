import { EventEmitter } from 'node:events';
import { Limiter, sleep } from './limiter.mjs';
import { FetchError, guardedFetch, imageKind } from './http.mjs';
import { Store, segment } from './store.mjs';

/** @typedef {'pending'|'active'|'done'|'failed'|'skipped'} Status */
/** @typedef {'set'|'card'|'image'|'asset'} Kind */
/**
 * @typedef {{ id: string, kind: Kind, label: string, setId: string, status: Status, attempts: number,
 *   url?: string, file?: string, error?: string, bytes?: number, cached?: boolean, notBefore?: number,
 *   updatedAt: number, seq: number, meta?: Record<string, unknown> }} Item
 */

export const DEFAULT_SETTINGS = {
  lang: 'en',
  /** requests per second, per host */
  rate: 2,
  /** downloads in flight at once */
  concurrency: 3,
  quality: 'high',
  format: 'png',
  cardData: true,
  images: true,
  setAssets: true,
  maxAttempts: 5,
  /** consecutive failures before auto-pausing */
  breaker: 10,
};

const LANGS = new Set(['en', 'fr', 'es', 'it', 'pt', 'de', 'ja', 'zh-tw', 'id', 'th', 'ko']);
const QUALITIES = new Set(['high', 'low']);
const FORMATS = new Set(['png', 'webp', 'jpg']);

export function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const s = { ...base };
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  if (input.lang !== undefined && LANGS.has(input.lang)) s.lang = input.lang;
  if (input.rate !== undefined) s.rate = num(input.rate, 0.2, 10, s.rate);
  if (input.concurrency !== undefined) s.concurrency = Math.round(num(input.concurrency, 1, 8, s.concurrency));
  if (input.quality !== undefined && QUALITIES.has(input.quality)) s.quality = input.quality;
  if (input.format !== undefined && FORMATS.has(input.format)) s.format = input.format;
  for (const k of ['cardData', 'images', 'setAssets']) if (input[k] !== undefined) s[k] = !!input[k];
  if (input.maxAttempts !== undefined) s.maxAttempts = Math.round(num(input.maxAttempts, 1, 10, s.maxAttempts));
  return s;
}

export class Harvester extends EventEmitter {
  /**
   * @param {{ outDir: string, apiBase?: string, settings?: object, now?: () => number, saveDelayMs?: number }} opts
   */
  constructor(opts) {
    super();
    this.store = new Store(opts.outDir);
    this.apiBase = (opts.apiBase ?? 'https://api.tcgdex.net/v2').replace(/\/+$/, '');
    this.allowedHosts = new Set([new URL(this.apiBase).host, ...(opts.assetHosts ?? ['assets.tcgdex.net'])]);
    this.now = opts.now ?? (() => Date.now());
    this.settings = sanitizeSettings(opts.settings ?? {});
    this.limiter = new Limiter(this.settings.rate, { burst: 2 });
    this.saveDelayMs = opts.saveDelayMs ?? 2000;

    /** @type {'idle'|'discovering'|'running'|'paused'|'finished'} */
    this.status = 'idle';
    this.pauseReason = '';
    this.catalog = { series: [], sets: [], discoveredAt: null };
    /** @type {Map<string, Item>} */
    this.items = new Map();
    this.urgent = [];
    this.normal = [];
    this.seq = 0;
    this.counts = { pending: 0, active: 0, done: 0, failed: 0, skipped: 0 };
    /** per-set progress: setId → { total, done, failed, bytes } */
    this.setStats = new Map();
    this.inflight = new Map();
    this.workers = 0;
    this.consecutiveFailures = 0;
    this.totals = { bytes: 0, requests: 0, cached: 0 };
    /** one sample per second for the live charts */
    this.samples = [];
    this.startedAt = null;
    this.activeMs = 0;
    this.saveTimer = null;
    this.sampler = setInterval(() => this.sample(), 1000);
    this.sampler.unref?.();
  }

  // ---------------------------------------------------------------- logging

  log(level, msg, extra) {
    this.emit('log', { t: this.now(), level, msg, ...(extra ? { extra } : {}) });
  }

  // ------------------------------------------------------------ persistence

  async load() {
    const s = await this.store.readJson(this.store.statePath());
    if (!s || s.version !== 1) return false;
    this.settings = sanitizeSettings(s.settings ?? {});
    this.limiter.setRate(this.settings.rate);
    this.catalog = s.catalog ?? this.catalog;
    this.totals = { ...this.totals, ...(s.totals ?? {}) };
    this.activeMs = s.activeMs ?? 0;
    for (const it of s.items ?? []) {
      if (it.status === 'active') it.status = 'pending';
      delete it.notBefore;
      this.addItem(it, { restore: true });
    }
    const pending = this.counts.pending;
    this.log('info', `Restored ${this.items.size.toLocaleString()} queue items (${pending.toLocaleString()} still to do).`);
    if (pending && s.status === 'running') {
      this.log('info', 'Resuming where the last run stopped.');
      this.start();
    } else if (pending) {
      this.status = 'paused';
      this.pauseReason = 'Restored from the last run. Press Resume to continue.';
    } else if (this.items.size) {
      this.status = 'finished';
    }
    return true;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((e) => this.log('error', `Could not save the queue: ${e.message}`));
    }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  async save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.store.writeJson(this.store.statePath(), {
      version: 1,
      savedAt: new Date(this.now()).toISOString(),
      status: this.status,
      settings: this.settings,
      catalog: this.catalog,
      totals: this.totals,
      activeMs: this.activeMs + (this.startedAt ? this.now() - this.startedAt : 0),
      items: [...this.items.values()].map(({ notBefore, ...it }) => it),
    });
  }

  // ------------------------------------------------------------------ queue

  setStat(setId) {
    let s = this.setStats.get(setId);
    if (!s) this.setStats.set(setId, (s = { total: 0, done: 0, failed: 0, bytes: 0, active: 0 }));
    return s;
  }

  addItem(partial, { restore = false, urgent = false } = {}) {
    if (this.items.has(partial.id)) return this.items.get(partial.id);
    /** @type {Item} */
    const it = { attempts: 0, status: 'pending', updatedAt: this.now(), ...partial, seq: restore && partial.seq ? partial.seq : ++this.seq };
    this.seq = Math.max(this.seq, it.seq);
    this.items.set(it.id, it);
    this.counts[it.status]++;
    const ss = this.setStat(it.setId);
    ss.total++;
    if (it.status === 'done' || it.status === 'skipped') ss.done++;
    if (it.status === 'failed') ss.failed++;
    ss.bytes += it.bytes ?? 0;
    if (it.status === 'pending') (urgent ? this.urgent : this.normal).push(it.id);
    if (!restore) {
      this.emit('item', it);
      // a set expanding into its cards: bring idle workers back
      if (it.status === 'pending' && this.status === 'running') queueMicrotask(() => this.fillWorkers());
    }
    return it;
  }

  /** Move an item to a new status, keeping every counter in step. */
  transition(it, status, patch = {}) {
    const ss = this.setStat(it.setId);
    const was = it.status;
    this.counts[was]--;
    if (was === 'done' || was === 'skipped') ss.done--;
    if (was === 'failed') ss.failed--;
    if (was === 'active') ss.active--;
    Object.assign(it, patch, { status, updatedAt: this.now() });
    this.counts[status]++;
    if (status === 'done' || status === 'skipped') ss.done++;
    if (status === 'failed') ss.failed++;
    if (status === 'active') ss.active++;
    this.emit('item', it);
    this.scheduleSave();
  }

  /** Next item that may run now, or null. */
  next() {
    const t = this.now();
    for (const q of [this.urgent, this.normal]) {
      for (let i = 0; i < q.length; i++) {
        const it = this.items.get(q[i]);
        if (!it || it.status !== 'pending') {
          q.splice(i--, 1); // stale entry
          continue;
        }
        if (it.notBefore && it.notBefore > t) continue; // waiting to retry
        q.splice(i, 1);
        return it;
      }
    }
    return null;
  }

  earliestRetry() {
    let min = Infinity;
    for (const q of [this.urgent, this.normal]) {
      for (const id of q) {
        const it = this.items.get(id);
        if (it?.status === 'pending') {
          if (!it.notBefore) return this.now();
          min = Math.min(min, it.notBefore);
        }
      }
    }
    return min;
  }

  // ------------------------------------------------------------- discovery

  url(path) {
    return `${this.apiBase}/${encodeURIComponent(this.settings.lang)}/${path}`;
  }

  async request(url, signal) {
    const host = new URL(url).host;
    const lim = this.limiter.for(host);
    await lim.acquire(signal);
    this.totals.requests++;
    try {
      const res = await guardedFetch(url, { allowedHosts: this.allowedHosts, signal });
      lim.success();
      return res;
    } catch (e) {
      if (e instanceof FetchError && e.throttle) {
        lim.throttled(e.retryAfterMs);
        this.log('warn', `${host} asked us to slow down (${e.message}${e.retryAfterMs ? `, wait ${Math.round(e.retryAfterMs / 1000)}s` : ''}). Rate is now ${lim.snapshot().rate}/s.`);
      } else lim.failure();
      throw e;
    }
  }

  async getJson(path, signal) {
    const res = await this.request(this.url(path), signal);
    try {
      return JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new FetchError('response was not JSON');
    }
  }

  /** Fetch the list of series and sets (what can be downloaded). */
  async discover() {
    if (this.status === 'discovering') return this.catalog;
    const prev = this.status;
    this.status = 'discovering';
    this.emit('status');
    this.log('info', `Discovering series and sets (${this.settings.lang})…`);
    try {
      const ctrl = new AbortController();
      const series = await this.getJson('series', ctrl.signal);
      const sets = await this.getJson('sets', ctrl.signal);
      if (!Array.isArray(series) || !Array.isArray(sets)) throw new Error('unexpected response');
      const base = [this.settings.lang];
      await this.store.writeJson(this.store.file(...base, 'series.json'), series);
      await this.store.writeJson(this.store.file(...base, 'sets.json'), sets);
      // series → sets mapping needs each series' detail; it's cheap (one request per series)
      const serieOf = new Map();
      for (const s of series) {
        try {
          const d = await this.getJson(`series/${encodeURIComponent(s.id)}`, ctrl.signal);
          for (const set of d.sets ?? []) serieOf.set(set.id, { id: s.id, name: s.name });
        } catch (e) {
          this.log('warn', `Series ${s.name}: ${e.message}`);
        }
      }
      const known = new Map(this.catalog.sets.map((s) => [s.id, s]));
      this.catalog = {
        lang: this.settings.lang,
        discoveredAt: new Date(this.now()).toISOString(),
        series: series.map((s) => ({ id: s.id, name: s.name, logo: s.logo ?? null })),
        sets: sets.map((s) => ({
          id: s.id,
          name: s.name,
          serie: serieOf.get(s.id) ?? { id: 'other', name: 'Other' },
          cards: s.cardCount?.total ?? s.cardCount?.official ?? null,
          logo: s.logo ?? null,
          symbol: s.symbol ?? null,
          selected: known.get(s.id)?.selected ?? true,
        })),
      };
      this.log('success', `Found ${series.length} series and ${sets.length} sets (${this.catalog.sets.reduce((a, s) => a + (s.cards ?? 0), 0).toLocaleString()} cards).`);
      this.scheduleSave();
      return this.catalog;
    } catch (e) {
      this.log('error', `Discovery failed: ${e.message}`);
      throw e;
    } finally {
      this.status = prev === 'discovering' ? 'idle' : prev;
      this.emit('status');
    }
  }

  select(ids, selected) {
    const want = new Set(ids);
    for (const s of this.catalog.sets) if (want.has(s.id)) s.selected = !!selected;
    this.scheduleSave();
  }

  /** Queue the selected sets (sets already queued are left alone). */
  plan() {
    let added = 0;
    for (const s of this.catalog.sets) {
      if (!s.selected) continue;
      const id = `set:${this.settings.lang}:${s.id}`;
      if (this.items.has(id)) continue;
      this.addItem({ id, kind: 'set', label: s.name, setId: s.id, meta: { serie: s.serie?.id } });
      added++;
    }
    this.log('info', added ? `Queued ${added} set${added === 1 ? '' : 's'}. Their cards are added as each set is read.` : 'Every selected set is already queued.');
    this.scheduleSave();
    return added;
  }

  // ---------------------------------------------------------------- running

  start() {
    if (this.status === 'running') return;
    if (!this.counts.pending && !this.counts.active) {
      this.log('info', 'Nothing to download: queue some sets first.');
      return;
    }
    this.status = 'running';
    this.pauseReason = '';
    this.consecutiveFailures = 0;
    this.startedAt = this.now();
    this.emit('status');
    this.log('info', `Running: ${this.settings.concurrency} at a time, at most ${this.settings.rate} requests/s per host.`);
    this.fillWorkers();
    this.scheduleSave();
  }

  fillWorkers() {
    while (this.status === 'running' && this.workers < this.settings.concurrency) {
      this.workers++;
      this.workerLoop()
        .catch((e) => this.log('error', `Worker crashed: ${e.stack ?? e}`))
        .finally(() => {
          this.workers--;
          this.maybeFinish();
        });
    }
  }

  async workerLoop() {
    while (this.status === 'running' && this.workers <= this.settings.concurrency) {
      const it = this.next();
      if (!it) {
        if (!this.counts.pending) return; // nothing left for this worker
        const wait = Math.min(1000, Math.max(50, this.earliestRetry() - this.now()));
        await sleep(wait);
        continue;
      }
      await this.run(it);
    }
  }

  pause(reason = '') {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.pauseReason = reason;
    if (this.startedAt) this.activeMs += this.now() - this.startedAt;
    this.startedAt = null;
    // stop what's in flight; those items go back to the front of the queue
    for (const ctrl of this.inflight.values()) ctrl.abort(new Error('paused'));
    this.emit('status');
    this.log(reason ? 'warn' : 'info', reason ? `Paused: ${reason}` : 'Paused.');
    this.save().catch(() => undefined);
  }

  resume() {
    if (this.status !== 'paused' && this.status !== 'finished' && this.status !== 'idle') return;
    this.start();
  }

  /** Stop and drop everything not yet downloaded (finished work is kept). */
  clearPending() {
    const wasRunning = this.status === 'running';
    if (wasRunning) this.pause();
    let n = 0;
    for (const it of [...this.items.values()]) {
      if (it.status === 'pending' || it.status === 'failed') {
        this.counts[it.status]--;
        const ss = this.setStat(it.setId);
        ss.total--;
        if (it.status === 'failed') ss.failed--;
        this.items.delete(it.id);
        n++;
      }
    }
    this.urgent = [];
    this.normal = [];
    this.status = this.items.size ? 'finished' : 'idle';
    this.pauseReason = '';
    this.emit('status');
    this.emit('reset');
    this.log('info', `Cleared ${n.toLocaleString()} queued items.`);
    this.scheduleSave();
  }

  setSettings(input) {
    const before = this.settings;
    this.settings = sanitizeSettings(input, before);
    if (this.settings.rate !== before.rate) this.limiter.setRate(this.settings.rate);
    if (this.settings.concurrency > before.concurrency) this.fillWorkers();
    const changed = Object.keys(this.settings).filter((k) => this.settings[k] !== before[k]);
    if (changed.length) this.log('info', `Settings: ${changed.map((k) => `${k} → ${this.settings[k]}`).join(', ')}`);
    this.scheduleSave();
    this.emit('status');
    return this.settings;
  }

  maybeFinish() {
    if (this.status !== 'running' || this.workers > 0) return;
    if (this.counts.pending || this.counts.active) {
      this.fillWorkers();
      return;
    }
    this.status = 'finished';
    if (this.startedAt) this.activeMs += this.now() - this.startedAt;
    this.startedAt = null;
    this.emit('status');
    const f = this.counts.failed;
    this.log(f ? 'warn' : 'success', `Finished: ${this.counts.done.toLocaleString()} done, ${this.counts.skipped.toLocaleString()} skipped, ${f.toLocaleString()} failed.`);
    this.writeIndex().catch((e) => this.log('error', `Index: ${e.message}`));
    this.save().catch(() => undefined);
  }

  // ------------------------------------------------------------ item actions

  retry(id) {
    const it = this.items.get(id);
    if (!it || (it.status !== 'failed' && it.status !== 'skipped')) return false;
    this.transition(it, 'pending', { attempts: 0, error: undefined, notBefore: undefined });
    this.urgent.push(it.id);
    if (this.status === 'running') this.fillWorkers();
    return true;
  }

  retryFailed() {
    let n = 0;
    for (const it of this.items.values()) if (it.status === 'failed' && this.retry(it.id)) n++;
    if (n) this.log('info', `Retrying ${n} failed item${n === 1 ? '' : 's'}.`);
    return n;
  }

  skip(id) {
    const it = this.items.get(id);
    if (!it || (it.status !== 'pending' && it.status !== 'failed')) return false;
    this.transition(it, 'skipped', { error: 'skipped by you' });
    this.maybeFinish();
    return true;
  }

  prioritize(id) {
    const it = this.items.get(id);
    if (!it || it.status !== 'pending') return false;
    this.normal = this.normal.filter((x) => x !== id);
    this.urgent = [id, ...this.urgent.filter((x) => x !== id)];
    it.notBefore = undefined;
    this.emit('item', it);
    return true;
  }

  prioritizeSet(setId) {
    const ids = [...this.items.values()].filter((it) => it.setId === setId && it.status === 'pending').sort((a, b) => a.seq - b.seq).map((it) => it.id);
    const set = new Set(ids);
    this.normal = this.normal.filter((x) => !set.has(x));
    this.urgent = [...ids, ...this.urgent.filter((x) => !set.has(x))];
    this.log('info', `Moved ${ids.length} items of ${setId} to the front.`);
    return ids.length;
  }

  // ----------------------------------------------------------------- jobs

  async run(it) {
    const ctrl = new AbortController();
    this.inflight.set(it.id, ctrl);
    this.transition(it, 'active', { attempts: it.attempts + 1 });
    try {
      const result = await this.execute(it, ctrl.signal);
      this.consecutiveFailures = 0;
      this.transition(it, result.skipped ? 'skipped' : 'done', {
        error: result.skipped || undefined,
        bytes: result.bytes ?? 0,
        file: result.file,
        cached: result.cached ?? false,
        notBefore: undefined,
      });
      if (result.bytes && !result.cached) {
        this.totals.bytes += result.bytes;
        this.setStat(it.setId).bytes += result.bytes;
      }
      if (result.cached) this.totals.cached++;
      if (it.kind === 'image' && result.file && !result.cached) this.emit('image', { id: it.id, label: it.label, setId: it.setId, file: result.file });
    } catch (e) {
      if (ctrl.signal.aborted) {
        // paused or cleared mid-download: back to the front of the queue, not a failure
        if (this.items.has(it.id)) {
          this.transition(it, 'pending', { attempts: Math.max(0, it.attempts - 1) });
          this.urgent.unshift(it.id);
        }
        return;
      }
      this.fail(it, e);
    } finally {
      this.inflight.delete(it.id);
    }
  }

  fail(it, e) {
    const err = e instanceof FetchError ? e : new FetchError(e.message ?? String(e));
    // a missing image is a fact about the card, not a failure
    if (err.status === 404 && (it.kind === 'image' || it.kind === 'asset')) {
      this.transition(it, 'skipped', { error: 'not available (404)' });
      return;
    }
    const throttle = err.throttle;
    const attempts = throttle ? it.attempts - 1 : it.attempts; // push-back doesn't use up attempts
    if (err.retryable && attempts < this.settings.maxAttempts) {
      const backoff = throttle ? (err.retryAfterMs ?? 5000) : Math.min(60_000, 1000 * 2 ** attempts) * (0.75 + Math.random() * 0.5);
      this.transition(it, 'pending', { attempts, error: `${err.message}, retrying in ${Math.round(backoff / 1000)}s`, notBefore: this.now() + backoff });
      this.normal.push(it.id);
    } else {
      this.transition(it, 'failed', { error: err.message });
      this.log('error', `${it.label}: ${err.message}`);
    }
    if (!throttle) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.settings.breaker) {
        this.pause(`${this.consecutiveFailures} failures in a row. Check the connection, or lower the rate, then resume.`);
      }
    }
  }

  async execute(it, signal) {
    switch (it.kind) {
      case 'set':
        return this.runSet(it, signal);
      case 'card':
        return this.runCard(it, signal);
      case 'image':
      case 'asset':
        return this.runImage(it, signal);
      default:
        throw new Error(`unknown job ${it.kind}`);
    }
  }

  dirFor(it) {
    const lang = it.meta?.lang ?? this.settings.lang;
    return this.store.setDir(lang, it.meta?.serie, it.setId);
  }

  async runSet(it, signal) {
    const lang = this.settings.lang;
    const d = await this.getJson(`sets/${encodeURIComponent(it.setId)}`, signal);
    const serie = d.serie?.id ?? it.meta?.serie ?? 'unknown';
    it.meta = { ...it.meta, serie, lang };
    const dir = this.store.setDir(lang, serie, it.setId);
    const file = this.store.file(...dir, 'set.json');
    const body = JSON.stringify(d, null, 2) + '\n';
    await this.store.write(file, body);
    const s = this.settings;
    const meta = { serie, lang };
    if (s.setAssets) {
      for (const kind of ['logo', 'symbol']) {
        if (d[kind]) this.addItem({ id: `asset:${lang}:${it.setId}:${kind}`, kind: 'asset', label: `${d.name} ${kind}`, setId: it.setId, url: `${d[kind]}.${s.format === 'jpg' ? 'jpg' : s.format}`, meta: { ...meta, name: kind } });
      }
    }
    for (const c of d.cards ?? []) {
      const label = `${c.name} · ${d.name} ${c.localId}`;
      if (s.cardData) this.addItem({ id: `card:${lang}:${c.id}`, kind: 'card', label, setId: it.setId, meta: { ...meta, cardId: c.id, localId: c.localId } });
      if (s.images) {
        if (c.image) {
          this.addItem({ id: `image:${lang}:${c.id}:${s.quality}`, kind: 'image', label, setId: it.setId, url: `${c.image}/${s.quality}.${s.format}`, meta: { ...meta, cardId: c.id, localId: c.localId, quality: s.quality } });
        } else {
          this.addItem({ id: `image:${lang}:${c.id}:${s.quality}`, kind: 'image', label, setId: it.setId, status: 'skipped', error: 'TCGdex has no image for this card', meta: { ...meta, cardId: c.id, localId: c.localId } });
        }
      }
    }
    const cat = this.catalog.sets.find((x) => x.id === it.setId);
    if (cat) cat.cards = d.cards?.length ?? cat.cards;
    this.log('info', `${d.name}: ${d.cards?.length ?? 0} cards queued.`);
    return { bytes: Buffer.byteLength(body), file: this.store.rel(file) };
  }

  async runCard(it, signal) {
    const file = this.store.file(...this.dirFor(it), 'cards', `${it.meta.localId}.json`);
    if (await this.store.exists(file)) return { cached: true, file: this.store.rel(file) };
    const d = await this.getJson(`cards/${encodeURIComponent(it.meta.cardId)}`, signal);
    const body = JSON.stringify(d, null, 2) + '\n';
    await this.store.write(file, body);
    return { bytes: Buffer.byteLength(body), file: this.store.rel(file) };
  }

  async runImage(it, signal) {
    const fmt = this.settings.format;
    const file =
      it.kind === 'asset'
        ? this.store.file(...this.dirFor(it), `${it.meta.name}.${fmt}`)
        : this.store.file(...this.dirFor(it), 'images', it.meta.quality ?? this.settings.quality, `${it.meta.localId}.${fmt}`);
    if (await this.store.exists(file)) return { cached: true, file: this.store.rel(file) };
    const res = await this.request(it.url, signal);
    const kind = imageKind(res.body);
    if (!kind) throw new FetchError('response was not an image');
    // trust the bytes: store with the real extension if the server sent another format
    const real = kind === fmt ? file : file.replace(/\.[a-z]+$/, `.${kind}`);
    await this.store.write(real, res.body);
    return { bytes: res.body.length, file: this.store.rel(real) };
  }

  // ----------------------------------------------------------------- index

  /** Flat card index + summary for the downloaded data. */
  async writeIndex() {
    const lang = this.settings.lang;
    const cards = new Map();
    for (const it of this.items.values()) {
      if ((it.kind !== 'card' && it.kind !== 'image') || !it.meta?.cardId) continue;
      const c = cards.get(it.meta.cardId) ?? { id: it.meta.cardId, set: it.setId, localId: it.meta.localId, name: it.label.split(' · ')[0] };
      if (it.status === 'done' || (it.status === 'skipped' && it.file)) {
        if (it.kind === 'card') c.data = it.file;
        else c.image = it.file;
      }
      cards.set(c.id, c);
    }
    const list = [...cards.values()].sort((a, b) => a.set.localeCompare(b.set) || String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }));
    await this.store.writeJson(this.store.file(lang, 'cards.json'), list);
    const sets = this.catalog.sets
      .filter((s) => this.setStats.get(s.id)?.total)
      .map((s) => {
        const st = this.setStats.get(s.id);
        return { id: s.id, name: s.name, serie: s.serie, cards: s.cards, items: st.total, complete: st.done, failed: st.failed, bytes: st.bytes, folder: `${lang}/sets/${segment(s.serie?.id ?? 'unknown')}/${segment(s.id)}` };
      });
    await this.store.writeJson(this.store.file(lang, 'index.json'), {
      generatedAt: new Date(this.now()).toISOString(),
      source: this.apiBase,
      lang,
      quality: this.settings.quality,
      format: this.settings.format,
      totals: { cards: list.length, withImage: list.filter((c) => c.image).length, withData: list.filter((c) => c.data).length, bytes: this.totals.bytes },
      sets,
    });
    this.log('success', `Wrote ${lang}/cards.json (${list.length.toLocaleString()} cards) and ${lang}/index.json.`);
  }

  // ----------------------------------------------------------------- stats

  sample() {
    const t = this.now();
    this.samples.push({ t, done: this.counts.done + this.counts.skipped, bytes: this.totals.bytes, requests: this.totals.requests });
    if (this.samples.length > 300) this.samples.shift();
  }

  /** Rates over the last `sec` seconds. */
  rates(sec = 15) {
    const s = this.samples;
    if (s.length < 2) return { itemsPerSec: 0, bytesPerSec: 0, reqPerSec: 0 };
    const a = s[Math.max(0, s.length - 1 - sec)], b = s[s.length - 1];
    const dt = Math.max(1, (b.t - a.t) / 1000);
    return { itemsPerSec: (b.done - a.done) / dt, bytesPerSec: (b.bytes - a.bytes) / dt, reqPerSec: (b.requests - a.requests) / dt };
  }

  /** Items still to come: queued ones, plus the cards of sets not yet read. */
  remaining() {
    const per = (this.settings.cardData ? 1 : 0) + (this.settings.images ? 1 : 0);
    let n = this.counts.pending + this.counts.active;
    for (const it of this.items.values()) {
      if (it.kind === 'set' && (it.status === 'pending' || it.status === 'active')) {
        n += (this.catalog.sets.find((s) => s.id === it.setId)?.cards ?? 0) * per + (this.settings.setAssets ? 2 : 0);
      }
    }
    return n;
  }

  stats() {
    const r = this.rates();
    const remaining = this.remaining();
    const byKind = {};
    for (const it of this.items.values()) {
      const k = (byKind[it.kind] ??= { total: 0, done: 0 });
      k.total++;
      if (it.status === 'done' || it.status === 'skipped') k.done++;
    }
    return {
      status: this.status,
      pauseReason: this.pauseReason,
      counts: { ...this.counts, total: this.items.size },
      projectedTotal: this.counts.done + this.counts.skipped + this.counts.failed + remaining,
      byKind,
      totals: this.totals,
      rates: r,
      etaSec: this.status === 'running' && r.itemsPerSec > 0 ? Math.round(remaining / r.itemsPerSec) : null,
      elapsedMs: this.activeMs + (this.startedAt ? this.now() - this.startedAt : 0),
      hosts: this.limiter.snapshot(),
      workers: this.workers,
      settings: this.settings,
      consecutiveFailures: this.consecutiveFailures,
      chart: this.samples.slice(-120).map((x, i, arr) => {
        const p = arr[i - 1] ?? x;
        const dt = Math.max(1, (x.t - p.t) / 1000);
        return { t: x.t, items: (x.done - p.done) / dt, bytes: (x.bytes - p.bytes) / dt };
      }),
    };
  }

  setsView() {
    return this.catalog.sets.map((s) => {
      const st = this.setStats.get(s.id);
      const assetDir = `${this.settings.lang}/sets/${segment(s.serie?.id ?? 'unknown')}/${segment(s.id)}`;
      const logo = this.items.get(`asset:${this.settings.lang}:${s.id}:logo`);
      return {
        ...s,
        queued: !!st?.total,
        total: st?.total ?? 0,
        done: st?.done ?? 0,
        failed: st?.failed ?? 0,
        active: st?.active ?? 0,
        bytes: st?.bytes ?? 0,
        localLogo: logo?.status === 'done' && logo.file ? logo.file : null,
        folder: assetDir,
      };
    });
  }

  /** A page of the queue, in the order it will run (active first). */
  queueView({ status = 'all', kind = 'all', q = '', setId = '', offset = 0, limit = 100 } = {}) {
    const needle = q.trim().toLowerCase();
    const match = (it) =>
      (status === 'all' || it.status === status) &&
      (kind === 'all' || it.kind === kind) &&
      (!setId || it.setId === setId) &&
      (!needle || it.label.toLowerCase().includes(needle) || it.id.toLowerCase().includes(needle));
    const ordered = [];
    const seen = new Set();
    const push = (it) => {
      if (it && !seen.has(it.id) && match(it)) {
        seen.add(it.id);
        ordered.push(it);
      }
    };
    for (const it of this.items.values()) if (it.status === 'active') push(it);
    for (const id of this.urgent) push(this.items.get(id));
    for (const id of this.normal) push(this.items.get(id));
    const rest = [...this.items.values()].filter((it) => !seen.has(it.id) && match(it));
    // then failures (to act on), then finished work, newest first
    rest.sort((a, b) => (b.status === 'failed') - (a.status === 'failed') || b.updatedAt - a.updatedAt);
    for (const it of rest) push(it);
    return {
      total: ordered.length,
      offset,
      items: ordered.slice(offset, offset + limit).map((it) => this.publicItem(it)),
    };
  }

  publicItem(it) {
    return {
      id: it.id,
      kind: it.kind,
      label: it.label,
      setId: it.setId,
      status: it.status,
      attempts: it.attempts,
      error: it.error,
      bytes: it.bytes,
      file: it.file,
      cached: it.cached,
      waitMs: it.notBefore ? Math.max(0, it.notBefore - this.now()) : 0,
      urgent: this.urgent.includes(it.id),
    };
  }

  async close() {
    clearInterval(this.sampler);
    if (this.status === 'running') {
      const keep = 'running';
      for (const ctrl of this.inflight.values()) ctrl.abort(new Error('shutdown'));
      this.status = keep; // saved as running so the next start resumes
    }
    await this.save();
  }
}
