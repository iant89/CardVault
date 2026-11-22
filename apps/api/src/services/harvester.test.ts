import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '@cardvault/config';
import { findHarvesterDir, HarvesterManager } from './harvester.js';

const free = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

describe('HarvesterManager', () => {
  it('finds the tool in the repository', () => {
    expect(findHarvesterDir()).toMatch(/tools[\\/]tcgdex-harvester$/);
    expect(findHarvesterDir('/nonexistent')).toBeNull();
  });

  it('starts the harvester, reports it, and stops it', { timeout: 30_000 }, async () => {
    const port = await free();
    const out = mkdtempSync(path.join(tmpdir(), 'harvester-api-'));
    const m = new HarvesterManager({ ...loadConfig({}), HARVESTER_PORT: port, HARVESTER_OUT_DIR: out });
    expect(await m.status()).toMatchObject({ available: true, running: false });
    const s = await m.start();
    expect(s).toMatchObject({ running: true, managed: true, state: 'idle' });
    // a second start while running is a no-op
    expect((await m.start()).running).toBe(true);
    expect(await m.stop()).toMatchObject({ running: false });
  });

  it('reports a port taken by another program instead of starting', async () => {
    const other = createServer((_req, res) => res.end('hello'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const port = (other.address() as { port: number }).port;
    const m = new HarvesterManager({ ...loadConfig({}), HARVESTER_PORT: port, HARVESTER_OUT_DIR: mkdtempSync(path.join(tmpdir(), 'h-')) });
    const s = await m.start();
    expect(s.running).toBe(false);
    expect(s.error).toMatch(/in use/);
    other.close();
  });
});
