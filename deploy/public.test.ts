import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'

const api = 'https://api.silverbox.perlin.com.br'
const web = 'https://silverbox.perlin.com.br'

test('public domain resolves normally and HTTPS routes are ready', { timeout: 150_000 }, async () => {
  const component = process.env.DEPLOY_COMPONENT
  assert.ok(component === 'api' || component === 'web')
  let lastError: unknown
  // Allow certificate issuance after the container health check becomes healthy.
  for (let attempt = 0; attempt < 18; attempt++) {
    try {
      if (component === 'api') {
        const health = await fetch(api + '/health/ready', { signal: AbortSignal.timeout(5000) })
        assert.equal(health.status, 200)
        const docs = await fetch(api + '/docs.json', { signal: AbortSignal.timeout(5000) })
        assert.equal(docs.status, 200)
        const spec = await docs.json()
        assert.ok(spec.paths['/users/me'])
        assert.ok(spec.paths['/files'])
        for (const origin of [web, 'http://localhost:5173', 'https://preview.example']) {
        const preflight = await fetch(api + '/files', {
          method: 'OPTIONS', signal: AbortSignal.timeout(5000),
          headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-file-name,x-file-size,x-file-mime,x-folder-id' },
        })
        assert.equal(preflight.status, 204)
        assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
        assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true')
        assert.match(preflight.headers.get('vary') ?? '', /Origin/)
        assert.equal((await fetch(api + '/users/me', { headers: { Origin: origin } })).status, 401)
        }
      } else {
        const page = await fetch(web + '/login', { signal: AbortSignal.timeout(5000) })
        assert.equal(page.status, 200)
        assert.match(await page.text(), /<title>Silverbox/)
        const config = await fetch(web + '/runtime-config.js', { signal: AbortSignal.timeout(5000) })
        assert.equal(config.status, 200)
        assert.match(await config.text(), /https:\/\/api\.silverbox\.perlin\.com\.br/)
      }
      return
    } catch (error) {
      lastError = error
      if (attempt < 17) await setTimeout(5000)
    }
  }
  throw lastError
})
