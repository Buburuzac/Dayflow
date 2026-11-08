// Category colours: the user's categories arrive as the user_doc 'categories'; defaults match the desktop app.

export interface Category {
  name: string
  color: string
  description?: string
  isIdle?: boolean
}

export const DEFAULT_CATEGORIES: Category[] = [
  { name: 'Work', color: '#B984FF' },
  { name: 'Personal', color: '#6AADFF' },
  { name: 'Distraction', color: '#FF5950' },
  { name: 'Idle', color: '#A0AEC0', isIdle: true },
]

const FALLBACK = ['#F3854B', '#4CB8A4', '#E9B949', '#8F7CEC', '#E07AA8', '#5D9CEC']

/** Accepts `Category[]`, `{ categories: Category[] }` or `{ payload: … }`; returns the defaults when unusable. */
export function normalizeCategories(raw: unknown): Category[] {
  let v: unknown = raw
  for (let i = 0; i < 3 && v && typeof v === 'object' && !Array.isArray(v); i++) {
    const o = v as Record<string, unknown>
    v = o.categories ?? o.payload ?? null
  }
  if (!Array.isArray(v)) return DEFAULT_CATEGORIES
  const cats = v
    .filter((c): c is Category => !!c && typeof c === 'object' && typeof (c as Category).name === 'string')
    .map((c) => ({ ...c, color: typeof c.color === 'string' && c.color ? c.color : '#BFB6AE' }))
  return cats.length ? cats : DEFAULT_CATEGORIES
}

export function categoryColor(name: string, cats: Category[]): string {
  const key = (name ?? '').trim().toLowerCase()
  const hit = cats.find((c) => c.name.trim().toLowerCase() === key)
  if (hit) return hit.color
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return FALLBACK[h % FALLBACK.length]
}
