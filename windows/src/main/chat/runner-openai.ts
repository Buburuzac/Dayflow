// OpenAI-compatible chat (Ollama, LM Studio, hosted): native `tools` function calling with
// streaming; when the server/model rejects tools, falls back to a JSON text tool protocol.

import { jsonSchemaTools } from './tools.ts'
import { dayflowToday, textToolProtocolSection } from './prompts.ts'
import { type ApiRunInput, CancelledError, type Emit, MAX_TOOL_ROUNDS, TOOL_ROUNDS_ERROR } from './runner.ts'

const HTTP_TIMEOUT_MS = 600_000

type Msg = Record<string, unknown>

interface ToolCallAcc {
  id: string
  name: string
  args: string
}

interface TurnOut {
  text: string
  toolCalls: ToolCallAcc[]
}

class HttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 400)}`)
    this.status = status
    this.body = body
  }
}

/** Routes <think>…</think> content to `thinking`, everything else to `text`. */
export class ThinkFilter {
  private inThink = false
  private pending = ''
  private readonly onText: (t: string) => void
  private readonly onThink: (t: string) => void

  constructor(onText: (t: string) => void, onThink: (t: string) => void) {
    this.onText = onText
    this.onThink = onThink
  }

  push(chunk: string): void {
    let s = this.pending + chunk
    this.pending = ''
    while (s) {
      const tag = this.inThink ? '</think>' : '<think>'
      const i = s.indexOf(tag)
      if (i >= 0) {
        if (i > 0) (this.inThink ? this.onThink : this.onText)(s.slice(0, i))
        s = s.slice(i + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // Hold back a possible partial tag at the end.
      let keep = 0
      for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
        if (tag.startsWith(s.slice(-k))) {
          keep = k
          break
        }
      }
      const out = s.slice(0, s.length - keep)
      if (out) (this.inThink ? this.onThink : this.onText)(out)
      this.pending = s.slice(s.length - keep)
      s = ''
    }
  }

  end(): void {
    if (this.pending) (this.inThink ? this.onThink : this.onText)(this.pending)
    this.pending = ''
  }
}

/** Recognizes a text-protocol tool request: a reply that is only {"tool": …, "arguments": {…}}. */
export function parseTextToolRequest(text: string): { name: string; args: Record<string, unknown> } | null {
  let t = text.trim()
  const fence = /^```(?:json|tool)?\s*\n?([\s\S]*?)\n?```$/i.exec(t)
  if (fence) t = fence[1].trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  try {
    const v = JSON.parse(t) as Record<string, unknown>
    const name = v.tool ?? v.name ?? v.function
    if (typeof name !== 'string' || !name) return null
    const args = v.arguments ?? v.args ?? v.parameters ?? {}
    let parsed: unknown = args
    if (typeof args === 'string') {
      try {
        parsed = JSON.parse(args)
      } catch {
        parsed = {}
      }
    }
    return { name, args: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} }
  } catch {
    return null
  }
}

export class OpenAIChatRunner {
  private readonly baseUrl: string
  private readonly model: string
  private readonly apiKey: string

  constructor(baseUrl: string, model: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.model = model
    this.apiKey = apiKey
  }

  private async request(messages: Msg[], withTools: boolean, signal: AbortSignal): Promise<Response> {
    const body: Record<string, unknown> = { model: this.model, messages, stream: true, temperature: 0.4 }
    if (withTools) {
      body.tools = jsonSchemaTools().map((t) => ({ type: 'function', function: t }))
      body.tool_choice = 'auto'
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]),
    })
    if (!res.ok) throw new HttpError(res.status, await res.text())
    return res
  }

  /** Reads an SSE (or plain JSON) completion; `onText` gets visible text as it streams. */
  private async readTurn(res: Response, onText: (t: string) => void, emit: Emit): Promise<TurnOut> {
    const out: TurnOut = { text: '', toolCalls: [] }
    const byIndex = new Map<number, ToolCallAcc>()
    const filter = new ThinkFilter(
      (t) => {
        out.text += t
        onText(t)
      },
      (t) => emit({ type: 'thinking', text: t }),
    )
    const handleChoice = (choice: Record<string, unknown> | undefined) => {
      if (!choice) return
      const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined
      if (!delta) return
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning) emit({ type: 'thinking', text: reasoning })
      if (typeof delta.content === 'string' && delta.content) filter.push(delta.content)
      const calls = delta.tool_calls as Array<Record<string, unknown>> | undefined
      for (const [i, c] of (calls ?? []).entries()) {
        const idx = typeof c.index === 'number' ? c.index : i
        const fn = (c.function ?? {}) as { name?: string; arguments?: unknown }
        let acc = byIndex.get(idx)
        if (!acc) {
          acc = { id: String(c.id ?? `call_${idx}`), name: '', args: '' }
          byIndex.set(idx, acc)
        }
        if (c.id) acc.id = String(c.id)
        if (fn.name) acc.name += fn.name
        if (typeof fn.arguments === 'string') acc.args += fn.arguments
        else if (fn.arguments && typeof fn.arguments === 'object') acc.args = JSON.stringify(fn.arguments)
      }
    }
    const ctype = res.headers.get('content-type') ?? ''
    if (!ctype.includes('event-stream')) {
      const json = (await res.json()) as { choices?: Array<Record<string, unknown>> }
      handleChoice(json.choices?.[0])
    } else {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const line = (l: string) => {
        if (!l.startsWith('data:')) return
        const payload = l.slice(5).trim()
        if (!payload || payload === '[DONE]') return
        try {
          const json = JSON.parse(payload) as { choices?: Array<Record<string, unknown>>; error?: { message?: string } }
          if (json.error?.message) throw new Error(json.error.message)
          handleChoice(json.choices?.[0])
        } catch (err) {
          if (err instanceof SyntaxError) return
          throw err
        }
      }
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          line(buf.slice(0, nl).replace(/\r$/, ''))
          buf = buf.slice(nl + 1)
        }
      }
      if (buf) line(buf)
    }
    filter.end()
    out.toolCalls = [...byIndex.values()].filter((c) => c.name)
    return out
  }

  async run(input: ApiRunInput, emit: Emit): Promise<void> {
    if (!this.model) throw new Error('No model configured for the local server. Set one in Settings.')
    try {
      await this.runNative(input, emit)
    } catch (err) {
      if (input.signal.aborted) throw new CancelledError()
      if (err instanceof ToolsRejected) {
        emit({ type: 'debug', kind: 'INFO', content: `Server rejected tools (${err.message}); using the text tool protocol.` })
        await this.runTextProtocol(input, emit)
        return
      }
      throw new Error(`${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async runNative(input: ApiRunInput, emit: Emit): Promise<void> {
    const messages: Msg[] = [{ role: 'system', content: input.system }, ...input.history.map((t) => ({ role: t.role, content: t.content }))]
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let res: Response
      try {
        res = await this.request(messages, true, input.signal)
      } catch (err) {
        // Any 4xx/5xx on the first tools request: assume tools are unsupported.
        if (round === 0 && err instanceof HttpError && err.status >= 400) throw new ToolsRejected(err.message)
        throw err
      }
      const turn = await this.readTurn(res, (t) => emit({ type: 'textDelta', text: t }), emit)
      if (turn.toolCalls.length === 0) {
        emit({ type: 'complete', text: turn.text })
        return
      }
      if (round === MAX_TOOL_ROUNDS) break
      messages.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
      })
      for (const c of turn.toolCalls) {
        const cmd = `${c.name} ${c.args || '{}'}`
        emit({ type: 'toolStart', command: cmd, id: c.id })
        emit({ type: 'debug', kind: 'TOOL DETECTED', content: cmd })
        const resp = input.executeTool(c.name, c.args || '{}')
        emit({ type: 'debug', kind: 'TOOL RESULT', content: JSON.stringify(resp).slice(0, 4000) })
        emit({ type: 'toolEnd', output: resp.summary ?? 'Tool finished.', exitCode: resp.error ? 1 : 0, id: c.id })
        messages.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: JSON.stringify(resp) })
      }
    }
    throw new Error(TOOL_ROUNDS_ERROR)
  }

  private async runTextProtocol(input: ApiRunInput, emit: Emit): Promise<void> {
    const ymd = dayflowToday(new Date())
    const messages: Msg[] = [
      { role: 'system', content: `${input.system}\n\n${textToolProtocolSection(ymd)}` },
      ...input.history.map((t) => ({ role: t.role, content: t.content })),
    ]
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await this.request(messages, false, input.signal)
      // Stream normally unless the reply starts like a JSON tool request; then buffer it.
      let decided: 'stream' | 'buffer' | null = null
      let held = ''
      const turn = await this.readTurn(
        res,
        (t) => {
          if (decided === 'stream') {
            emit({ type: 'textDelta', text: t })
            return
          }
          held += t
          if (decided === null) {
            const first = held.trimStart()[0]
            if (first === undefined) return
            decided = first === '{' || first === '`' ? 'buffer' : 'stream'
            if (decided === 'stream') {
              emit({ type: 'textDelta', text: held })
              held = ''
            }
          }
        },
        emit,
      )
      const request = parseTextToolRequest(turn.text)
      if (!request) {
        if (held) emit({ type: 'textDelta', text: held })
        emit({ type: 'complete', text: turn.text })
        return
      }
      if (round === MAX_TOOL_ROUNDS) break
      const cmd = `${request.name} ${JSON.stringify(request.args)}`
      emit({ type: 'toolStart', command: cmd })
      emit({ type: 'debug', kind: 'TOOL DETECTED', content: cmd })
      const resp = input.executeTool(request.name, request.args)
      emit({ type: 'debug', kind: 'TOOL RESULT', content: JSON.stringify(resp).slice(0, 4000) })
      emit({ type: 'toolEnd', output: resp.summary ?? 'Tool finished.', exitCode: resp.error ? 1 : 0 })
      messages.push({ role: 'assistant', content: turn.text.trim() })
      messages.push({
        role: 'user',
        content: `TOOL RESULT (${request.name}):\n${JSON.stringify(resp)}\n\nContinue: call another tool if you need more data, otherwise write the final answer for the user.`,
      })
    }
    throw new Error(TOOL_ROUNDS_ERROR)
  }
}

class ToolsRejected extends Error {}
