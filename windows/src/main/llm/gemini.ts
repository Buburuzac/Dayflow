// Gemini via the public REST API (generativelanguage.googleapis.com).
// The macOS app composites screenshots into a video and uploads it; here frames are sent
// as inline JPEG parts, each preceded by its timestamp label — no ffmpeg dependency.

import { readFile } from 'node:fs/promises'
import type { CallLogger, Frame, LLMProvider } from './types.ts'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

type Part = { text: string } | { inline_data: { mime_type: string; data: string } }

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini'
  readonly model: string
  private readonly apiKey: string
  private readonly log: CallLogger

  constructor(apiKey: string, model: string, log: CallLogger) {
    this.apiKey = apiKey
    this.model = model || 'gemini-2.5-flash'
    this.log = log
  }

  async generateWithImages(prompt: string, frames: Frame[], operation: string, signal?: AbortSignal): Promise<string> {
    const parts: Part[] = [{ text: prompt }]
    for (const f of frames) {
      parts.push({ text: f.label ? `[${fmt(f.offsetSeconds)}] ${f.label}` : `[${fmt(f.offsetSeconds)}]` })
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: (await readFile(f.path)).toString('base64') } })
    }
    return this.call(parts, operation, true, signal)
  }

  generateText(prompt: string, operation: string, expectJSON: boolean, signal?: AbortSignal): Promise<string> {
    return this.call([{ text: prompt }], operation, expectJSON, signal)
  }

  private async call(
    parts: Part[],
    operation: string,
    expectJSON: boolean,
    signal?: AbortSignal,
    attempt = 1,
  ): Promise<string> {
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.4,
        ...(expectJSON ? { responseMimeType: 'application/json' } : {}),
      },
    }
    const started = Date.now()
    const loggedBody = JSON.stringify({
      ...body,
      contents: [{ role: 'user', parts: parts.map((p) => ('text' in p ? p : { inline_data: '<jpeg>' })) }],
    })
    let res: Response
    try {
      res = await fetch(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
      })
    } catch (err) {
      this.log({
        provider: this.id, model: this.model, operation, status: 'failure',
        latencyMs: Date.now() - started, requestBody: loggedBody, errorMessage: String(err),
      })
      if (attempt < 3 && !signal?.aborted) {
        await sleep(2000 * attempt)
        return this.call(parts, operation, expectJSON, signal, attempt + 1)
      }
      throw err
    }
    const text = await res.text()
    if (!res.ok) {
      this.log({
        provider: this.id, model: this.model, operation, status: 'failure',
        latencyMs: Date.now() - started, requestBody: loggedBody, responseBody: text,
        errorMessage: `HTTP ${res.status}`,
      })
      // One retry for transient server errors. Rate limits (429) are surfaced to the caller, which
      // already retries; retrying here too multiplied requests and made the limiting worse.
      if (res.status >= 500 && attempt < 2 && !signal?.aborted) {
        await sleep(5000)
        return this.call(parts, operation, expectJSON, signal, attempt + 1)
      }
      let message = `Gemini HTTP ${res.status}`
      try {
        message += `: ${JSON.parse(text).error?.message ?? text.slice(0, 300)}`
      } catch {
        message += `: ${text.slice(0, 300)}`
      }
      throw new Error(message)
    }
    const json = JSON.parse(text)
    const out: string = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string; thought?: boolean }) => (p.thought ? '' : p.text ?? ''))
      .join('')
    this.log({
      provider: this.id, model: this.model, operation, status: 'success',
      latencyMs: Date.now() - started, requestBody: loggedBody, responseBody: out,
    })
    if (!out.trim()) {
      const reason = json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason ?? 'empty response'
      throw new Error(`Gemini returned no text (${reason})`)
    }
    return out
  }
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
