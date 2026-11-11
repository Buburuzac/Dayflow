// Category renames and the "never upload" list (Settings → Sync & team → syncExcludedCategories).
// Existing cards keep the category string they were written with, so a renamed category keeps its
// old name in the list next to the new one. Pure module, used by the renderer and the sync engine.

/** Most names settings-schema accepts for syncExcludedCategories. */
export const MAX_EXCLUDED_CATEGORIES = 30

const key = (s: unknown) => String(s ?? '').trim().toLowerCase()

/**
 * Renames between two category lists: a category that disappeared and a new one added at the same
 * list index. Returns [oldName, newName] pairs.
 */
export function detectCategoryRenames(prev: string[], next: string[]): [string, string][] {
  const prevKeys = new Set(prev.map(key))
  const nextKeys = new Set(next.map(key))
  const out: [string, string][] = []
  for (let i = 0; i < Math.min(prev.length, next.length); i++) {
    if (!nextKeys.has(key(prev[i])) && !prevKeys.has(key(next[i]))) out.push([prev[i], next[i]])
  }
  return out
}

/**
 * Adds the new name of every renamed category whose old name is excluded, keeping the old name.
 * When the list would exceed the settings limit, names that are no longer categories go first.
 */
export function withRenamedExclusions(excluded: string[], renames: [string, string][], current: string[] = []): string[] {
  const out = [...excluded]
  for (const [from, to] of renames) {
    const has = (n: string) => out.some((x) => key(x) === key(n))
    if (has(from) && !has(to)) out.push(to)
  }
  return capExcluded(out, current)
}

/** Checks or unchecks a current category in the list; names of old categories stay untouched. */
export function toggleExcluded(excluded: string[], name: string, on: boolean, current: string[] = []): string[] {
  const rest = excluded.filter((x) => key(x) !== key(name))
  return on ? capExcluded([...rest, name], current) : rest
}

/** Keeps the list within the settings limit, dropping names that are no longer categories first. */
function capExcluded(list: string[], current: string[]): string[] {
  const out = [...list]
  const cur = new Set(current.map(key))
  while (out.length > MAX_EXCLUDED_CATEGORIES) {
    const stale = out.findIndex((x) => !cur.has(key(x)))
    out.splice(stale >= 0 ? stale : 0, 1)
  }
  return out
}

/**
 * First pull after sign-in: the server's list, plus the local categories it lacks (by name). A local
 * idle category is not added next to the server's one; the result stays within `max` entries.
 */
export function mergeCategoryLists<T extends { name: string; isIdle?: boolean }>(server: T[], local: T[], max = 30): T[] {
  const out = [...server]
  const names = new Set(server.map((c) => key(c.name)))
  const serverIdle = server.some((c) => c.isIdle)
  for (const c of local) {
    if (out.length >= max) break
    if (names.has(key(c.name)) || (c.isIdle && serverIdle)) continue
    names.add(key(c.name))
    out.push(c)
  }
  return out
}
