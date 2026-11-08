// Google sign-in for installed apps: loopback redirect on 127.0.0.1:<random port> + PKCE (S256).
// The browser returns an authorization code here; the sync server exchanges it (it holds the
// client secret) via POST /api/auth/google/exchange.

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authorizeUrl(clientId: string, redirectUri: string, challenge: string, state: string, base = GOOGLE_AUTHORIZE_URL): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  })
  return `${base}?${q.toString()}`
}

export interface LoopbackResult {
  code: string
  codeVerifier: string
  redirectUri: string
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:Segoe UI,sans-serif;background:#fbf7f2;color:#333;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
  `<div style="text-align:center"><h1 style="font-weight:400">${title}</h1><p>${body}</p></div></body>`

/**
 * Opens the system browser at Google's consent page and waits (up to `timeoutMs`) for the
 * redirect to the local listener. Rejects on denial, state mismatch, timeout or `signal`.
 */
export function loopbackAuthorize(opts: {
  clientId: string
  openBrowser: (url: string) => unknown
  timeoutMs?: number
  signal?: AbortSignal
  authorizeBase?: string
}): Promise<LoopbackResult> {
  const { verifier, challenge } = pkcePair()
  const state = b64url(randomBytes(16))
  return new Promise<LoopbackResult>((resolve, reject) => {
    let redirectUri = ''
    let settled = false
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const ok = !error && !!code && url.searchParams.get('state') === state
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        ok
          ? PAGE('Signed in to Dayflow', 'You can close this tab and return to Dayflow.')
          : PAGE('Sign-in failed', error ? `Google returned: ${error.replace(/[<>&"]/g, '')}` : 'The response did not match this sign-in.'),
      )
      if (ok) finish(null, { code: code!, codeVerifier: verifier, redirectUri })
      else finish(new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed${error ? `: ${error}` : ''}`))
    })
    const timer = setTimeout(() => finish(new Error('Sign-in timed out. Try again.')), opts.timeoutMs ?? 5 * 60_000)
    const onAbort = () => finish(new Error('Sign-in was cancelled.'))
    opts.signal?.addEventListener('abort', onAbort)
    function finish(err: Error | null, result?: LoopbackResult) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      server.close()
      server.closeAllConnections?.()
      if (err) reject(err)
      else resolve(result!)
    }
    server.on('error', (err) => finish(err))
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      redirectUri = `http://127.0.0.1:${port}/callback`
      try {
        void Promise.resolve(opts.openBrowser(authorizeUrl(opts.clientId, redirectUri, challenge, state, opts.authorizeBase))).catch(
          (e: unknown) => finish(e instanceof Error ? e : new Error(String(e))),
        )
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })
}
