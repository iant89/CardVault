import { loadEnv } from './env.js';
import { createDb } from './client.js';
import { seedCatalog } from './seed-lib.js';

loadEnv();
const demo = process.argv.includes('--demo');
const { db, sql } = createDb(process.env.DATABASE_URL ?? 'postgres://cardvault:cardvault@localhost:5432/cardvault', { max: 1 });
await seedCatalog(db, { demo });
await sql.end();
console.log(`✔ seeded games${demo ? ' + demo catalog' : ''}`);
