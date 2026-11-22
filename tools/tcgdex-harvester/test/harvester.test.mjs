import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { HostLimiter } from '../src/limiter.mjs';
import { parseRetryAfter, imageKind } from '../src/http.mjs';
import { Store, segment } from '../src/store.mjs';
import { Harvester } from '../src/harvester.mjs';
import { startServer } from '../src/server.mjs';
import { startMock, cardPng } from './mock-tcgdex.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'harvester-'));
const until = async (fn, ms = 60_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const walk = async (dir) => {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
};

// ------------------------------------------------------------------ units

test('token bucket paces requests to the rate', () => {
  let t = 0;
  const l = new HostLimiter('h', { rate: 2, burst: 2, now: () => t });
  // burst of 2, then one every 500ms
  assert.equal(l.waitTime(), 0);
  l.tokens -= 1;
  l.tokens -= 1;
  assert.equal(l.waitTime(), 500);
  t += 500;
  assert.equal(l.waitTime(), 0);
});

test('429 halves the rate and blocks the host; successes recover it', () => {
  let t = 0;
  const l = new HostLimiter('h', { rate: 4, now: () => t });
  l.throttled(3000);
  assert.equal(l.rate, 2);
  assert.equal(l.waitTime(), 3000);
  t += 3000;
  for (let i = 0; i < 200; i++) l.success();
  assert.equal(l.rate, 4);
  assert.equal(l.snapshot().throttled, false);
});

test('Retry-After: seconds, dates and a cap', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('9999'), 120_000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 120_000, 5_000), 5_000);
  assert.equal(parseRetryAfter(undefined), undefined);
});

test('path segments are safe and stay inside the output folder', () => {
  assert.equal(segment('sv03.5'), 'sv03.5');
  assert.ok(!segment('../../etc').includes('/'));
  assert.equal(segment('..'), '_');
  assert.equal(segment(''), '_');
  const s = new Store('/tmp/out');
  assert.ok(s.file('en', '..', '..', 'x').startsWith('/tmp/out/'));
  assert.equal(s.resolvePublic('../../etc/passwd'), '/tmp/out/etc/passwd');
  assert.equal(s.resolvePublic('.harvester/state.json'), null);
});

test('image signatures', () => {
  assert.equal(imageKind(cardPng(4, 4, 10)), 'png');
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(imageKind(Buffer.from('<html>')), null);
});

// ------------------------------------------------------------ integration

test('downloads everything, organized, within the server rate limit', { timeout: 120_000 }, async () => {
  const mock = await startMock({ latency: 10, limit: 8 });
  const out = await tmp();
  const h = new Harvester({ outDir: out, apiBase: mock.api, settings: { rate: 6, concurrency: 4 }, saveDelayMs: 50 });
  try {
    await h.discover();
    assert.equal(h.catalog.sets.length, 6);
    assert.equal(h.catalog.sets.find((s) => s.id === 'sv02').serie.id, 'sv');
    h.plan();
    h.start();
    await until(() => h.status === 'finished', 100_000, 'finish');

    const cards = [...mock.data.cards.values()];
    assert.equal(h.counts.failed, 0, JSON.stringify(h.queueView({ status: 'failed' }).items));
    // every card's data and image (one has no image, one image 404s)
    const files = (await walk(path.join(out, 'en'))).map((f) => path.relative(out, f).split(path.sep).join('/'));
    assert.ok(files.includes('en/sets/sv/sv01/cards/001.json'));
    assert.ok(files.includes('en/sets/sv/sv01/images/high/001.png'));
    assert.ok(files.includes('en/sets/sv/sv03.5/set.json'));
    assert.ok(files.includes('en/sets/swsh/swsh12pt5/logo.png'));
    assert.equal(files.filter((f) => /\/cards\/\d+\.json$/.test(f)).length, cards.length);
    assert.equal(files.filter((f) => /\/images\/high\/\d+\.png$/.test(f)).length, cards.length - 2);
    const skipped = h.queueView({ status: 'skipped' }).items.map((i) => i.error).sort();
    assert.deepEqual(skipped, ['TCGdex has no image for this card', 'not available (404)']);

    // the polite part: never faster than asked, so the strict mock never had to refuse
    assert.ok(mock.stats.maxPerSecond <= 8, `peak ${mock.stats.maxPerSecond}/s`);
    assert.equal(mock.stats.throttled, 0);

    // index files
    await until(async () => !!(await stat(path.join(out, 'en', 'index.json')).catch(() => null)), 5000, 'index');
    const index = JSON.parse(await readFile(path.join(out, 'en', 'cards.json'), 'utf8'));
    assert.equal(index.length, cards.length);
    assert.deepEqual(Object.keys(index[0]).sort(), ['data', 'id', 'image', 'localId', 'name', 'set']);
  } finally {
    await h.close();
    await mock.close();
  }
});

test('backs off when the server says 429, and still finishes', { timeout: 120_000 }, async () => {
  const mock = await startMock({ latency: 5, limit: 3 });
  const out = await tmp();
  const h = new Harvester({ outDir: out, apiBase: mock.api, settings: { rate: 8, concurrency: 4 }, saveDelayMs: 50 });
  try {
    await h.discover();
    h.select(h.catalog.sets.map((s) => s.id), false);
    h.select(['base1', 'swsh12pt5'], true);
    h.plan();
    h.start();
    await until(() => h.status === 'finished', 110_000, 'finish');
    assert.equal(h.counts.failed, 0);
    assert.ok(mock.stats.throttled > 0, 'the mock should have pushed back');
    const host = h.limiter.snapshot()[0];
    assert.ok(host.rate < 8 || host.sent > 0);
  } finally {
    await h.close();
    await mock.close();
  }
});

test('pause, restart and resume without downloading anything twice', { timeout: 120_000 }, async () => {
  const mock = await startMock({ latency: 30, limit: 50 });
  const out = await tmp();
  let h = new Harvester({ outDir: out, apiBase: mock.api, settings: { rate: 10, concurrency: 3 }, saveDelayMs: 20 });
  await h.discover();
  h.select(h.catalog.sets.map((s) => s.id), false);
  h.select(['sv02'], true);
  h.plan();
  h.start();
  await until(() => h.counts.done > 15, 30_000, 'some progress');
  h.pause();
  assert.equal(h.status, 'paused');
  await until(() => h.counts.active === 0, 5000, 'in-flight to settle');
  const doneBefore = h.counts.done;
  await h.close();

  // a new process: the queue comes back from disk
  h = new Harvester({ outDir: out, apiBase: mock.api, saveDelayMs: 20 });
  await h.load();
  assert.equal(h.status, 'paused');
  assert.ok(h.counts.done >= doneBefore);
  assert.ok(h.counts.pending > 0);
  h.resume();
  await until(() => h.status === 'finished', 60_000, 'finish');
  assert.equal(h.counts.failed, 0);
  await h.close();
  // each image was fetched once (an aborted in-flight request may be repeated once)
  for (const [p, n] of mock.stats.byPath) if (p.endsWith('high.png')) assert.ok(n <= 2, `${p} fetched ${n} times`);
  await mock.close();
});

test('queue actions: prioritize, skip, retry', { timeout: 60_000 }, async () => {
  const mock = await startMock({ latency: 5, limit: 100 });
  const out = await tmp();
  const h = new Harvester({ outDir: out, apiBase: mock.api, settings: { rate: 10, concurrency: 1 }, saveDelayMs: 20 });
  try {
    await h.discover();
    h.plan();
    const last = h.queueView({ kind: 'set' }).items.at(-1);
    assert.ok(h.prioritize(last.id));
    assert.equal(h.queueView({ kind: 'set' }).items[0].id, last.id);
    const second = h.queueView({ kind: 'set' }).items[1];
    assert.ok(h.skip(second.id));
    assert.equal(h.items.get(second.id).status, 'skipped');
    assert.ok(h.retry(second.id));
    assert.equal(h.items.get(second.id).status, 'pending');
  } finally {
    await h.close();
    await mock.close();
  }
});

test('web server: live feed, actions, and localhost-only guards', { timeout: 60_000 }, async () => {
  const mock = await startMock({ latency: 5, limit: 100 });
  const out = await tmp();
  const app = await startServer({ port: 0, out, api: mock.api, quiet: true, saveDelayMs: 20 });
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // other Host headers (DNS rebinding) are refused
    const status = await new Promise((resolve, reject) =>
      request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example' } }, (r) => (r.resume(), resolve(r.statusCode))).on('error', reject).end(),
    );
    assert.equal(status, 421);
    // cross-site POSTs are refused
    const xs = await fetch(`${base}/api/pause`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(xs.status, 403);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /TCGdex Harvester/);

    const d = await (await fetch(`${base}/api/discover`, { method: 'POST' })).json();
    assert.equal(d.catalog.sets.length, 6);

    // the live feed sends a hello, then ticks
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('event: tick')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /event: hello/);
    ctrl.abort();

    const st = await (await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rate: 10, concurrency: 4, rate_junk: 1 }) })).json();
    assert.equal(st.settings.rate, 10);
    const clamp = await (await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ rate: 999 }) })).json();
    assert.equal(clamp.settings.rate, 10, 'rate is capped at 10/s');
    await fetch(`${base}/api/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: true }) });
    await until(() => app.harvester.status === 'finished', 50_000, 'finish');
    const q = await (await fetch(`${base}/api/queue?status=done&limit=5`)).json();
    assert.equal(q.items.length, 5);
    const img = q.items.find((i) => i.kind === 'image') ?? (await (await fetch(`${base}/api/queue?kind=image&limit=1`)).json()).items[0];
    const file = await fetch(`${base}/files/${img.file}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    // the queue state file is never served
    assert.equal((await fetch(`${base}/files/.harvester/state.json`)).status, 404);
  } finally {
    await app.close();
    await mock.close();
  }
});
