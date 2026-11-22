/**
 * A stand-in for the TCGdex API and asset host, for tests and offline demos.
 * Same URL shapes and JSON shapes as api.tcgdex.net / assets.tcgdex.net,
 * generated card images, and a strict rate limit that answers 429 with
 * Retry-After when a client goes too fast.
 *
 *   node test/mock-tcgdex.mjs [--port 4778] [--latency 120] [--limit 6] [--errors 0.03]
 */
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- tiny PNG

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A card-shaped PNG: coloured frame, lighter art box, a darker text band. */
export function cardPng(w, h, hue, seed = 1) {
  const hsl = (H, S, L) => {
    const a = S * Math.min(L, 1 - L);
    const f = (n) => {
      const k = (n + H / 30) % 12;
      return Math.round(255 * (L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  const frame = hsl(hue, 0.65, 0.55), art = hsl((hue + 40) % 360, 0.5, 0.75), band = hsl(hue, 0.3, 0.88), ink = [40, 40, 48];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const bx = x / w, by = y / h;
      let c = frame;
      if (bx > 0.06 && bx < 0.94 && by > 0.11 && by < 0.5) {
        const wave = Math.sin(bx * 12 + seed) * Math.cos(by * 9 + seed * 0.7);
        c = art.map((v) => Math.max(0, Math.min(255, v + wave * 40)));
      } else if (bx > 0.05 && bx < 0.95 && by > 0.55 && by < 0.9) c = band;
      if (by > 0.04 && by < 0.08 && bx > 0.12 && bx < 0.12 + 0.05 * ((seed % 7) + 3)) c = ink;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ data

const NAMES = ['Bulbasaur', 'Charmander', 'Squirtle', 'Pikachu', 'Eevee', 'Snorlax', 'Fletchling', 'Gengar', 'Lucario', 'Mewtwo', 'Jigglypuff', 'Psyduck', 'Machop', 'Geodude', 'Magikarp', 'Gyarados', 'Dratini', 'Dragonite', 'Togepi', 'Marill', 'Sneasel', 'Larvitar', 'Ralts', 'Absol', 'Riolu', 'Zorua', 'Froakie', 'Rowlet', 'Grookey', 'Sprigatito'];

export function buildData(base) {
  const series = [
    { id: 'sv', name: 'Scarlet & Violet', sets: [['sv01', 'Scarlet & Violet', 18], ['sv02', 'Paldea Evolved', 22], ['sv03.5', '151', 14]] },
    { id: 'swsh', name: 'Sword & Shield', sets: [['swsh1', 'Sword & Shield', 16], ['swsh12pt5', 'Crown Zenith', 12]] },
    { id: 'base', name: 'Base', sets: [['base1', 'Base Set', 10]] },
  ];
  const sets = new Map();
  const cards = new Map();
  let hue = 0;
  for (const s of series) {
    for (const [id, name, n] of s.sets) {
      hue = (hue + 47) % 360;
      const list = [];
      for (let i = 1; i <= n; i++) {
        const localId = String(i).padStart(3, '0');
        const cid = `${id}-${localId}`;
        const cname = NAMES[(i * 7 + id.length) % NAMES.length];
        // a couple of cards without images, like the real API has
        const noImage = i === n && id === 'swsh1';
        const brief = { id: cid, localId, name: cname, ...(noImage ? {} : { image: `${base}/assets/en/${s.id}/${id}/${localId}` }) };
        list.push(brief);
        cards.set(cid, { ...brief, category: 'Pokemon', hp: 60 + (i % 8) * 10, rarity: i % 9 === 0 ? 'Rare' : 'Common', set: { id, name }, hue, seed: i });
      }
      sets.set(id, {
        id,
        name,
        logo: `${base}/assets/en/${s.id}/${id}/logo`,
        symbol: `${base}/assets/univ/${s.id}/${id}/symbol`,
        cardCount: { total: n, official: n },
        serie: { id: s.id, name: s.name },
        releaseDate: '2023-03-31',
        cards: list,
        hue,
      });
    }
  }
  return { series, sets, cards };
}

// ---------------------------------------------------------------- server

export async function startMock(opts = {}) {
  const latency = opts.latency ?? 60;
  const limit = opts.limit ?? 8; // requests per second the "server" tolerates
  const errorRate = opts.errors ?? 0;
  const stats = { requests: 0, throttled: 0, errors: 0, maxPerSecond: 0, byPath: new Map() };
  const window = [];
  let data;
  /** image ids that always 404 (missing on the CDN) */
  const missing = new Set(opts.missing ?? ['sv02-007']);

  const server = createServer(async (req, res) => {
    const now = Date.now();
    window.push(now);
    while (window.length && window[0] < now - 1000) window.shift();
    stats.maxPerSecond = Math.max(stats.maxPerSecond, window.length);
    stats.requests++;
    const url = new URL(req.url, 'http://x');
    stats.byPath.set(url.pathname, (stats.byPath.get(url.pathname) ?? 0) + 1);
    if (window.length > limit) {
      stats.throttled++;
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'text/plain' });
      return res.end('slow down');
    }
    await new Promise((r) => setTimeout(r, latency * (0.5 + Math.random())));
    if (errorRate && Math.random() < errorRate) {
      stats.errors++;
      res.writeHead(502);
      return res.end('bad gateway');
    }
    const sendJson = (v) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (p[0] === 'v2' && p[1] === 'en') {
      if (p[2] === 'series' && !p[3]) return sendJson(data.series.map((s) => ({ id: s.id, name: s.name })));
      if (p[2] === 'series' && p[3]) {
        const s = data.series.find((x) => x.id === p[3]);
        return s ? sendJson({ id: s.id, name: s.name, sets: s.sets.map(([id, name]) => ({ id, name })) }) : (res.writeHead(404), res.end());
      }
      if (p[2] === 'sets' && !p[3]) return sendJson([...data.sets.values()].map(({ id, name, logo, symbol, cardCount }) => ({ id, name, logo, symbol, cardCount })));
      if (p[2] === 'sets' && p[3]) {
        const s = data.sets.get(p[3]);
        if (!s) return res.writeHead(404), res.end();
        const { hue, ...pub } = s;
        return sendJson(pub);
      }
      if (p[2] === 'cards' && p[3]) {
        const c = data.cards.get(p[3]);
        if (!c) return res.writeHead(404), res.end();
        const { hue, seed, ...pub } = c;
        return sendJson(pub);
      }
    }
    if (p[0] === 'assets') {
      const last = p[p.length - 1];
      const m = /^(.+)\.(png|webp|jpg)$/.exec(last);
      if (!m) return res.writeHead(404), res.end();
      const setId = p[p.length - 2] === 'high.png' ? null : p[3];
      if (m[1] === 'logo' || m[1] === 'symbol') {
        const s = data.sets.get(setId);
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(cardPng(m[1] === 'logo' ? 120 : 40, 40, s?.hue ?? 200, 3));
      }
      // /assets/en/<serie>/<set>/<localId>/<quality>.<ext>
      const [set, localId] = [p[3], p[4]];
      const c = data.cards.get(`${set}-${localId}`);
      if (!c || missing.has(c.id)) return res.writeHead(404), res.end();
      const big = m[1] === 'high';
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(cardPng(big ? 245 : 120, big ? 342 : 168, c.hue, c.seed));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  data = buildData(base);
  return { base, api: `${base}/v2`, stats, data, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1]?.endsWith('mock-tcgdex.mjs')) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? Number(process.argv[i + 1]) : d;
  };
  const m = await startMock({ port: arg('port', 4778), latency: arg('latency', 120), limit: arg('limit', 6), errors: arg('errors', 0.03) });
  console.log(`mock TCGdex API at ${m.api}`);
}
