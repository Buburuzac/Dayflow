import { Hlc, parseHlc } from '../shared'

export const MAX_FUTURE_MS = 5 * 60_000

export type HlcCheck = 'ok' | 'invalid' | 'future'

export function checkHlc(hlc: unknown, now: number): HlcCheck {
  if (typeof hlc !== 'string' || hlc.length > 200) return 'invalid'
  const p = parseHlc(hlc)
  if (!p) return 'invalid'
  if (p.ms > now + MAX_FUTURE_MS) return 'future'
  return 'ok'
}

export const maxHlc = (...xs: (string | null | undefined)[]): string =>
  xs.reduce<string>((m, x) => (x && x > m ? x : m), '')

/** Server-side clock for REST writes (projects edited in the dashboard). */
export class ServerClock {
  private readonly hlc: Hlc
  constructor(now: () => number) {
    this.hlc = new Hlc('server', now)
  }
  /** A clock strictly greater than every given HLC and the previous server clock. */
  next(...after: (string | null | undefined)[]): string {
    for (const a of after) if (a) this.hlc.observe(a)
    return this.hlc.tick()
  }
}
