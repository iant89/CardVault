import type { HttpClient } from './http.js';

/** Minimal robots.txt support for generic web crawlers. Cached per origin. */
const cache = new Map<string, { rules: { allow: boolean; path: string }[]; at: number }>();

export function parseRobots(txt: string, agent: string): { allow: boolean; path: string }[] {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const [k, ...rest] = line.replace(/#.*/, '').split(':');
    if (!k || !rest.length) continue;
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (cur && (key === 'allow' || key === 'disallow')) {
      if (val) cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    }
  }
  const a = agent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  return (specific ?? groups.find((g) => g.agents.includes('*')))?.rules ?? [];
}

export function robotsAllows(rules: { allow: boolean; path: string }[], path: string): boolean {
  let best: { allow: boolean; path: string } | undefined;
  for (const r of rules) {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best ? best.allow : true;
}

export async function isAllowedByRobots(http: HttpClient, url: URL, agent: string): Promise<boolean> {
  const origin = url.origin;
  let entry = cache.get(origin);
  if (!entry || Date.now() - entry.at > 24 * 3600_000) {
    let rules: { allow: boolean; path: string }[] = [];
    try {
      const res = await http.request(`${origin}/robots.txt`, { retries: 1 });
      rules = parseRobots(res.text, agent);
    } catch (err) {
      const status = (err as { status?: number }).status;
      // 4xx => no robots => allowed; 5xx/network => be conservative
      if (!(status && status >= 400 && status < 500)) rules = [{ allow: false, path: '/' }];
    }
    entry = { rules, at: Date.now() };
    cache.set(origin, entry);
  }
  return robotsAllows(entry.rules, url.pathname + url.search);
}
