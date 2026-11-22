import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@cardvault/config';

const SCRIPT = path.join('src', 'server.mjs');

export interface HarvesterStatus {
  /** the tool's files were found on this server */
  available: boolean;
  running: boolean;
  /** started by CardVault (so CardVault can stop it) */
  managed: boolean;
  /** the harvester's own state: idle, running, paused, finished… */
  state?: string;
  done?: number;
  total?: number;
  failed?: number;
  error?: string;
}

/** Find tools/tcgdex-harvester by walking up from this file (src/ or dist/ layouts). */
export function findHarvesterDir(configured?: string): string | null {
  if (configured) return existsSync(path.join(configured, SCRIPT)) ? path.resolve(configured) : null;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++) {
    const candidate = path.join(dir, 'tools', 'tcgdex-harvester');
    if (existsSync(path.join(candidate, SCRIPT))) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** GET a path on the harvester (localhost only), with a short timeout. */
function probe(port: number, p: string, timeoutMs = 1500): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body.length < 200_000 ? (body += c) : undefined));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts, stops and reports on the TCGdex Harvester (tools/tcgdex-harvester).
 * It runs as its own detached Node process bound to 127.0.0.1, so its
 * downloads carry on independently of API requests; CardVault reaches it
 * through the admin-only proxy in routes/dev.ts.
 */
export class HarvesterManager {
  readonly dir: string | null;
  readonly port: number;
  readonly outDir: string;
  private starting: Promise<HarvesterStatus> | null = null;

  constructor(private readonly config: AppConfig) {
    this.dir = findHarvesterDir(config.HARVESTER_DIR);
    this.port = config.HARVESTER_PORT;
    this.outDir = path.resolve(config.HARVESTER_OUT_DIR ?? path.join(config.STORAGE_DIR, 'tcgdex-data'));
  }

  private get pidFile() {
    return path.join(this.outDir, '.harvester', 'server.pid');
  }

  get logFile() {
    return path.join(this.outDir, '.harvester', 'server.log');
  }

  private async managedPid(): Promise<number | null> {
    const pid = Number((await readFile(this.pidFile, 'utf8').catch(() => '')).trim());
    if (!pid) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  }

  async status(): Promise<HarvesterStatus> {
    const available = !!this.dir;
    const res = await probe(this.port, '/api/state');
    if (!res) return { available, running: false, managed: false };
    try {
      const s = JSON.parse(res.body) as { stats?: { status: string; counts: { done: number; skipped: number; failed: number }; projectedTotal: number } };
      if (!s.stats?.status) throw new Error('not the harvester');
      return {
        available,
        running: true,
        managed: !!(await this.managedPid()),
        state: s.stats.status,
        done: s.stats.counts.done + s.stats.counts.skipped,
        total: s.stats.projectedTotal,
        failed: s.stats.counts.failed,
      };
    } catch {
      return { available, running: false, managed: false, error: `Port ${this.port} is in use by another program. Set HARVESTER_PORT to a free port.` };
    }
  }

  /** Start the harvester if it isn't running; resolves once it answers. */
  start(): Promise<HarvesterStatus> {
    this.starting ??= this.doStart().finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(): Promise<HarvesterStatus> {
    const now = await this.status();
    if (now.running || now.error) return now;
    if (!this.dir) throw new Error('The TCGdex Harvester files (tools/tcgdex-harvester) were not found on this server.');

    mkdirSync(path.dirname(this.logFile), { recursive: true });
    const log = openSync(this.logFile, 'a');
    // a minimal environment: the tool needs nothing of CardVault's secrets
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) if (process.env[k]) env[k] = process.env[k];
    const child = spawn(process.execPath, [path.join(this.dir, SCRIPT), '--port', String(this.port), '--host', '127.0.0.1', '--out', this.outDir, ...(this.config.HARVESTER_API ? ['--api', this.config.HARVESTER_API] : [])], {
      cwd: this.dir,
      env,
      detached: true,
      stdio: ['ignore', log, log],
    });
    closeSync(log);
    let exited: number | null = null;
    child.on('exit', (code) => (exited = code ?? -1));
    child.unref();
    if (child.pid) await writeFile(this.pidFile, String(child.pid));

    for (let i = 0; i < 50; i++) {
      await sleep(200);
      const s = await this.status();
      if (s.running) return s;
      if (exited !== null) break;
    }
    const tail = (await readFile(this.logFile, 'utf8').catch(() => '')).trim().split('\n').slice(-6).join('\n');
    throw new Error(`The harvester did not start${exited !== null ? ` (exit code ${exited})` : ''}.${tail ? `\n${tail}` : ''}`);
  }

  /** Stop a harvester CardVault started (it saves its queue first). */
  async stop(): Promise<HarvesterStatus> {
    const pid = await this.managedPid();
    if (!pid) {
      const s = await this.status();
      if (s.running) throw new Error('This harvester was started outside CardVault, so stop it where it was started (Ctrl+C).');
      return s;
    }
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if (!(await this.managedPid())) break;
    }
    await rm(this.pidFile, { force: true });
    return this.status();
  }
}
