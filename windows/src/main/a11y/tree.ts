// Snapshot text, stable ids and diffs — the node half of AccessibilityTreeReader.swift.
// The helper walks the tree and returns (depth, key, text) items; ids are assigned here so they
// stay stable across snapshots of an app and the condenser can compare them.
//
//   [12] button "Send" (disabled)
//   [13] textarea "Message #general" (focused) = "draft text"

export interface SnapshotLine {
  /** The element's path in the tree (hashed by the helper); same across snapshots. */
  key: string
  text: string
}

export interface A11ySnapshot {
  windowTitle: string | null
  lines: SnapshotLine[]
  durationMs: number
}

export interface RawItem {
  depth: number
  key: string
  text: string
  /** Overflow lines ("… 12 more", "(+3 other tabs)") carry no id. */
  noId: boolean
}

/** Text longer than this is cut. */
export const MAX_TEXT_LENGTH = 10_000

/** Puts text on one line and cuts it to MAX_TEXT_LENGTH characters. */
export function clip(s: string): string {
  const oneLine = s.replace(/\r\n|\r|\n/g, ' ⏎ ')
  const chars = Array.from(oneLine)
  if (chars.length <= MAX_TEXT_LENGTH) return oneLine
  return chars.slice(0, MAX_TEXT_LENGTH).join('') + `…(+${chars.length - MAX_TEXT_LENGTH})`
}

/** [3, 4, 5, 9] → "3-5,9" */
export function ranges(sortedIds: number[]): string {
  const parts: string[] = []
  let start = sortedIds[0]
  let previous = sortedIds[0]
  for (const id of sortedIds.slice(1)) {
    if (id === previous + 1) {
      previous = id
      continue
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`)
    start = id
    previous = id
  }
  parts.push(start === previous ? `${start}` : `${start}-${previous}`)
  return parts.join(',')
}

export class TreeIds {
  private idForKey = new Map<string, number>()

  /** Forgets all element ids. Called when recording stops, and when the table gets large. */
  reset(): void {
    this.idForKey.clear()
  }

  private stableId(key: string): number {
    const known = this.idForKey.get(key)
    if (known !== undefined) return known
    const id = this.idForKey.size + 1
    this.idForKey.set(key, id)
    return id
  }

  build(items: RawItem[], windowTitle: string | null, durationMs: number): A11ySnapshot {
    if (this.idForKey.size > 50_000) this.idForKey.clear()
    const lines = items.map((i) => ({
      key: i.key,
      text: ' '.repeat(i.depth) + (i.noId ? i.text : `[${this.stableId(i.key)}] ${i.text}`),
    }))
    return { windowTitle, lines, durationMs }
  }

  /** `~` changed lines, `+` added lines, and the ids of removed elements as ranges; null when nothing changed. */
  diff(old: A11ySnapshot, next: A11ySnapshot): string | null {
    const oldTextByKey = new Map<string, string>()
    for (const l of old.lines) if (!oldTextByKey.has(l.key)) oldTextByKey.set(l.key, l.text)
    const newKeys = new Set(next.lines.map((l) => l.key))

    const output: string[] = []
    for (const line of next.lines) {
      const trimmed = line.text.replace(/^[ \t]+|[ \t]+$/g, '')
      const oldText = oldTextByKey.get(line.key)
      if (oldText !== undefined) {
        if (oldText !== line.text) output.push('~ ' + trimmed)
      } else {
        output.push('+ ' + trimmed)
      }
    }

    const removed = old.lines
      .filter((l) => !newKeys.has(l.key))
      .map((l) => this.idForKey.get(l.key))
      .filter((id): id is number => id !== undefined)
      .sort((a, b) => a - b)
    if (removed.length > 0) output.push('- removed: ' + ranges(removed))

    return output.length === 0 ? null : output.join('\n')
  }
}
