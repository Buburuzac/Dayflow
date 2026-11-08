import type { Config } from './config'
import type { SecretBox } from './crypto'
import type { Db } from './db'
import type { Hub } from './sync/hub'

export interface Ctx {
  config: Config
  db: Db
  hub: Hub
  box: SecretBox
  now: () => number
  /** Injected for tests (Google token endpoint, Odoo). */
  fetch: typeof fetch
}

export interface Auth {
  userId: string
  email: string
  /** Device the request is made with (device token), or the device that created the web session. */
  deviceId: string
  via: 'device' | 'session'
}
