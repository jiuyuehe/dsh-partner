import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeixinLoginManager } from '../lib/channels/weixin/login.js'
import { WeixinApi } from '../lib/channels/weixin/api.js'
import { connectWeixin } from '../lib/channels/weixin/connect.js'
import { PartnerStore } from '../lib/store.js'
import { Readable } from 'node:stream'
import { registerPartnerApi } from '../lib/api.js'
import { ChannelManager } from '../lib/channels/manager.js'

async function loginFixture(t) {
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(WeixinApi.prototype, 'getQrCode', async () => ({ qrcode: 'private-qr', qrcode_img_content: 'qr-url' }))
  const manager = new WeixinLoginManager()
  const login = await manager.begin('new-companion')
  now += 2000
  return { manager, login, advance: () => { now += 4000 } }
}

test('concurrent QR polls and repeated confirmation persist once without false expiry', async t => {
  const { manager, login } = await loginFixture(t)
  let polls = 0, saves = 0
  t.mock.method(WeixinApi.prototype, 'getQrCodeStatus', async () => {
    polls++
    return { status: 'confirmed', ilink_bot_id: 'bot-new', bot_token: 'secret' }
  })
  const results = await Promise.all([manager.poll(login.id), manager.poll(login.id)])
  assert.equal(polls, 1)
  assert.ok(results.every(r => r.phase === 'confirmed' && !('botToken' in r)))
  const save = async () => { saves++; return { id: 'channel' } }
  await Promise.all([manager.complete(login.id, save), manager.complete(login.id, save)])
  assert.equal((await manager.poll(login.id)).phase, 'confirmed')
  await manager.complete(login.id, save)
  assert.equal(saves, 1)
})

test('temporary timeout retries the same scanned QR; saving failure retains confirmation', async t => {
  const { manager, login, advance } = await loginFixture(t)
  let calls = 0
  t.mock.method(WeixinApi.prototype, 'getQrCodeStatus', async () => {
    if (++calls === 1) throw new DOMException('timeout', 'TimeoutError')
    return { status: 'confirmed', ilink_bot_id: 'bot-new', bot_token: 'secret' }
  })
  assert.equal((await manager.poll(login.id)).phase, 'waiting')
  advance()
  assert.equal((await manager.poll(login.id)).phase, 'confirmed')
  await assert.rejects(manager.complete(login.id, async () => { throw new Error('storage unavailable') }), /storage unavailable/)
  assert.equal(await manager.complete(login.id, async () => 'saved'), 'saved')
})

async function connectionFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'partner-weixin-login-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(dir, 'state.json'))
  const defaultCompanion = store.snapshot().companions[0]
  await store.update(state => state.companions.push({ ...defaultCompanion, id: 'new-companion', name: '新伙伴' }))
  const vault = new Map(), starts = []
  const runtime = { store, credentials: {
    read: async id => vault.get(id), write: async (id, value) => { vault.set(id, value) }, delete: async id => { vault.delete(id) },
  }, channels: { start: async id => { starts.push(id) }, stop: async () => {} } }
  const login = { companionId: 'new-companion', accountId: 'bot-new', botToken: 'secret', baseUrl: 'https://ilinkai.weixin.qq.com' }
  return { runtime, login, vault, starts, defaultCompanion }
}

test('new non-default companion connects; reauthentication preserves channel and contacts', async t => {
  const { runtime, login, vault, starts } = await connectionFixture(t)
  const created = await connectWeixin(login, runtime)
  assert.equal(created.companionId, 'new-companion')
  assert.equal(starts[0], created.id)
  await runtime.store.update(state => state.pairings.push({ id: 'pair', channelId: created.id, userId: 'peer', status: 'approved' }))
  const refreshed = await connectWeixin({ ...login, botToken: 'renewed' }, runtime)
  assert.equal(refreshed.id, created.id)
  assert.equal(runtime.store.snapshot().channels.length, 1)
  assert.equal(runtime.store.snapshot().pairings[0].status, 'approved')
  assert.equal(vault.get(created.id).botToken, 'renewed')
})

test('new companion cannot reuse default companion robot; different robot works', async t => {
  const { runtime, login, defaultCompanion } = await connectionFixture(t)
  await connectWeixin({ ...login, companionId: defaultCompanion.id }, runtime)
  await assert.rejects(connectWeixin(login, runtime), /已绑定其他伙伴/)
  await connectWeixin({ ...login, accountId: 'another-bot' }, runtime)
  assert.equal(runtime.store.snapshot().channels.length, 2)
})

test('legacy duplicates require an explicit target and disabled siblings; preserve contact ownership', async t => {
  const { runtime, login, vault } = await connectionFixture(t)
  const first = await connectWeixin(login, runtime)
  await runtime.store.update(state => {
    state.channels.push({ ...first, id: 'legacy-second', accountId: 'second-bot' })
    state.pairings.push({ id: 'second-contact', channelId: 'legacy-second', userId: 'peer', status: 'approved' })
  })
  await assert.rejects(connectWeixin(login, runtime), /多个历史/)
  const secondLogin = { ...login, channelId: 'legacy-second', accountId: 'second-bot', botToken: 'second-renewed' }
  await assert.rejects(connectWeixin(secondLogin, runtime), /先停用/)
  await runtime.store.update(state => { state.channels.find(c => c.id === first.id).enabled = false })
  const result = await connectWeixin(secondLogin, runtime)
  assert.equal(result.id, 'legacy-second')
  assert.equal(runtime.store.snapshot().channels.length, 2)
  assert.equal(vault.get('legacy-second').botToken, 'second-renewed')
  assert.equal(vault.get(first.id).botToken, 'secret')
  assert.equal(runtime.store.snapshot().pairings[0].channelId, 'legacy-second')
  assert.equal(runtime.store.snapshot().pairings[0].status, 'approved')
  await assert.rejects(connectWeixin({ ...secondLogin, accountId: 'different-bot' }, runtime), /不能将已有联系人授权/)
  await assert.rejects(connectWeixin({ ...secondLogin, channelId: 'missing' }, runtime), /指定微信渠道/)
})

test('QR session retains explicit reauthentication target through confirmation', async t => {
  const { manager, advance } = await loginFixture(t)
  const target = await manager.begin('new-companion', 'legacy-second')
  advance()
  t.mock.method(WeixinApi.prototype, 'getQrCodeStatus', async () => ({ status: 'confirmed', ilink_bot_id: 'second-bot', bot_token: 'secret' }))
  assert.equal((await manager.poll(target.id)).channelId, 'legacy-second')
  assert.equal(manager.consume(target.id).channelId, 'legacy-second')
})

test('startup quarantines enabled legacy duplicates without reading tokens or polling', async t => {
  const { runtime, login } = await connectionFixture(t)
  const first = await connectWeixin(login, runtime)
  await runtime.store.update(state => state.channels.push({ ...first, id: 'duplicate', accountId: 'other-bot' }))
  const manager = new ChannelManager({ logger: { error() {} } }, runtime.store, {
    read: async () => { throw new Error('must not read credentials') }, configured: async () => true,
  }, {}, '/tmp')
  await manager.startEnabled()
  const views = await manager.views()
  assert.ok(views.every(c => c.runtimeStatus === 'error' && /多个微信渠道/.test(c.lastError)))
  await runtime.store.update(state => { state.channels.find(c => c.id === 'duplicate').enabled = false })
  await assert.rejects(manager.setEnabled('duplicate', true), /先停用/)
  assert.equal(runtime.store.snapshot().channels.find(c => c.id === 'duplicate').enabled, false)
})

test('login HTTP route binds channel target and rejects another companion channel', async t => {
  const { runtime, login, defaultCompanion } = await connectionFixture(t)
  const channel = await connectWeixin(login, runtime)
  t.mock.method(WeixinApi.prototype, 'getQrCode', async () => ({ qrcode: 'private', qrcode_img_content: 'qr' }))
  let handler
  registerPartnerApi({ register: route => { handler = route.handler; return () => {} } }, '/api', { ...runtime, connection: { requestRejection: () => undefined }, login: new WeixinLoginManager() })
  const request = async companionId => {
    const req = Object.assign(Readable.from([JSON.stringify({ companionId, channelId: channel.id })]), {
      method: 'POST', url: '/api/weixin/login', headers: { 'x-dsh-partner-request': '1', 'content-type': 'application/json' },
    })
    const res = { setHeader() {}, end(data) { this.body = JSON.parse(data) } }
    await handler(req, res)
    return res
  }
  const accepted = await request(login.companionId)
  assert.equal(accepted.statusCode, 201)
  assert.equal(accepted.body.channelId, channel.id)
  assert.equal((await request(defaultCompanion.id)).statusCode, 404)
})

test('credential write failure creates no channel and can be retried', async t => {
  const { runtime, login } = await connectionFixture(t)
  const write = runtime.credentials.write
  runtime.credentials.write = async () => { throw new Error('credential storage failed') }
  await assert.rejects(connectWeixin(login, runtime), /credential storage failed/)
  assert.equal(runtime.store.snapshot().channels.length, 0)
  runtime.credentials.write = write
  await connectWeixin(login, runtime)
  assert.equal(runtime.store.snapshot().channels.length, 1)
})

test('new companion login HTTP route tolerates concurrent confirmation and response retry', async t => {
  const { runtime } = await connectionFixture(t)
  const { manager, login } = await loginFixture(t)
  t.mock.method(WeixinApi.prototype, 'getQrCodeStatus', async () => ({ status: 'confirmed', ilink_bot_id: 'new-http-bot', bot_token: 'private-token' }))
  let handler
  registerPartnerApi({ register: route => { handler = route.handler; return () => {} } }, '/api', { ...runtime, connection: { requestRejection: () => undefined }, login: manager })
  const request = async () => {
    const req = Object.assign(Readable.from([]), { method: 'GET', url: `/api/weixin/login/${login.id}`, headers: {} })
    const res = { setHeader() {}, end(data) { this.body = JSON.parse(data) } }
    await handler(req, res)
    return res
  }
  const replies = await Promise.all([request(), request(), request()])
  replies.push(await request())
  assert.ok(replies.every(r => r.statusCode === 200 && r.body.channel.companionId === 'new-companion'))
  assert.equal(new Set(replies.map(r => r.body.channel.id)).size, 1)
  assert.equal(runtime.store.snapshot().channels.length, 1)
  assert.ok(!JSON.stringify(replies).includes('private-token'))
})
