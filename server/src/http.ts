import { z } from 'zod'

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code)
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details)
export const unauthorized = (msg = 'authentication required') => new HttpError(401, 'unauthorized', msg)
export const forbidden = (msg = 'forbidden') => new HttpError(403, 'forbidden', msg)
export const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg)
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg)

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value)
  if (!r.success) {
    throw badRequest(
      'invalid input',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }
  return r.data
}

export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
export const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'expected uuid')

export const IdParam = z.object({ id: Uuid })

/** Inclusive day range, at most `maxDays` long. */
export const DayRange = (maxDays = 93) =>
  z
    .object({ from: Day, to: Day })
    .refine((r) => r.from <= r.to, 'from must be <= to')
    .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 < maxDays, `range must be < ${maxDays} days`)

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
