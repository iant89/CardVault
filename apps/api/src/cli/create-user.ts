/**
 * Administrator CLI — there is no public registration.
 *   pnpm user:create --bootstrap                       (uses ADMIN_USERNAME / ADMIN_PASSWORD)
 *   pnpm user:create <username> "<Display Name>" [--admin]   (prompts for password)
 */
import { createInterface } from 'node:readline/promises';
import { loadDotEnv } from '../dotenv.js';
loadDotEnv();
const { loadConfig } = await import('@cardvault/config');
const { createDb, eq, users, runMigrations, seedCatalog } = await import('@cardvault/database');
const { hashPassword, passwordProblems } = await import('../auth/password.js');

const cfg = loadConfig();
const args = process.argv.slice(2);
await runMigrations(cfg.DATABASE_URL);
const { db, sql } = createDb(cfg.DATABASE_URL, { max: 1 });
await seedCatalog(db);

let username: string;
let displayName: string;
let password: string | undefined;
let role: 'ADMIN' | 'USER' = args.includes('--admin') ? 'ADMIN' : 'USER';

if (args.includes('--bootstrap')) {
  username = cfg.ADMIN_USERNAME;
  displayName = process.env.ADMIN_DISPLAY_NAME ?? 'Administrator';
  password = cfg.ADMIN_PASSWORD;
  role = 'ADMIN';
  const [any] = await db.select({ id: users.id }).from(users).limit(1);
  if (any) {
    console.log('Users already exist; bootstrap skipped.');
    await sql.end();
    process.exit(0);
  }
} else {
  const pos = args.filter((a) => !a.startsWith('--'));
  if (!pos[0]) {
    console.error('usage: user:create <username> "<Display Name>" [--admin] | --bootstrap');
    process.exit(1);
  }
  username = pos[0];
  displayName = pos[1] ?? pos[0];
}
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question(`Password for ${username}: `);
  rl.close();
}
const problem = passwordProblems(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}
const uname = username.toLowerCase();
const [existing] = await db.select().from(users).where(eq(users.username, uname));
if (existing) {
  console.error(`User ${uname} already exists`);
  process.exit(1);
}
await db.insert(users).values({ username: uname, displayName, role, passwordHash: await hashPassword(password) });
console.log(`✔ created ${role} ${uname}`);
await sql.end();
