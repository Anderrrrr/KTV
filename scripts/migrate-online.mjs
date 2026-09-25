// Applies db/migrations/*.sql to the online Postgres database, in file-name order,
// skipping ones already applied (tracked in the schema_migrations table).
//
// Usage: KTV_DATABASE_URL=postgres://... node scripts/migrate-online.mjs
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const connectionString = process.env.KTV_DATABASE_URL;
if (!connectionString) {
  console.error('Set KTV_DATABASE_URL to the online database connection string.');
  process.exit(1);
}
const dir = path.join(import.meta.dirname, '..', 'db', 'migrations');
const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(row => row.name));
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
    const name = file.replace(/\.sql$/, '');
    if (applied.has(name)) continue;
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      await client.query('COMMIT');
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`${name}: ${error.message}`);
    }
  }
  console.log('database is up to date');
} finally {
  await client.end();
}
