import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import type { Ctx } from '../context'
import { HttpError } from '../http'

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function jwks(url: string) {
  let set = jwksCache.get(url)
  if (!set) jwksCache.set(url, (set = createRemoteJWKSet(new URL(url), { cacheMaxAge: 6 * 3600_000 })))
  return set
}

export interface GoogleIdentity {
  sub: string
  email: string
  name: string
  picture: string | null
  hd: string | null
}

/** Only loopback redirects are valid for an installed-app OAuth client. */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri)
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
  } catch {
    return false
  }
}

/** Exchanges an authorization code (PKCE) for tokens at Google's token endpoint and returns the ID token. */
export async function exchangeCode(
  ctx: Ctx,
  p: { code: string; codeVerifier: string; redirectUri: string },
): Promise<string> {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_URL } = ctx.config
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new HttpError(503, 'google_not_configured', 'Google sign-in is not configured')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    code_verifier: p.codeVerifier,
    redirect_uri: p.redirectUri,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
  })
  let res: Response
  try {
    res = await ctx.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new HttpError(502, 'google_unreachable', 'could not reach Google')
  }
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string }
  if (!res.ok || !json.id_token) {
    // Google's error code (e.g. invalid_grant) carries no secret.
    throw new HttpError(401, 'google_exchange_failed', `Google rejected the code${json.error ? `: ${json.error}` : ''}`)
  }
  return json.id_token
}

export async function verifyIdToken(ctx: Ctx, idToken: string, audience = ctx.config.GOOGLE_CLIENT_ID): Promise<GoogleIdentity> {
  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(idToken, jwks(ctx.config.GOOGLE_JWKS_URL), {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience,
      clockTolerance: 60,
      currentDate: new Date(ctx.now()),
    }))
  } catch {
    throw new HttpError(401, 'invalid_id_token', 'ID token verification failed')
  }
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
  const verified = payload.email_verified === true || payload.email_verified === 'true'
  if (!email || !verified) throw new HttpError(401, 'email_not_verified', 'Google account email is not verified')
  return {
    sub: String(payload.sub),
    email,
    name: typeof payload.name === 'string' ? payload.name : email.split('@')[0],
    picture: typeof payload.picture === 'string' ? payload.picture : null,
    hd: typeof payload.hd === 'string' ? payload.hd : null,
  }
}
