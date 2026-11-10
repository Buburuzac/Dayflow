import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emailAllowed } from '../src/auth/auth'

const ctx = (allowed: string[], admins: string[]) =>
  ({ config: { ALLOWED_EMAIL_DOMAINS: allowed, BOOTSTRAP_ADMIN_EMAILS: admins } }) as unknown as Parameters<typeof emailAllowed>[0]

test('emailAllowed: domains, exact addresses and bootstrap admins', () => {
  const c = ctx(['velesagro.pl', 'guest@example.com'], ['i.siverenco@gmail.com'])
  assert.equal(emailAllowed(c, 'max@velesagro.pl'), true)
  assert.equal(emailAllowed(c, 'I.Siverenco@gmail.com'), true) // bootstrap admin, case-insensitive
  assert.equal(emailAllowed(c, 'guest@example.com'), true) // exact address
  assert.equal(emailAllowed(c, 'someone@gmail.com'), false) // the rest of gmail stays out
  assert.equal(emailAllowed(c, 'other@example.com'), false)
  assert.equal(emailAllowed(ctx([], []), 'anyone@anywhere.org'), true) // empty list = open
})
