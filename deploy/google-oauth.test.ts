import assert from 'node:assert/strict'
import { test } from 'node:test'

function readOrigin(name: string): string {
  const value = process.env[name]
  const url = URL.parse(value ?? '')
  assert.ok(
    url && /^https?:$/.test(url.protocol) && url.origin === value,
    `Set ${name} to an HTTP(S) origin without a trailing slash`,
  )
  return url.origin
}

test('the web origin can start Google OAuth with the expected API callback', async () => {
  const api = readOrigin('SILVERBOX_API_ORIGIN')
  const web = readOrigin('SILVERBOX_WEB_ORIGIN')
  const providers = await fetch(`${api}/auth/providers`, { signal: AbortSignal.timeout(5000) })
  assert.equal(providers.status, 200)
  assert.equal((await providers.json()).google, true, 'Google OAuth is disabled on this API')

  const signIn = await fetch(`${api}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { Origin: web, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'google', callbackURL: `${web}/home` }),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(signIn.status, 200, 'The API did not accept the web sign-in request')
  if (api !== web) {
    assert.equal(signIn.headers.get('access-control-allow-origin'), web)
    assert.equal(signIn.headers.get('access-control-allow-credentials'), 'true')
  }

  const { url, redirect } = await signIn.json()
  const authorize = typeof url === 'string' ? URL.parse(url) : null
  assert.ok(redirect === true && authorize, 'Missing Google authorization redirect')
  assert.equal(authorize.origin, 'https://accounts.google.com')
  assert.equal(authorize.searchParams.get('redirect_uri'), `${api}/api/auth/callback/google`)
  assert.ok(authorize.searchParams.get('state'), 'Missing OAuth state')
})
