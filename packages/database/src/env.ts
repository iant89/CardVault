import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Tiny .env loader for CLI scripts (searches cwd and parents). */
export function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const f = path.join(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
      }
      return;
    }
    dir = path.dirname(dir);
  }
}
