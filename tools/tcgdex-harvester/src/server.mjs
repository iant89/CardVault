#!/usr/bin/env node
/**
 * TCGdex Harvester: a local web app that downloads every card image and its
 * data from the TCGdex API, politely, with a live dashboard.
 *
 *   node tools/tcgdex-harvester/src/server.mjs [--port 4777] [--host 127.0.0.1] [--out ./tcgdex-data] [--api URL]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harvester } from './harvester.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '..', 'public');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? argv[++i];
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export async function startServer(opts = {}) {
  const port = Number(opts.port ?? 4777);
  const host = opts.host ?? '127.0.0.1';
  const harvester = new Harvester({ outDir: opts.out ?? path.resolve(HERE, '..', 'tcgdex-data'), apiBase: opts.api, assetHosts: opts.assetHosts, saveDelayMs: opts.saveDelayMs });
  await harvester.load();

  // ---- live feed: logs, new images and a version counter, pushed every 400ms
  const logs = [];
  const images = [];
  let logSeq = 0, imageSeq = 0, queueVersion = 0;
  harvester.on('log', (l) => {
    logs.push({ ...l, seq: ++logSeq });
    if (logs.length > 500) logs.shift();
    const line = `[${new Date(l.t).toLocaleTimeString()}] ${l.level.toUpperCase().padEnd(7)} ${l.msg}`;
    if (!opts.quiet) console.log(line);
  });
  harvester.on('image', (i) => {
    images.push({ ...i, seq: ++imageSeq });
    if (images.length > 60) images.shift();
  });
  harvester.on('item', () => queueVersion++);
  harvester.on('reset', () => queueVersion++);
  harvester.on('status', () => queueVersion++);

  /** @type {Set<{ res: import('node:http').ServerResponse, logSeq: number, imageSeq: number }>} */
  const clients = new Set();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const setProgress = () =>
    harvester.setsView().filter((s) => s.queued).map(({ id, total, done, failed, active, bytes, localLogo }) => ({ id, total, done, failed, active, bytes, localLogo }));
  const ticker = setInterval(() => {
    if (!clients.size) return;
    const stats = harvester.stats();
    const sets = setProgress();
    for (const c of clients) {
      send(c.res, 'tick', {
        stats,
        sets,
        queueVersion,
        logs: logs.filter((l) => l.seq > c.logSeq),
        images: images.filter((i) => i.seq > c.imageSeq),
      });
      c.logSeq = logSeq;
      c.imageSeq = imageSeq;
    }
  }, 400);
  ticker.unref?.();

  // ---- request guards: this app controls downloads, so only this machine's browser may drive it
  // filled in once the port is known (port 0 = any free port)
  const allowedHosts = new Set();
  const hostOk = (req) => allowedHosts.has(String(req.headers.host ?? '').toLowerCase());
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true; // non-browser clients (curl)
    try {
      return allowedHosts.has(new URL(o).host.toLowerCase());
    } catch {
      return false;
    }
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  async function serveFile(res, file, cache = 'no-cache') {
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': s.size,
        'cache-control': cache,
        'x-content-type-options': 'nosniff',
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  }

  const actions = {
    'POST /api/discover': async () => ({ catalog: await harvester.discover() }),
    'POST /api/select': async (b) => (harvester.select(Array.isArray(b.ids) ? b.ids.map(String) : [], b.selected !== false), { ok: true }),
    'POST /api/plan': async () => ({ added: harvester.plan() }),
    'POST /api/start': async (b) => {
      if (b.plan) harvester.plan();
      harvester.start();
      return { ok: true };
    },
    'POST /api/pause': async () => (harvester.pause(), { ok: true }),
    'POST /api/resume': async () => (harvester.resume(), { ok: true }),
    'POST /api/clear': async () => (harvester.clearPending(), { ok: true }),
    'POST /api/settings': async (b) => ({ settings: harvester.setSettings(b ?? {}) }),
    'POST /api/retry-failed': async () => ({ retried: harvester.retryFailed() }),
    'POST /api/index': async () => (await harvester.writeIndex(), { ok: true }),
  };

  const server = createServer(async (req, res) => {
    try {
      if (!hostOk(req)) {
        res.writeHead(421, { 'content-type': 'text/plain' });
        return res.end('This tool only answers on localhost.');
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const route = `${req.method} ${url.pathname}`;

      if (req.method === 'POST') {
        if (!originOk(req)) return json(res, 403, { error: 'cross-origin request refused' });
        const body = await readBody(req);
        const item = /^\/api\/queue\/([^/]+)\/(retry|skip|prioritize)$/.exec(url.pathname);
        if (item) {
          const id = decodeURIComponent(item[1]);
          const ok = item[2] === 'retry' ? harvester.retry(id) : item[2] === 'skip' ? harvester.skip(id) : harvester.prioritize(id);
          return json(res, ok ? 200 : 409, { ok });
        }
        const set = /^\/api\/sets\/([^/]+)\/prioritize$/.exec(url.pathname);
        if (set) return json(res, 200, { moved: harvester.prioritizeSet(decodeURIComponent(set[1])) });
        const fn = actions[route];
        if (!fn) return json(res, 404, { error: 'unknown action' });
        return json(res, 200, await fn(body));
      }

      if (route === 'GET /events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('retry: 2000\n\n');
        const c = { res, logSeq, imageSeq };
        send(res, 'hello', { stats: harvester.stats(), sets: harvester.setsView(), catalog: { series: harvester.catalog.series, discoveredAt: harvester.catalog.discoveredAt, lang: harvester.catalog.lang }, logs: logs.slice(-150), images: images.slice(-24), queueVersion, out: harvester.store.root, api: harvester.apiBase });
        clients.add(c);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(c);
        });
        return;
      }
      if (route === 'GET /api/state') return json(res, 200, { stats: harvester.stats(), sets: harvester.setsView() });
      if (route === 'GET /api/sets') return json(res, 200, { sets: harvester.setsView() });
      if (route === 'GET /api/queue') {
        const p = Object.fromEntries(url.searchParams);
        return json(res, 200, harvester.queueView({ ...p, offset: Number(p.offset ?? 0) || 0, limit: Math.min(500, Number(p.limit ?? 100) || 100) }));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        const file = harvester.store.resolvePublic(decodeURIComponent(url.pathname.slice('/files/'.length)));
        if (!file) return json(res, 404, { error: 'not found' });
        return serveFile(res, file, 'max-age=3600');
      }
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.resolve(PUBLIC, rel);
        if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: 'not found' });
        return serveFile(res, file);
      }
      json(res, 405, { error: 'method not allowed' });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const realPort = server.address().port;
  for (const h of ['localhost', '127.0.0.1', '[::1]', ...(opts.allowHost ? [opts.allowHost] : [])]) allowedHosts.add(`${h}:${realPort}`.toLowerCase());
  const address = `http://${host === '0.0.0.0' ? 'localhost' : host}:${realPort}`;

  const close = async () => {
    clearInterval(ticker);
    for (const c of clients) c.res.end();
    await harvester.close();
    await new Promise((r) => server.close(r));
  };
  return { server, harvester, address, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2));
  const app = await startServer({
    port: a.port ?? process.env.PORT ?? 4777,
    host: a.host ?? process.env.HOST ?? '127.0.0.1',
    out: a.out ?? process.env.OUT_DIR,
    api: a.api ?? process.env.TCGDEX_API,
    assetHosts: a['asset-host'] ? [a['asset-host']] : undefined,
    allowHost: a['allow-host'],
  });
  console.log(`\n  TCGdex Harvester  →  ${app.address}\n  Saving to          →  ${app.harvester.store.root}\n`);
  let closing = false;
  const stop = async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('\nSaving the queue…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
