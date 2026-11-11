// HTTP client for the Dayflow Sync Server (docs/sync-server-design.md). Uses global fetch so the
// same code runs in Electron's main process and in node tests.

import type {
  AuthResponse,
  DevAuthRequest,
  GoogleConfigResponse,
  GoogleExchangeRequest,
  MeResponse,
  ProjectEntry,
  ProjectReport,
  PullResponse,
  PushResponse,
  SyncChange,
  TimesheetProposal,
  TimesheetSubmitRequest,
  TimesheetSubmitResult,
  WebLinkResponse,
} from '../../shared/sync-types.ts'

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type FetchLike = typeof fetch

export function normalizeServerUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '')
  const u = new URL(s)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The server URL must start with http:// or https://')
  return s
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([t, signal]) : t
}

export class SyncClient {
  readonly baseUrl: string
  private readonly token: string | null
  private readonly fetchImpl: FetchLike
  /** Aborts every request of this client (a sync cycle cancelled by sign-out). */
  private readonly signal: AbortSignal | undefined

  constructor(baseUrl: string, token: string | null, fetchImpl: FetchLike = fetch, signal?: AbortSignal) {
    this.baseUrl = normalizeServerUrl(baseUrl)
    this.token = token
    this.fetchImpl = fetchImpl
    this.signal = signal
  }

  private async req<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.auth !== false) {
      if (!this.token) throw new HttpError(401, 'Not signed in')
      headers.Authorization = `Bearer ${this.token}`
    }
    let res: Response
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: withTimeout(opts.timeoutMs ?? 30_000, this.signal),
      })
    } catch (err) {
      const msg = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
      throw new HttpError(0, `Could not reach the sync server (${msg})`)
    }
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const o = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
      const detail = typeof o.error === 'string' ? o.error : typeof o.message === 'string' ? o.message : text.slice(0, 200)
      throw new HttpError(res.status, `${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
    }
    return json as T
  }

  // ---- auth ----

  googleConfig(): Promise<GoogleConfigResponse> {
    return this.req('GET', '/api/auth/google/config', undefined, { auth: false, timeoutMs: 10_000 })
  }

  googleExchange(body: GoogleExchangeRequest): Promise<AuthResponse> {
    return this.req('POST', '/api/auth/google/exchange', body, { auth: false })
  }

  devAuth(body: DevAuthRequest): Promise<AuthResponse> {
    return this.req('POST', '/api/auth/dev', body, { auth: false })
  }

  webLink(): Promise<WebLinkResponse> {
    return this.req('POST', '/api/auth/web-link', {})
  }

  me(): Promise<MeResponse> {
    return this.req('GET', '/api/me')
  }

  revokeDevice(id: string): Promise<unknown> {
    return this.req('DELETE', `/api/devices/${encodeURIComponent(id)}`)
  }

  // ---- sync ----

  push(changes: SyncChange[]): Promise<PushResponse> {
    return this.req('POST', '/api/sync/push', { changes }, { timeoutMs: 60_000 })
  }

  pull(cursor: number, limit = 1000): Promise<PullResponse> {
    return this.req('GET', `/api/sync/pull?cursor=${encodeURIComponent(String(cursor))}&limit=${limit}`, undefined, { timeoutMs: 60_000 })
  }

  /**
   * Server-Sent Events: calls `onEvent` for every event (name, data). Resolves when the server
   * closes the stream; rejects on HTTP/network errors. `onOpen` fires once the stream is up.
   */
  async stream(
    onEvent: (event: string, data: string) => void,
    signal: AbortSignal,
    onOpen?: () => void,
    /** Any bytes received (heartbeats included), for an idle watchdog */
    onChunk?: () => void,
  ): Promise<void> {
    if (!this.token) throw new HttpError(401, 'Not signed in')
    const res = await this.fetchImpl(this.baseUrl + '/api/sync/stream', {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${this.token}` },
      signal,
    })
    if (!res.ok || !res.body) throw new HttpError(res.status, `stream: ${res.status} ${res.statusText}`)
    onOpen?.()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let event = 'message'
    let data: string[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onChunk?.()
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line === '') {
          if (data.length || event !== 'message') onEvent(event, data.join('\n'))
          event = 'message'
          data = []
        } else if (line.startsWith(':')) {
          // comment / heartbeat
        } else {
          const i = line.indexOf(':')
          const field = i < 0 ? line : line.slice(0, i)
          const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
          if (field === 'event') event = val
          else if (field === 'data') data.push(val)
        }
      }
    }
  }

  // ---- team ----

  projectFeed(projectId: string, from: string, to: string): Promise<ProjectEntry[] | { entries: ProjectEntry[] }> {
    return this.req('GET', `/api/projects/${encodeURIComponent(projectId)}/feed?from=${from}&to=${to}`)
  }

  projectReport(projectId: string, from: string, to: string): Promise<ProjectReport> {
    return this.req('GET', `/api/projects/${encodeURIComponent(projectId)}/report?from=${from}&to=${to}`)
  }

  timesheetProposals(
    from: string,
    to: string,
    workspaceId: string,
  ): Promise<{ proposals: TimesheetProposal[]; odooConfigured?: boolean; employeeMapped?: boolean } | TimesheetProposal[]> {
    return this.req('GET', `/api/timesheets/proposals?from=${from}&to=${to}&workspaceId=${encodeURIComponent(workspaceId)}`)
  }

  timesheetSubmit(body: TimesheetSubmitRequest): Promise<TimesheetSubmitResult> {
    return this.req('POST', '/api/timesheets/submit', body, { timeoutMs: 120_000 })
  }
}
