import { loadDotEnv } from './dotenv.js';
loadDotEnv();
const { createContext } = await import('./bootstrap.js');
const { buildApp } = await import('./app.js');
const { runMigrations, seedCatalog } = await import('@cardvault/database');
const { purgeExpiredSessions } = await import('./auth/sessions.js');

const ctx = await createContext();
if (process.env.AUTO_MIGRATE !== 'false') {
  await runMigrations(ctx.config.DATABASE_URL);
  await seedCatalog(ctx.db, { demo: process.env.SEED_DEMO === 'true' });
}
const app = await buildApp(ctx);
await app.listen({ port: ctx.config.API_PORT, host: ctx.config.API_HOST });
const sweep = setInterval(() => void purgeExpiredSessions(ctx).catch(() => undefined), 3600_000);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    clearInterval(sweep);
    await app.close();
    await ctx.close();
    process.exit(0);
  });
}
