import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// bigint (int8) columns hold epoch ms and sequence numbers, both far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v))
// real (float4)
pg.types.setTypeParser(700, (v) => Number(v))

export type Db = pg.Pool
export type Tx = pg.PoolClient
export type Queryable = pg.Pool | pg.PoolClient

export function createPool(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 20, idleTimeoutMillis: 30_000 })
  pool.on('error', () => {
    /* idle client errors are retried on next checkout */
  })
  return pool
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Transaction for writes that assign server_seq. Writers are serialised with a transaction-level advisory
 * lock, so sequence values become visible in commit order and a pull cursor can never skip a row that
 * commits later with a smaller server_seq.
 */
export async function withSeqTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7340211)')
    return fn(tx)
  })
}

export async function nextSeq(tx: Queryable): Promise<number> {
  const r = await tx.query<{ s: number }>(`SELECT nextval('sync_seq') AS s`)
  return Number(r.rows[0].s)
}

function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR
  const here = dirname(fileURLToPath(import.meta.url))
  for (const c of [join(here, 'migrations'), join(here, '..', 'migrations')]) if (existsSync(c)) return c
  throw new Error('migrations directory not found')
}

export async function migrate(db: Db): Promise<string[]> {
  const dir = migrationsDir()
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const applied: string[] = []
  await withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7340212)')
    await tx.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    )
    const done = new Set((await tx.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version))
    for (const f of files) {
      if (done.has(f)) continue
      await tx.query(readFileSync(join(dir, f), 'utf8'))
      await tx.query('INSERT INTO schema_migrations(version) VALUES ($1)', [f])
      applied.push(f)
    }
  })
  return applied
}
