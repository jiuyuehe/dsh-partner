import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerPartnerApi } from '../lib/api.js'

function setup(rejection) {
  let handler
  registerPartnerApi({ register(route) { handler = route.handler; return () => {} } }, '/partner-local/v1', {
    connection: { requestRejection: () => rejection },
  })
  return async () => {
    const req = Object.assign(Readable.from([]), { method: 'GET', url: '/partner-local/v1/health', headers: {} })
    const res = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value }, end(body) { this.body = body } }
    await handler(req, res)
    return res
  }
}

test('partner API stops unauthenticated DSH requests before dispatch', async () => {
  const response = await setup(401)()
  assert.equal(response.statusCode, 401)
  assert.equal(response.body, undefined)
})

test('partner API dispatches requests admitted by DSH Connection', async () => {
  const response = await setup(undefined)()
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, service: 'dsh-partner', schemaVersion: 14 })
})
