import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Output layout (everything under one folder):
 *
 *   <out>/<lang>/series.json              every series (Scarlet & Violet, Sword & Shield…)
 *   <out>/<lang>/sets.json                every set
 *   <out>/<lang>/index.json               summary: sets, card counts, files
 *   <out>/<lang>/cards.json               flat index of every downloaded card
 *   <out>/<lang>/sets/<serie>/<set>/set.json
 *   <out>/<lang>/sets/<serie>/<set>/logo.png, symbol.png
 *   <out>/<lang>/sets/<serie>/<set>/cards/<localId>.json
 *   <out>/<lang>/sets/<serie>/<set>/images/<quality>/<localId>.<ext>
 *   <out>/.harvester/state.json           the queue, so a restart resumes
 */

/** A safe single path segment from an API id ("sv03.5", "TG01", "swsh12pt5"). */
export function segment(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return s && s !== '.' && s !== '..' ? s.slice(0, 80) : '_';
}

export class Store {
  constructor(outDir) {
    this.root = path.resolve(outDir);
  }

  /** Absolute path for segments under the output root (always inside it). */
  file(...parts) {
    const p = path.resolve(this.root, ...parts.map(segment));
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error('path escapes output folder');
    return p;
  }

  setDir(lang, serie, set) {
    return [lang, 'sets', serie || 'unknown', set];
  }

  /** Map a relative URL path (from the UI) to a file inside the output folder, or null. */
  resolvePublic(rel) {
    const p = path.resolve(this.root, '.' + path.posix.normalize('/' + rel));
    if (!p.startsWith(this.root + path.sep)) return null;
    if (p.includes(`${path.sep}.harvester${path.sep}`)) return null;
    return p;
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async exists(abs) {
    try {
      const s = await stat(abs);
      return s.isFile() && s.size > 0;
    } catch {
      return false;
    }
  }

  /** Write atomically: a crash never leaves a half-written file behind. */
  async write(abs, data) {
    await mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now().toString(36)}.part`;
    await writeFile(tmp, data);
    await rename(tmp, abs);
  }

  writeJson(abs, value) {
    return this.write(abs, JSON.stringify(value, null, 2) + '\n');
  }

  async readJson(abs, fallback = null) {
    try {
      return JSON.parse(await readFile(abs, 'utf8'));
    } catch {
      return fallback;
    }
  }

  statePath() {
    return path.join(this.root, '.harvester', 'state.json');
  }
}
