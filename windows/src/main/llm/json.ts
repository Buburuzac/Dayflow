// Tolerant JSON extraction for LLM output (code fences, prose around the JSON,
// terminal escape sequences). Mirrors the strategies in AgentCLISupport+Transcription.swift.

const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export function stripFences(text: string): string {
  return text.replace(/```(?:json)?/gi, '').trim()
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function sliceBetween(text: string, open: string, close: string): string | null {
  const a = text.indexOf(open)
  const b = text.lastIndexOf(close)
  return a >= 0 && b > a ? text.slice(a, b + 1) : null
}

/** Returns the first JSON value found in the text, or throws. */
export function extractJson(raw: string): unknown {
  const cleaned = stripFences(raw.replace(OSC, '').replace(CSI, ''))
  const direct = tryParse(cleaned)
  if (direct !== undefined) return direct
  // Prefer whichever bracket type appears first.
  const firstArr = cleaned.indexOf('[')
  const firstObj = cleaned.indexOf('{')
  const order: Array<[string, string]> =
    firstArr >= 0 && (firstObj < 0 || firstArr < firstObj)
      ? [['[', ']'], ['{', '}']]
      : [['{', '}'], ['[', ']']]
  for (const [o, c] of order) {
    const slice = sliceBetween(cleaned, o, c)
    if (slice) {
      const v = tryParse(slice)
      if (v !== undefined) return v
    }
  }
  throw new Error(`Model output did not contain valid JSON: ${cleaned.slice(0, 300)}`)
}

/** Extracts an array, accepting either a bare array or an object wrapping one under `key`. */
export function extractArray<T = unknown>(raw: string, ...keys: string[]): T[] {
  const v = extractJson(raw)
  if (Array.isArray(v)) return v as T[]
  if (v && typeof v === 'object') {
    for (const k of keys) {
      const inner = (v as Record<string, unknown>)[k]
      if (Array.isArray(inner)) return inner as T[]
    }
    // Single object → one-element array
    for (const inner of Object.values(v as Record<string, unknown>)) {
      if (Array.isArray(inner)) return inner as T[]
    }
  }
  throw new Error('Model output JSON was not an array')
}
