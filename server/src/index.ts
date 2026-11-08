import { buildApp } from './app'
import { loadConfig } from './config'
import { createPool, migrate } from './db'

async function main() {
  const config = loadConfig()
  if (config.DEV_AUTH) console.warn('WARNING: DEV_AUTH=1 — /api/auth/dev issues tokens without Google sign-in. Never use in production.')
  const db = createPool(config.DATABASE_URL)
  for (let attempt = 1; ; attempt++) {
    try {
      const applied = await migrate(db)
      if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`)
      break
    } catch (e) {
      if (attempt >= 30) throw e
      console.log(`database not ready (${(e as Error).message}); retrying`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  const { app } = await buildApp({ config, db })
  await app.listen({ port: config.PORT, host: config.HOST })

  const shutdown = async () => {
    await app.close().catch(() => {})
    await db.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : e)
  process.exit(1)
})
