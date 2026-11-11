import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { redactUrl } from '../src/app'
import { withTx } from '../src/db'
import { api, devLogin, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, mockGoogle, setup, type TestEnv } from './helpers'

let t: TestEnv
let google: Awaited<ReturnType<typeof mockGoogle>>

const exchangeBody = (over: Record<string, unknown> = {}) => ({
  code: 'good-code',
  codeVerifier: 'v'.repeat(64),
  redirectUri: 'http://127.0.0.1:53682/callback',
  device: { name: 'Work PC', platform: 'win32' },
  ...over,
})

before(async () => {
  google = await mockGoogle()
  t = await setup({
    GOOGLE_CLIENT_ID,
    GOOGLE_WEB_CLIENT_ID: 'web-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET,
    GOOGLE_TOKEN_URL: `${google.url}/token`,
    GOOGLE_JWKS_URL: `${google.url}/jwks`,
    ALLOWED_EMAIL_DOMAINS: 'velesagro.pl,example.com',
    BOOTSTRAP_ADMIN_EMAILS: 'boss@velesagro.pl, second@velesagro.pl',
  })
  t.clock.now = Date.now()
})
after(async () => {
  await t.close()
  await google.close()
})

describe('Google desktop sign-in', () => {
  test('config exposes the client id only', async () => {
    const r = await api(t, null, 'GET', '/api/auth/google/config')
    assert.deepEqual(r.body, { clientId: GOOGLE_CLIENT_ID, webClientId: 'web-client.apps.googleusercontent.com', devAuth: true })
  })

  test('exchange: verifies the ID token, registers user and device; bootstrap admin owns the default workspace', async () => {
    google.state.claims = { sub: 'g-boss', email: 'boss@velesagro.pl', name: 'Boss' }
    const r = await api(t, null, 'POST', '/api/auth/google/exchange', exchangeBody())
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.match(r.body.deviceToken, /^dfd_/)
    assert.equal(r.body.user.email, 'boss@velesagro.pl')
    assert.equal(r.body.device.name, 'Work PC')
    // PKCE verifier and loopback redirect are forwarded to Google with the secret
    assert.equal(google.state.lastForm!.get('code_verifier'), 'v'.repeat(64))
    assert.equal(google.state.lastForm!.get('redirect_uri'), 'http://127.0.0.1:53682/callback')
    const token = r.body.deviceToken
    const stored = await t.db.query(`SELECT token_hash FROM devices WHERE id = $1`, [r.body.device.id])
    assert.notEqual(stored.rows[0].token_hash, token, 'token stored hashed')
    assert.equal(stored.rows[0].token_hash.length, 64)
    const me = await t.app.inject({ url: '/api/me', headers: { authorization: `Bearer ${token}` } })
    assert.equal(me.json().workspaces[0].role, 'owner')

    // second bootstrap admin (comma-separated list) joins the same default workspace as owner
    google.state.claims = { sub: 'g-second', email: 'second@velesagro.pl' }
    const r2 = await api(t, null, 'POST', '/api/auth/google/exchange', exchangeBody())
    const me2 = await t.app.inject({ url: '/api/me', headers: { authorization: `Bearer ${r2.body.deviceToken}` } })
    assert.equal(me2.json().workspaces[0].id, me.json().workspaces[0].id)
    assert.equal(me2.json().workspaces[0].role, 'owner')
  })

  test('rejects a bad code, a non-loopback redirect, an unverified email, a foreign audience and other domains', async () => {
    google.state.claims = { sub: 'g-x', email: 'x@velesagro.pl' }
    assert.equal((await api(t, null, 'POST', '/api/auth/google/exchange', exchangeBody({ code: 'bad' }))).status, 401)
    assert.equal((await api(t, null, 'POST', '/api/auth/google/exchange', exchangeBody({ redirectUri: 'https://evil.example/cb' }))).status, 400)
    google.state.claims = { sub: 'g-x', email: 'x@velesagro.pl', email_verified: false }
    assert.equal((await api(t, null, 'POST', '/api/auth/google/exchange', exchangeBody())).body.error, 'email_not_verified')
    google.state.claims = { sub: 'g-x', email: 'x@velesagro.pl' }
    google.state.audience = 'someone-else'
    assert.equal((await api(t, null, 'POST', '/api/auth/google/exchange', exchangeBody())).body.error, 'invalid_id_token')
    google.state.audience = GOOGLE_CLIENT_ID
    google.state.claims = { sub: 'g-y', email: 'y@gmail.com' }
    assert.equal((await api(t, null, 'POST', '/api/auth/google/exchange', exchangeBody())).status, 403)
    // non-bootstrap user: signed in, no workspace
    google.state.claims = { sub: 'g-z', email: 'z@velesagro.pl' }
    const ok = await api(t, null, 'POST', '/api/auth/google/exchange', exchangeBody())
    assert.equal(ok.status, 200)
    const me = await t.app.inject({ url: '/api/me', headers: { authorization: `Bearer ${ok.body.deviceToken}` } })
    assert.deepEqual(me.json().workspaces, [])
  })
})

test('browser Google sign-in verifies the web audience and creates a cookie session', async () => {
  const audience = 'web-client.apps.googleusercontent.com'
  const claims = { sub: 'g-browser', email: 'browser@velesagro.pl', name: 'Browser User' }
  const wrong = await google.idToken(claims, GOOGLE_CLIENT_ID)
  assert.equal((await api(t, null, 'POST', '/api/auth/google/web', { credential: wrong })).status, 401)
  const credential = await google.idToken(claims, audience)
  const signed = await api(t, null, 'POST', '/api/auth/google/web', { credential })
  assert.equal(signed.status, 200, JSON.stringify(signed.body))
  const cookie = String(signed.headers['set-cookie']).split(';')[0]
  assert.match(String(signed.headers['set-cookie']), /HttpOnly/)
  const me = await t.app.inject({ url: '/api/me', headers: { cookie } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().user.email, claims.email)
  assert.equal(me.json().via, 'session')
  // signing in again reuses the browser device instead of adding one per sign-in
  const again = await api(t, null, 'POST', '/api/auth/google/web', { credential })
  assert.equal(again.status, 200)
  const web = await t.db.query(`SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id WHERE u.email = $1 AND d.platform = 'web'`, [claims.email])
  assert.equal(web.rowCount, 1)
  const first = await t.app.inject({ url: '/api/me', headers: { cookie } })
  assert.equal(first.statusCode, 200, 'the earlier browser session stays valid')
})

test('migration 005 keeps one web device per user and moves references to it', async () => {
  const pc = await devLogin(t, 'dupes@velesagro.pl', 'Mac')
  const web = async (seenMinutesAgo: number, revoked = false) => (await t.db.query<{ id: string }>(
    `INSERT INTO devices(user_id, name, platform, token_hash, last_seen_at, revoked_at)
     VALUES ($1, 'Web Dashboard', 'web', gen_random_uuid()::text, now() - $2 * interval '1 minute', CASE WHEN $3 THEN now() END)
     RETURNING id`, [pc.userId, seenMinutesAgo, revoked])).rows[0].id
  const revokedNewest = await web(0, true)
  const kept = await web(5)
  const referenced = await web(10)
  const plain = await web(20)
  await t.db.query(
    `INSERT INTO card_projects(id, card_id, project_id, user_id, device_id, hlc, server_seq)
     VALUES ('dupe-ref', gen_random_uuid(), gen_random_uuid(), $1, $2, '0', 0)`, [pc.userId, referenced])
  const sql = readFileSync(join(import.meta.dirname, '..', 'migrations', '005_dedupe_web_devices.sql'), 'utf8')
  await withTx(t.db, (tx) => tx.query(sql))
  const left = await t.db.query(`SELECT id, platform FROM devices WHERE user_id = $1 ORDER BY platform`, [pc.userId])
  assert.deepEqual(left.rows.map((r) => r.id), [pc.deviceId, kept])
  assert.ok(![revokedNewest, referenced, plain].some((id) => left.rows.some((r) => r.id === id)))
  const ref = await t.db.query(`SELECT device_id FROM card_projects WHERE id = 'dupe-ref'`)
  assert.equal(ref.rows[0].device_id, kept)
  await t.db.query(`DELETE FROM card_projects WHERE id = 'dupe-ref'`)
})

describe('web link, session cookie and revocation', () => {
  test('one-time code → HttpOnly SameSite=Strict cookie; second use fails; revoking the device ends the session', async () => {
    const d = await devLogin(t, 'web@example.com', 'Desktop')
    const link = await api(t, d, 'POST', '/api/auth/web-link')
    assert.equal(link.status, 200)
    assert.match(link.body.url, /^http:\/\/dayflow\.test:8790\/api\/auth\/web-link\//)
    const path = new URL(link.body.url).pathname
    // cookie sessions cannot create web links
    const first = await t.app.inject({ url: path })
    assert.equal(first.statusCode, 302)
    const setCookie = String(first.headers['set-cookie'])
    assert.match(setCookie, /df_session=/)
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Strict/i)
    const cookie = setCookie.split(';')[0]
    assert.equal((await t.app.inject({ url: path })).statusCode, 401, 'code is single-use')

    const me = await t.app.inject({ url: '/api/me', headers: { cookie } })
    assert.equal(me.statusCode, 200)
    assert.equal(me.json().user.email, 'web@example.com')
    assert.equal(me.json().via, 'session')
    // session cookie is not a device credential
    assert.equal((await t.app.inject({ url: '/api/sync/pull', headers: { cookie } })).statusCode, 401)
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/web-link', headers: { cookie } })).statusCode, 401)
    // cross-origin writes with the cookie are refused
    const xo = await t.app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie, origin: 'http://evil.example' }, payload: { name: 'x' } })
    assert.equal(xo.statusCode, 403)

    const rev = await api(t, d, 'DELETE', `/api/devices/${d.deviceId}`)
    assert.equal(rev.status, 200)
    assert.equal((await t.app.inject({ url: '/api/me', headers: d.headers })).statusCode, 401)
    assert.equal((await t.app.inject({ url: '/api/me', headers: { cookie } })).statusCode, 401)
  })

  test('web-link code expires after 60 s', async () => {
    const d = await devLogin(t, 'web2@example.com', 'Desktop')
    const link = await api(t, d, 'POST', '/api/auth/web-link')
    t.clock.now += 61_000
    assert.equal((await t.app.inject({ url: new URL(link.body.url).pathname })).statusCode, 401)
    t.clock.now = Date.now()
  })

  test('a user cannot revoke someone else’s device', async () => {
    const a = await devLogin(t, 'a@example.com')
    const b = await devLogin(t, 'b@example.com')
    assert.equal((await api(t, a, 'DELETE', `/api/devices/${b.deviceId}`)).status, 404)
  })

  test('invites are bound to the invited email', async () => {
    const boss = await devLogin(t, 'boss@velesagro.pl')
    const ws = (await api(t, boss, 'GET', '/api/me')).body.workspaces[0].id
    const inv = await api(t, boss, 'POST', `/api/workspaces/${ws}/invites`, { email: 'invitee@example.com', role: 'viewer' })
    const wrong = await devLogin(t, 'intruder@example.com')
    assert.equal((await api(t, wrong, 'POST', `/api/invites/${inv.body.token}/accept`)).status, 403)
    const right = await devLogin(t, 'invitee@example.com')
    const ok = await api(t, right, 'POST', `/api/invites/${inv.body.token}/accept`)
    assert.equal(ok.status, 200)
    assert.equal((await api(t, right, 'POST', `/api/invites/${inv.body.token}/accept`)).status, 410)
    // a viewer cannot create projects
    assert.equal((await api(t, right, 'POST', `/api/workspaces/${ws}/projects`, { name: 'Nope' })).status, 403)
    const members = await api(t, boss, 'GET', `/api/workspaces/${ws}/members`)
    assert.ok(members.body.members.some((m: any) => m.email === 'invitee@example.com' && m.role === 'viewer'))
  })

  test('logs redact one-time secrets in URLs', () => {
    assert.equal(redactUrl('/api/auth/web-link/abcdef123'), '/api/auth/web-link/[redacted]')
    assert.equal(redactUrl('/api/invites/dfi_xyz/accept'), '/api/invites/[redacted]/accept')
  })
})

describe('dev auth gate', () => {
  test('/api/auth/dev is 404 when DEV_AUTH is off', async () => {
    const prod = await setup({ DEV_AUTH: '0' })
    try {
      const r = await api(prod, null, 'POST', '/api/auth/dev', { email: 'x@example.com', deviceName: 'x' })
      assert.equal(r.status, 404)
      const h = await api(prod, null, 'GET', '/api/health')
      assert.equal(h.body.devAuth, false)
    } finally {
      await prod.close()
    }
  })
})
