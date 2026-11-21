import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Load the nearest .env (cwd or up to 3 parents) without overriding real env vars. */
export function loadDotEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const f = path.join(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
      }
      // resolve relative STORAGE_DIR against the .env location
      if (process.env.STORAGE_DIR && !path.isAbsolute(process.env.STORAGE_DIR)) process.env.STORAGE_DIR = path.resolve(dir, process.env.STORAGE_DIR);
      return;
    }
    dir = path.dirname(dir);
  }
}
