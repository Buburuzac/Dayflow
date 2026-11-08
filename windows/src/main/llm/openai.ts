// OpenAI-compatible chat completions: Ollama (http://localhost:11434/v1), LM Studio
// (http://localhost:1234/v1), or any hosted endpoint. Mirrors OllamaProvider: small local
// vision models describe one frame at a time, then a text call groups them into segments.

import { readFile } from 'node:fs/promises'
import type { CallLogger, Frame, LLMProvider } from './types.ts'

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = 'openai_compatible'
  readonly model: string
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly log: CallLogger

  constructor(baseUrl: string, model: string, apiKey: string, log: CallLogger) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.model = model
    this.apiKey = apiKey
    this.log = log
  }

  async describeFrame(prompt: string, frame: Frame, signal?: AbortSignal): Promise<string> {
    const b64 = (await readFile(frame.path)).toString('base64')
    const text = frame.label ? `${prompt}\n\nForeground window: ${frame.label}` : prompt
    return this.chat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ],
        },
      ],
      'describe_frame',
      false,
      signal,
    )
  }

  generateText(prompt: string, operation: string, expectJSON: boolean, signal?: AbortSignal): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }], operation, expectJSON, signal)
  }

  private async chat(
    messages: unknown[],
    operation: string,
    expectJSON: boolean,
    signal?: AbortSignal,
    attempt = 1,
  ): Promise<string> {
    const body: Record<string, unknown> = { model: this.model, messages, temperature: 0.3, stream: false }
    // json_object mode forces a top-level object; the cards prompt asks for an array, so only
    // object-shaped responses (segment grouping) use it.
    if (expectJSON && operation !== 'generate_cards') body.response_format = { type: 'json_object' }
    const started = Date.now()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const loggedBody = operation === 'describe_frame' ? '<image request>' : JSON.stringify(body)
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
      })
      const text = await res.text()
      if (!res.ok) {
        // Some servers reject response_format; retry once without it.
        if (expectJSON && res.status === 400 && attempt === 1) {
          return this.chat(messages, operation, false, signal, attempt + 1)
        }
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      }
      const json = JSON.parse(text)
      const out: string = json.choices?.[0]?.message?.content ?? ''
      this.log({
        provider: this.id, model: this.model, operation, status: 'success',
        latencyMs: Date.now() - started, requestBody: loggedBody, responseBody: out,
      })
      // Reasoning models may wrap their thoughts in <think>…</think>.
      return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    } catch (err) {
      this.log({
        provider: this.id, model: this.model, operation, status: 'failure',
        latencyMs: Date.now() - started, requestBody: loggedBody, errorMessage: String(err),
      })
      throw new Error(`${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
