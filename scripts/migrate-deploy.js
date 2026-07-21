/**
 * Apply supabase/migrations/*.sql theo thứ tự tên file.
 * - Bảng _schema_migrations ghi nhận file đã chạy → không chạy lại migration cũ.
 * - DB đã có schema (channels) nhưng chưa có lịch sử → baseline: đánh dấu toàn bộ
 *   file hiện có là đã apply, KHÔNG chạy lại SQL cũ.
 *
 * Usage: node scripts/migrate-deploy.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '../supabase/migrations');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnv(path.resolve(__dirname, '../.env'));

function deriveDirectUrl(databaseUrl) {
  try {
    const x = new URL(databaseUrl);
    if (x.port === '6543') x.port = '5432';
    x.searchParams.delete('pgbouncer');
    x.searchParams.delete('connection_limit');
    return x.toString();
  } catch {
    return databaseUrl;
  }
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getApplied(client) {
  const result = await client.query(
    'SELECT name FROM _schema_migrations ORDER BY name',
  );
  return new Set(result.rows.map((row) => row.name));
}

async function hasExistingSchema(client) {
  const result = await client.query(
    `SELECT to_regclass('public.channels') AS t`,
  );
  return Boolean(result.rows[0]?.t);
}

async function baselineExistingSchema(client, files, applied) {
  if (applied.size > 0) return;

  const exists = await hasExistingSchema(client);
  if (!exists) {
    console.log('DB trống — sẽ apply toàn bộ migration từ đầu.');
    return;
  }

  console.log(
    `DB đã có schema — baseline ${files.length} migration (không chạy lại SQL cũ).`,
  );
  for (const name of files) {
    await client.query(
      'INSERT INTO _schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
      [name],
    );
    console.log(`  marked applied: ${name}`);
  }
}

async function applyPending(client, files, applied) {
  const pending = files.filter((name) => !applied.has(name));
  if (pending.length === 0) {
    console.log('Không có migration mới.');
    return;
  }

  console.log(`Apply ${pending.length} migration mới...`);
  for (const name of pending) {
    const filePath = path.join(MIGRATIONS_DIR, name);
    const sql = fs.readFileSync(filePath, 'utf8');
    console.log(`→ ${name}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO _schema_migrations (name) VALUES ($1)', [
        name,
      ]);
      await client.query('COMMIT');
      console.log(`  ✅ ${name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${err.message}`);
    }
  }
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  const connectionString =
    process.env.DIRECT_URL || deriveDirectUrl(process.env.DATABASE_URL);
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
  });

  await client.connect();
  await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');

  try {
    const files = listMigrationFiles();
    if (files.length === 0) {
      console.log('Không có file migration.');
      return;
    }

    await ensureMigrationsTable(client);
    let applied = await getApplied(client);
    await baselineExistingSchema(client, files, applied);
    applied = await getApplied(client);
    await applyPending(client, files, applied);
    console.log('✅ migrate deploy xong.');
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
