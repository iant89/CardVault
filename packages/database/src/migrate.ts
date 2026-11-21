import { loadEnv } from './env.js';
import { runMigrations } from './migrate-lib.js';

loadEnv();
const url = process.env.DATABASE_URL ?? 'postgres://cardvault:cardvault@localhost:5432/cardvault';
await runMigrations(url);
console.log('✔ migrations applied');
