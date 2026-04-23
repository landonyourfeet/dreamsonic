// db.js — Postgres connection pool

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('[dreamsonic] DATABASE_URL not set. Attach a Postgres database on Railway.');
  }

  pool = new Pool({
    connectionString: url,
    ssl: url.includes('railway') || url.includes('rlwy') ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('[db] unexpected pool error', err);
  });

  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTx };
