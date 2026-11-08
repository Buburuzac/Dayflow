// Metadata parsing for chat replies (ChatMetadataParser.swift / DashboardChatMemoryStore.swift):
// the trailing ```suggestions / ```memory blocks, the streaming hide rule, memory normalization,
// suggestion history and tool-row summaries. Pure functions, unit-tested.

export const MEMORY_MAX_CHARS = 10_000
export const SUGGESTION_HISTORY_MAX = 12
export const RECENT_SUGGESTIONS_SENT = 9

export interface ParsedMetadata {
  cleanedText: string
  suggestions: string[]
  /** Normalized memory blob, or null when the reply had no (valid) memory block */
  memory: string | null
}

const END = '$(?![\\s\\S])'

const SUGGESTIONS_STRICT =
  /(?:^|\n)\s*(?:#{1,6}\s*Suggestions\s*\n+|Suggestions:\s*)?```suggestions\s*\n([\s\S]*?)\n?```/ims
const SUGGESTIONS_LOOSE = new RegExp(
  '(?:^|\\n)\\s*(?:#{1,6}\\s*Suggestions\\s*\\n+|Suggestions:\\s*\\n?)(\\[[\\s\\S]*?\\])(?=\\n\\s*(?:#{1,6}\\s*Memory\\b|Memory:)|' +
    END +
    ')',
  'ims',
)
const MEMORY_STRICT = /(?:^|\n)\s*(?:#{1,6}\s*Memory\s*\n+|Memory:\s*)?```memory\s*\n([\s\S]*?)\n?```/ims
const MEMORY_LOOSE = new RegExp(
  '(?:^|\\n)\\s*(?:#{1,6}\\s*Memory\\s*\\n+|Memory:\\s*\\n?)(Profile:[\\s\\S]*?Style:[^\\n]*(?:\\n[^#\\n].*)*)(?=' + END + ')',
  'ims',
)
const RESIDUAL = [
  /^\s*#{1,6}\s*Suggestions\s*$/gim,
  /^\s*#{1,6}\s*Memory\s*$/gim,
  /^\s*Suggestions:\s*$/gim,
  /^\s*Memory:\s*$/gim,
]

function parseSuggestionArray(text: string): string[] | null {
  try {
    const v = JSON.parse(text.trim()) as unknown
    if (Array.isArray(v) && v.every((s) => typeof s === 'string')) {
      return (v as string[]).map((s) => s.trim()).filter(Boolean)
    }
  } catch {
    /* invalid */
  }
  return null
}

/** Normalizes an auto-memory block to "Profile: …\nStyle: …"; null when neither line is present. */
export function normalizeAutoMemoryBlob(raw: string): string | null {
  let profile: string | null = null
  let style: string | null = null
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim()
    if (!t) continue
    const lower = t.toLowerCase()
    if (lower.startsWith('profile:')) {
      const v = t.slice('profile:'.length).trim()
      if (v) profile = v
    } else if (lower.startsWith('style:')) {
      const v = t.slice('style:'.length).trim()
      if (v) style = v
    }
  }
  const out: string[] = []
  if (profile !== null) out.push(`Profile: ${profile}`)
  if (style !== null) out.push(`Style: ${style}`)
  return out.length ? out.join('\n') : null
}

/** Parses the raw full response after a turn (§6.2). */
export function parseMetadata(raw: string): ParsedMetadata {
  let text = raw.replace(/\r\n?/g, '\n')
  let suggestions: string[] = []
  let memory: string | null = null

  const s1 = SUGGESTIONS_STRICT.exec(text)
  if (s1) {
    suggestions = parseSuggestionArray(s1[1]) ?? []
    text = text.slice(0, s1.index) + text.slice(s1.index + s1[0].length)
  }
  if (suggestions.length === 0) {
    const s2 = SUGGESTIONS_LOOSE.exec(text)
    if (s2) {
      suggestions = parseSuggestionArray(s2[1]) ?? []
      text = text.slice(0, s2.index) + '\n' + text.slice(s2.index + s2[0].length)
    }
  }

  const m1 = MEMORY_STRICT.exec(text)
  if (m1) {
    memory = normalizeAutoMemoryBlob(m1[1])
    text = text.slice(0, m1.index) + text.slice(m1.index + m1[0].length)
  } else {
    const m2 = MEMORY_LOOSE.exec(text)
    if (m2) {
      memory = normalizeAutoMemoryBlob(m2[1])
      text = text.slice(0, m2.index) + '\n' + text.slice(m2.index + m2[0].length)
    }
  }

  for (const re of RESIDUAL) text = text.replace(re, '')
  return { cleanedText: text.trim(), suggestions, memory }
}

const HIDE_FENCE = /^[ \t]*```(?:suggestions|memory)\b/im

/** Text to show while streaming: metadata fences (and a half-typed fence on the last line) are hidden. */
export function visibleStreamingText(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n')
  const m = HIDE_FENCE.exec(text)
  if (m) return text.slice(0, m.index).trim()
  const nl = text.lastIndexOf('\n')
  const last = text.slice(nl + 1).trim().toLowerCase()
  if (last && ('```suggestions'.startsWith(last) || '```memory'.startsWith(last))) {
    return text.slice(0, Math.max(0, nl)).trim()
  }
  return text
}

/** Memory store normalization on save (§6.3). Returns '' when the result is empty. */
export function normalizeMemoryForSave(text: string): string {
  let t = text.replace(/\r\n?/g, '\n').trim()
  while (/\n{3,}/.test(t)) t = t.replace(/\n{3,}/g, '\n\n')
  return t.slice(0, MEMORY_MAX_CHARS).trim()
}

/** Rolling, case-insensitively de-duplicated suggestion history (max 12). */
export function updateSuggestionHistory(history: string[], next: string[]): string[] {
  let out = [...history]
  for (const s of next) {
    const t = s.trim()
    if (!t) continue
    out = out.filter((o) => o.toLowerCase() !== t.toLowerCase())
    out.push(t)
  }
  return out.slice(-SUGGESTION_HISTORY_MAX)
}

/** Tool-row summary text (§4.5). */
export function toolSummary(command: string, output: string | null, exitCode: number | null): string {
  const lower = command.toLowerCase()
  const base = lower.includes('sqlite3')
    ? 'Database query'
    : lower.includes('fetchtimeline') || lower.includes('fetchobservations')
      ? 'Data fetch'
      : 'Tool'
  if (exitCode !== null && exitCode !== 0) return `${base} failed (exit ${exitCode})`
  if (exitCode === null && !output) return `Running ${base.toLowerCase()}…`
  if (!output || !output.trim()) return `${base} completed`
  if (base === 'Data fetch') return output.trim()
  const n = output.split('\n').filter((l) => l.trim()).length
  return `${base} returned ${n} ${n === 1 ? 'row' : 'rows'}`
}

/** Conversation title: first user message, newlines → spaces, trimmed, ≤ 80 chars. */
export function conversationTitle(firstUserMessage: string | undefined): string {
  const t = (firstUserMessage ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80)
  return t || 'New chat'
}

/** Joins text that resumes after a tool call: one space if neither side has whitespace at the join. */
export function joinAfterTool(prev: string, next: string): string {
  if (!prev || !next) return prev + next
  if (/\s$/.test(prev) || /^\s/.test(next)) return prev + next
  return `${prev} ${next}`
}

/** CLI resume failures that mean the session id is gone. */
export function isMissingSessionError(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('no rollout found for thread id') || m.includes('no conversation found with session id')
}
