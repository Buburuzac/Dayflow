// Gemini dashboard chat with native function calling (GeminiDirectProvider+DashboardChat /
// +Streaming / +Tools.swift): SSE streaming, verbatim replay of functionCall parts
// (thoughtSignature), per-model retries and a model fallback list.

import { GEMINI_FUNCTION_DECLARATIONS } from './tools.ts'
import { type ApiRunInput, CancelledError, type Emit, MAX_TOOL_ROUNDS, TOOL_ROUNDS_ERROR } from './runner.ts'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const HTTP_TIMEOUT_MS = 180_000

/** Chat fallback order from the macOS app; the user's configured model is tried first. */
export const GEMINI_CHAT_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']

type Part = Record<string, unknown>
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

interface FunctionCall {
  name: string
  args: Record<string, unknown>
}

interface TurnResult {
  text: string
  calls: FunctionCall[]
  /** The model's functionCall parts, kept verbatim (they may carry thoughtSignature). */
  callParts: Part[]
}

class GeminiHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

function parseArgs(a: unknown): Record<string, unknown> {
  if (typeof a === 'string') {
    try {
      const v = JSON.parse(a) as unknown
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
}

/** Splits an SSE `data:` payload into JSON objects (object, array, NDJSON or concatenated objects). */
export function parseSsePayload(payload: string): Array<Record<string, unknown>> {
  const t = payload.trim()
  if (!t || t === '[DONE]') return []
  try {
    const v = JSON.parse(t) as unknown
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>
    if (v && typeof v === 'object') return [v as Record<string, unknown>]
  } catch {
    /* fall through */
  }
  const out: Array<Record<string, unknown>> = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(t.slice(start, i + 1)) as Record<string, unknown>)
        } catch {
          /* skip */
        }
        start = -1
      }
    }
  }
  return out
}

/** Accumulates streamed chunks into a turn; emits visible text deltas until a call is seen. */
export class GeminiTurnAccumulator {
  text = ''
  calls: FunctionCall[] = []
  callParts: Part[] = []
  private fingerprints = new Set<string>()
  private lastAggregated = ''
  private readonly emit: Emit

  constructor(emit: Emit) {
    this.emit = emit
  }

  addChunk(chunk: Record<string, unknown>): void {
    const cands = chunk.candidates as Array<{ content?: { parts?: Part[] } }> | undefined
    const parts = cands?.[0]?.content?.parts ?? []
    let chunkText = ''
    for (const p of parts) {
      if (p.functionCall && typeof p.functionCall === 'object') {
        const fc = p.functionCall as { name?: string; args?: unknown }
        const call = { name: String(fc.name ?? ''), args: parseArgs(fc.args) }
        const fp = `${call.name}|${sortedJson(call.args)}`
        if (!this.fingerprints.has(fp)) {
          this.fingerprints.add(fp)
          this.calls.push(call)
          this.callParts.push(p)
        }
      } else if (typeof p.text === 'string') {
        if (p.thought) this.emit({ type: 'thinking', text: p.text })
        else chunkText += p.text
      }
    }
    if (!chunkText) return
    // Some responses resend the aggregated text; emit only the new suffix.
    let delta = chunkText
    if (this.lastAggregated && chunkText.startsWith(this.lastAggregated)) {
      delta = chunkText.slice(this.lastAggregated.length)
      this.lastAggregated = chunkText
    } else {
      this.lastAggregated = this.text + chunkText
    }
    this.text += delta
    if (delta && this.calls.length === 0) this.emit({ type: 'textDelta', text: delta })
  }

  result(): TurnResult {
    return { text: this.text, calls: this.calls, callParts: this.callParts }
  }
}

function isThinkingConfigError(message: string): boolean {
  const m = message.toLowerCase()
  return ['thinkingconfig', 'thinking level', 'thinkinglevel', 'unknown name "thinkingconfig"', 'generationconfig', 'invalid enum value', 'thinking_level', 'thinking is not supported'].some((k) =>
    m.includes(k),
  )
}

export class GeminiChatRunner {
  private readonly apiKey: string
  private readonly models: string[]
  private readonly endpoint: string

  constructor(apiKey: string, preferredModel: string, opts: { endpoint?: string; models?: string[] } = {}) {
    this.apiKey = apiKey
    this.models = opts.models ?? [...new Set([preferredModel, ...GEMINI_CHAT_MODELS].filter(Boolean))]
    this.endpoint = opts.endpoint ?? ENDPOINT
  }

  private body(contents: Content[], system: string, thinking: boolean): string {
    return JSON.stringify({
      contents,
      tools: [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { maxOutputTokens: 8192, ...(thinking ? { thinkingConfig: { thinkingLevel: 'high' } } : {}) },
      ...(system.trim() ? { systemInstruction: { parts: [{ text: system.trim() }] } } : {}),
    })
  }

  private async post(url: string, body: string, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body,
      signal: AbortSignal.any([signal, timeout]),
    })
    if (!res.ok) {
      const text = await res.text()
      let message = `Gemini stream request failed with HTTP ${res.status}.`
      try {
        const m = (JSON.parse(text) as { error?: { message?: string } }).error?.message
        if (m) message = m
      } catch {
        /* keep default */
      }
      throw new GeminiHttpError(res.status, message)
    }
    return res
  }

  private async streamTurn(model: string, contents: Content[], system: string, thinking: boolean, input: ApiRunInput, emit: Emit): Promise<TurnResult> {
    const url = `${this.endpoint}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    const res = await this.post(url, this.body(contents, system, thinking), input.signal)
    const acc = new GeminiTurnAccumulator(emit)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let data: string[] = []
    const flush = () => {
      if (data.length) for (const obj of parseSsePayload(data.join('\n'))) acc.addChunk(obj)
      data = []
    }
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line === '') flush()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''))
    flush()
    return acc.result()
  }

  private async plainTurn(model: string, contents: Content[], system: string, thinking: boolean, input: ApiRunInput, emit: Emit): Promise<TurnResult> {
    const url = `${this.endpoint}/${encodeURIComponent(model)}:generateContent`
    const res = await this.post(url, this.body(contents, system, thinking), input.signal)
    const acc = new GeminiTurnAccumulator(emit)
    acc.addChunk((await res.json()) as Record<string, unknown>)
    return acc.result()
  }

  /** Up to 3 attempts per model, then the next model (§4.1). */
  private async turnWithFallback(contents: Content[], input: ApiRunInput, emit: Emit): Promise<TurnResult> {
    let lastErr: unknown = null
    for (const model of this.models) {
      let thinking = true
      const attempts: Array<'stream' | 'plain'> = ['stream', 'stream', 'plain']
      for (let i = 0; i < attempts.length; i++) {
        if (input.signal.aborted) throw new CancelledError()
        // Text already streamed to the user can't be taken back, so a retry would repeat it.
        let emittedText = false
        const attemptEmit: Emit = (ev) => {
          if (ev.type === 'textDelta' && ev.text) emittedText = true
          emit(ev)
        }
        try {
          emit({ type: 'debug', kind: 'INFO', content: `Gemini ${model} (${attempts[i]}${thinking ? ', thinking' : ''})` })
          return attempts[i] === 'stream'
            ? await this.streamTurn(model, contents, input.system, thinking, input, attemptEmit)
            : await this.plainTurn(model, contents, input.system, thinking, input, attemptEmit)
        } catch (err) {
          if (input.signal.aborted) throw new CancelledError()
          lastErr = err
          const message = err instanceof Error ? err.message : String(err)
          emit({ type: 'debug', kind: 'ERROR', content: `${model}: ${message}` })
          if (emittedText) {
            emit({ type: 'debug', kind: 'INFO', content: 'Stream failed after text was shown; not retrying.' })
            throw err
          }
          if (err instanceof GeminiHttpError && (err.status === 401 || err.status === 403 || /api key/i.test(message))) throw err
          if (i === 0 && err instanceof GeminiHttpError && isThinkingConfigError(message)) thinking = false
          // A missing model won't appear on retry; move on.
          if (err instanceof GeminiHttpError && err.status === 404) break
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  async run(input: ApiRunInput, emit: Emit): Promise<void> {
    if (!this.apiKey) throw new Error('Gemini is not configured. Add your Gemini API key in Settings > Providers.')
    const contents: Content[] = input.history.map((t) => ({ role: t.role === 'user' ? 'user' : 'model', parts: [{ text: t.content }] }))
    let rounds = 0
    while (rounds < MAX_TOOL_ROUNDS) {
      const turn = await this.turnWithFallback(contents, input, emit)
      if (turn.calls.length === 0) {
        emit({ type: 'complete', text: turn.text })
        return
      }
      rounds++
      contents.push({ role: 'model', parts: turn.callParts })
      const parts: Part[] = []
      for (const [i, call] of turn.calls.entries()) {
        const id = `gemini-${rounds}-${i}`
        emit({ type: 'toolStart', command: `${call.name} ${JSON.stringify(call.args)}`, id })
        emit({ type: 'debug', kind: 'TOOL DETECTED', content: `${call.name} ${JSON.stringify(call.args)}` })
        const resp = input.executeTool(call.name, call.args)
        emit({ type: 'debug', kind: 'TOOL RESULT', content: JSON.stringify(resp).slice(0, 4000) })
        emit({ type: 'toolEnd', output: resp.summary ?? 'Tool finished.', exitCode: resp.error ? 1 : 0, id })
        parts.push({ functionResponse: { name: call.name, response: resp } })
      }
      contents.push({ role: 'user', parts })
    }
    throw new Error(TOOL_ROUNDS_ERROR)
  }
}
