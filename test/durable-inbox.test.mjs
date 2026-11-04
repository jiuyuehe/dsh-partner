import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { createConversationKey } from '../lib/inbox/conversation-key.js'
import { DurableInbox } from '../lib/inbox/durable-inbox.js'
import { InboxSqliteProvider } from '../lib/inbox/provider.js'
import { InboxRepository } from '../lib/inbox/repository.js'
import { CursorRepository } from '../lib/inbox/cursor-repository.js'
import { mattermostSinceCursor } from '../lib/inbox/mattermost-cursor.js'
import { mattermostInboxItem } from '../lib/inbox/channel-events.js'
import { ChannelManager } from '../lib/channels/manager.js'
import { WeixinApi } from '../lib/channels/weixin/api.js'
import { DirectTransport } from '../lib/channels/direct/transport.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-durable-inbox-'))
  const resources = []
  const register = resource => resources.push(resource)
  t.after(async () => {
    for (const resource of resources.reverse()) resource.close()
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'channel-inbox.sqlite')
  const inbox = await DurableInbox.open(path)
  register(inbox)
  return { root, path, inbox, register }
}

function cursorWeixin(buffer = 'buffer-1', updatedAt = 200, channelConfigId = 'wx-config') {
  return { channelConfigId, platform: 'weixin', cursorType: 'opaque-buffer', cursorJson: JSON.stringify({ buffer }), updatedAt }
}

function cursorMattermost(highWatermark, updatedAt = 200, channelConfigId = 'mm-config') {
  return { channelConfigId, platform: 'mattermost', cursorType: 'timestamp', cursorJson: JSON.stringify({ sinceMs: highWatermark }), highWatermark, updatedAt }
}

function event(externalEventId, options = {}) {
  const platform = options.platform ?? 'weixin'
  const channelConfigId = options.channelConfigId ?? (platform === 'weixin' ? 'wx-config' : 'mm-config')
  const accountId = options.accountId ?? 'bot-account'
  const conversationId = options.conversationId ?? (platform === 'weixin' ? 'wx-peer' : 'mm-dm-channel')
  const conversationType = 'dm'
  const envelope = {
    platform, accountId, channelConfigId,
    externalEventId, externalMessageId: options.externalMessageId ?? externalEventId,
    conversationType, conversationId,
    conversationKey: createConversationKey({ platform, accountId, channelConfigId, conversationType, conversationId }),
    ...(platform === 'mattermost' ? { channelId: conversationId } : {}),
    actorId: options.actorId ?? 'peer', text: options.text ?? 'hello', mentions: [], isBotMentioned: false,
    isBotMessage: false, attachments: [], platformTimestamp: options.platformTimestamp ?? 100, receivedAt: options.receivedAt ?? 100,
    ...(options.replyContextToken ? { replyContextToken: options.replyContextToken } : {}),
  }
  return envelope
}

test('provider applies schema migration with WAL and reopens the same database', async t => {
  const { path, inbox, register } = await fixture(t)
  inbox.close()
  const provider = await InboxSqliteProvider.open(path)
  register(provider)
  assert.equal(provider.read(db => db.prepare('PRAGMA journal_mode').get().journal_mode), 'wal')
  assert.equal(provider.read(db => db.prepare('PRAGMA user_version').get().user_version), 1)
  assert.ok(provider.read(db => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_events'").get()))
})

test('same event repeated ten times creates one inbox record and one batch', async t => {
  const { path, inbox, register } = await fixture(t)
  const same = event('post-1')
  const result = inbox.events.persistPage(Array.from({ length: 10 }, () => ({ envelope: same })), cursorWeixin())
  assert.deepEqual({ inserted: result.inserted, duplicate: result.duplicate }, { inserted: 1, duplicate: 9 })
  assert.equal(inbox.events.listEvents('ready').length, 1)
  assert.ok(inbox.events.listEvents('ready')[0].batchId)
  assert.equal(inbox.cursors.get('wx-config').cursorJson, JSON.stringify({ buffer: 'buffer-1' }))
  const inspector = await InboxSqliteProvider.open(path)
  register(inspector)
  assert.equal(inspector.read(db => db.prepare('SELECT COUNT(*) AS count FROM message_batches').get().count), 1)
})

test('event page and cursor roll back together if any event or cursor is invalid', async t => {
  const { path, inbox, register } = await fixture(t)
  const valid = event('valid-event')
  const invalid = { ...event('invalid-event'), conversationKey: 'ck:v1:wrong' }
  assert.throws(() => inbox.events.persistPage([{ envelope: valid }, { envelope: invalid }], cursorWeixin()), /conversationKey/)
  assert.equal(inbox.events.listEvents().length, 0)
  assert.equal(inbox.cursors.get('wx-config'), undefined)
  inbox.close()
  const afterRestart = await DurableInbox.open(path)
  register(afterRestart)
  assert.equal(afterRestart.events.listEvents().length, 0)
  assert.equal(afterRestart.cursors.get('wx-config'), undefined)
})

test('timestamp cursor cannot move backwards and rejected cursor leaves its page uncommitted', async t => {
  const { inbox } = await fixture(t)
  inbox.events.persistPage([], cursorMattermost(1_700_000_000_000))
  assert.throws(() => inbox.events.persistPage([{ envelope: event('new-post', { platform: 'mattermost' }) }], cursorMattermost(1_699_999_999_999, 201)), /cannot move backwards/)
  assert.equal(inbox.events.listEvents().length, 0)
  assert.equal(inbox.cursors.get('mm-config').highWatermark, 1_700_000_000_000)
})

test('WeChat buffer and message survive close/reopen as one committed page', async t => {
  const { path, inbox, register } = await fixture(t)
  const message = event('message:42', { replyContextToken: 'route-only-context' })
  inbox.events.persistPage([{ envelope: message }], cursorWeixin('next-buffer'))
  inbox.close()
  const restarted = await DurableInbox.open(path)
  register(restarted)
  assert.deepEqual(JSON.parse(restarted.cursors.get('wx-config').cursorJson), { buffer: 'next-buffer' })
  assert.equal(restarted.events.getEvent('wx-config', 'message:42').payload.replyContextToken, 'route-only-context')
  assert.equal(restarted.events.listEvents('ready').length, 1)
})

test('two workers cannot claim the same batch; expired lease can be reclaimed', async t => {
  const { path, inbox, register } = await fixture(t)
  const provider2 = await InboxSqliteProvider.open(path)
  register(provider2)
  const worker2 = new InboxRepository(provider2)
  inbox.events.persistPage([{ envelope: event('lease-event') }], cursorWeixin())
  const claims = await Promise.all([inbox.events.claimNext('worker-a', 1000, 100), worker2.claimNext('worker-b', 1000, 100)])
  const first = claims.find(Boolean)
  assert.equal(claims.filter(Boolean).length, 1)
  const winner = claims[0] ? inbox.events : worker2
  const other = claims[0] ? worker2 : inbox.events
  const reclaimed = other.claimNext('worker-recovery', 1100, 1000)
  assert.ok(reclaimed)
  assert.equal(reclaimed.batch.id, first.batch.id)
  assert.equal(reclaimed.batch.attemptCount, 2)
  assert.throws(() => winner.settle(first.batch.id, claims[0] ? 'worker-a' : 'worker-b', 1101), /lease/)
  other.settle(reclaimed.batch.id, 'worker-recovery', 1101)
  assert.equal(inbox.events.listEvents('completed').length, 1)
})

test('independent worker threads race to claim one batch and only one wins', async t => {
  const { path, inbox } = await fixture(t)
  inbox.events.persistPage([{ envelope: event('concurrent-claim') }], cursorWeixin())
  const workerUrl = new URL('./helpers/claim-inbox-worker.mjs', import.meta.url)
  const makeWorker = () => new Worker(workerUrl, { workerData: { path } })
  const workers = [makeWorker(), makeWorker()]
  t.after(async () => Promise.all(workers.map(worker => worker.terminate())))
  await Promise.all(workers.map(worker => once(worker, 'online')))
  const results = workers.map(worker => new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
  }))
  for (const worker of workers) worker.postMessage('claim')
  const claims = await Promise.all(results)
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal(claims.filter(claim => claim?.batch?.status === 'processing').length, 1)
})

test('retry delay is honored and exhausted attempts move to diagnosable dead letter', async t => {
  const { inbox } = await fixture(t)
  inbox.events.persistPage([{ envelope: event('failed-event') }], cursorWeixin())
  const first = inbox.events.claimNext('worker', 1000, 1000)
  assert.equal(inbox.events.fail(first.batch.id, 'worker', new Error('send failed Bearer secret token=hidden'), 1001, { maxAttempts: 2, retryDelayMs: 100 }), 'retryable_failed')
  assert.equal(inbox.events.claimNext('worker-2', 1100, 1000), undefined)
  const second = inbox.events.claimNext('worker-2', 1101, 1000)
  assert.equal(second.batch.attemptCount, 2)
  assert.equal(inbox.events.fail(second.batch.id, 'worker-2', new Error('send failed Bearer secret token=hidden'), 1102, { maxAttempts: 2 }), 'dead_letter')
  const [dead] = inbox.events.deadLetters()
  assert.equal(dead.batch.status, 'dead_letter')
  assert.match(dead.batch.lastError, /Bearer \[redacted\]/)
  assert.doesNotMatch(dead.batch.lastError, /secret|hidden/)
  assert.equal(dead.events[0].status, 'dead_letter')
})

test('Mattermost overlap keeps a high watermark while same-time posts deduplicate by post ID', async t => {
  const { inbox } = await fixture(t)
  const high = 1_700_000_000_000
  inbox.events.persistPage([
    { envelope: event('post-a', { platform: 'mattermost', platformTimestamp: high }) },
    { envelope: event('post-b', { platform: 'mattermost', platformTimestamp: high }) },
  ], cursorMattermost(high))
  assert.equal(mattermostSinceCursor(inbox.cursors.get('mm-config')), String(high - 60_000))
  const replay = inbox.events.persistPage([
    { envelope: event('post-a', { platform: 'mattermost', platformTimestamp: high }) },
    { envelope: event('post-c', { platform: 'mattermost', platformTimestamp: high }) },
  ], cursorMattermost(high, 201))
  assert.equal(replay.inserted, 1)
  assert.equal(replay.duplicate, 1)
  assert.equal(inbox.events.listEvents().length, 3)
})

function makeStore(channel, userId, pairings) {
  const state = {
    channels: [channel], companions: [{ id: channel.companionId }], sessions: [], recentReceipts: [],
    pairings: pairings ?? [{ id: 'approved', channelId: channel.id, userId, displayName: userId, status: 'approved', createdAt: 1, updatedAt: 1 }],
  }
  return { snapshot: () => structuredClone(state), update: async change => { change(state); return structuredClone(state) }, isCompanionRemoving: () => false }
}

test('Mattermost auto-discovered DM ID becomes the persisted conversation source', () => {
  const channel = { id: 'mm-config', platform: 'mattermost', accountId: 'mm-bot', direct: { baseUrl: 'http://localhost', targetId: '', peerId: '' } }
  const item = mattermostInboxItem(channel, { id: 'post-1', sender: 'peer', targetId: 'dm-discovered', text: 'hello', timestamp: 10 }, () => false, 20)
  assert.equal(item.status, 'filtered')
  assert.equal(item.envelope.channelId, 'dm-discovered')
  assert.equal(item.envelope.conversationId, 'dm-discovered')
  assert.match(item.envelope.conversationKey, /dm-discovered/)
})

test('WeChat poll resumes stored buffer, deduplicates replay and never starts an Agent in Phase 2', async t => {
  const { path, inbox, register } = await fixture(t)
  const channel = { id: 'wx-config', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot', name: 'wx', enabled: true, createdAt: 1, updatedAt: 1 }
  const store = makeStore(channel, 'wx-peer')
  let agentRuns = 0
  const manager = new ChannelManager({}, store, {}, { reply: async () => { agentRuns++; return { text: 'unexpected', attachments: [] } } }, '.', inbox)
  const buffers = []
  const controller = new AbortController()
  t.mock.method(WeixinApi.prototype, 'getUpdates', async buffer => {
    buffers.push(buffer)
    return { get_updates_buf: 'buffer-1', msgs: [{ message_type: 1, from_user_id: 'wx-peer', message_id: '42', context_token: 'secret-route', item_list: [{ type: 1, text_item: { text: 'hello' } }] }] }
  })
  const persist = inbox.events.persistPage.bind(inbox.events)
  inbox.events.persistPage = (...args) => { const result = persist(...args); controller.abort(); return result }
  await manager.pollLoop(channel, new WeixinApi('https://example.test', 'not-a-real-token'), controller.signal)
  assert.deepEqual(buffers, [''])
  assert.equal(agentRuns, 0)
  assert.equal(inbox.events.listEvents('ready').length, 1)
  assert.deepEqual(JSON.parse(inbox.cursors.get(channel.id).cursorJson), { buffer: 'buffer-1' })

  inbox.close()
  const restarted = await DurableInbox.open(path)
  register(restarted)
  const managerAfterRestart = new ChannelManager({}, store, {}, { reply: async () => { agentRuns++; return { text: 'unexpected', attachments: [] } } }, '.', restarted)
  const restartedController = new AbortController()
  t.mock.method(WeixinApi.prototype, 'getUpdates', async buffer => {
    buffers.push(buffer)
    return { get_updates_buf: 'buffer-2', msgs: [{ message_type: 1, from_user_id: 'wx-peer', message_id: '42', context_token: 'secret-route', item_list: [{ type: 1, text_item: { text: 'hello' } }] }] }
  })
  const persistAfterRestart = restarted.events.persistPage.bind(restarted.events)
  restarted.events.persistPage = (...args) => { const result = persistAfterRestart(...args); restartedController.abort(); return result }
  await managerAfterRestart.pollLoop(channel, new WeixinApi('https://example.test', 'not-a-real-token'), restartedController.signal)
  assert.deepEqual(buffers, ['', 'buffer-1'])
  assert.equal(agentRuns, 0)
  assert.equal(restarted.events.listEvents().length, 1)
  assert.deepEqual(JSON.parse(restarted.cursors.get(channel.id).cursorJson), { buffer: 'buffer-2' })
})

test('WeChat creates a visible pairing request for a filtered contact and logs the received message safely', async t => {
  const { inbox } = await fixture(t)
  const channel = { id: 'wx-config', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot', name: 'wx', enabled: true, createdAt: 1, updatedAt: 1 }
  const store = makeStore(channel, 'wx-peer', [])
  const manager = new ChannelManager({}, store, {}, { reply: async () => { assert.fail('P2 must not start an Agent') } }, '.', inbox)
  const controller = new AbortController()
  const sent = []
  t.mock.method(WeixinApi.prototype, 'getUpdates', async () => ({ get_updates_buf: 'buffer-1', msgs: [{ message_type: 1, from_user_id: 'wx-peer', message_id: 'wx-post-1', context_token: 'secret-context-route', item_list: [{ type: 1, text_item: { text: '查看项目数据' } }] }] }))
  t.mock.method(WeixinApi.prototype, 'sendText', async (...args) => { sent.push(args); controller.abort() })
  const persist = inbox.events.persistPage.bind(inbox.events)
  inbox.events.persistPage = (...args) => persist(...args)
  await manager.pollLoop(channel, new WeixinApi('https://example.test', 'not-a-real-token'), controller.signal)
  const [pairing] = store.snapshot().pairings
  assert.equal(pairing.status, 'pending')
  assert.match(pairing.pairingCode, /^[A-F0-9]{8}$/)
  assert.equal(sent.length, 1)
  assert.match(sent[0][1], new RegExp(pairing.pairingCode))
  const [filtered] = inbox.events.listEvents('filtered')
  assert.equal(filtered.payload.text, '')
  assert.equal(filtered.payload.replyContextToken, undefined)
  const received = manager.channelDiagnostics().find(item => item.phase === 'message-received')
  assert.match(received.textPreview, /查看项目数据/)
  assert.doesNotMatch(JSON.stringify(manager.channelDiagnostics()), /secret-context-route|not-a-real-token/)
})

test('Mattermost auto-discovered DM persists a filtered post, opens pairing, and sends the code to that DM', async t => {
  const { inbox } = await fixture(t)
  const high = 1_700_000_000_000
  inbox.cursors.commit(cursorMattermost(high))
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: '', peerId: '' } }
  const store = makeStore(channel, 'mm-peer', [])
  const manager = new ChannelManager({}, store, {}, { reply: async () => { assert.fail('P2 must not start an Agent') } }, '.', inbox)
  const controller = new AbortController()
  const sent = []
  const transport = {
    poll: async () => ({ cursor: String(high + 100), messages: [{ id: 'mm-post-1', sender: 'mm-peer', targetId: 'verified-dm', text: '检查版本', timestamp: high + 100 }] }),
    forTarget: (targetId, expected) => ({ sendText: async (userId, text) => { sent.push({ targetId, expected, userId, text }) } }),
  }
  const persist = inbox.events.persistPage.bind(inbox.events)
  inbox.events.persistPage = (...args) => { const result = persist(...args); controller.abort(); return result }
  await manager.pollMattermostInbox(channel, transport, controller.signal)
  const [pairing] = store.snapshot().pairings
  assert.equal(pairing.status, 'pending')
  assert.equal(pairing.directTargetId, 'verified-dm')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].targetId, 'verified-dm')
  assert.equal(sent[0].userId, 'mm-peer')
  assert.match(sent[0].text, new RegExp(pairing.pairingCode))
  const [filtered] = inbox.events.listEvents('filtered')
  assert.equal(filtered.payload.text, '')
  assert.equal(filtered.payload.channelId, 'verified-dm')
  assert.equal(inbox.cursors.get(channel.id).highWatermark, high + 100)
  assert.ok(manager.channelDiagnostics().some(item => item.phase === 'pairing-notice-sent' && item.conversationId === 'verified-dm'))
})

test('recent filtered WeChat receipt restores a pending approval after the old P2 inbox gap', async t => {
  const { inbox } = await fixture(t)
  const channel = { id: 'wx-config', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot', name: 'wx', enabled: true, createdAt: 1, updatedAt: 1 }
  const store = makeStore(channel, 'wx-peer', [])
  const envelope = event('message:legacy-filtered', { channelConfigId: channel.id, actorId: 'wx-peer', text: '', receivedAt: Date.now(), isBotMessage: false })
  inbox.events.persistPage([{ envelope, status: 'filtered' }], cursorWeixin('buffer-1', Date.now(), channel.id))
  const manager = new ChannelManager({}, store, {}, {}, '.', inbox)
  await manager.restoreRecentPairingRequests(channel)
  assert.equal(store.snapshot().pairings.length, 1)
  assert.equal(store.snapshot().pairings[0].userId, 'wx-peer')
  assert.equal(store.snapshot().pairings[0].status, 'pending')
  assert.ok(manager.channelDiagnostics().some(item => item.phase === 'pairing-recovered'))
})

test('Mattermost poll bootstraps without history, overlaps after restart, and persists same-time posts without Agent execution', async t => {
  const { path, inbox, register } = await fixture(t)
  const high = 1_700_000_000_000
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: 'dm-channel', peerId: 'mm-peer' } }
  const store = makeStore(channel, 'mm-peer')
  let agentRuns = 0
  const credentials = { read: async () => ({ baseUrl: channel.direct.baseUrl, botToken: 'not-a-real-token' }) }
  const calls = []
  t.mock.method(DirectTransport.prototype, 'poll', async since => {
    calls.push(since)
    return calls.length === 1 ? { cursor: String(high), messages: [] } : { cursor: String(high), messages: [
      { id: 'same-time-old', sender: 'mm-peer', text: 'first', timestamp: high },
      { id: 'same-time-new', sender: 'mm-peer', text: 'second', timestamp: high },
    ] }
  })
  const manager = new ChannelManager({}, store, credentials, { reply: async () => { agentRuns++; return { text: 'unexpected', attachments: [] } } }, '.', inbox)
  const firstController = new AbortController()
  const persist = inbox.events.persistPage.bind(inbox.events)
  inbox.events.persistPage = (...args) => { const result = persist(...args); firstController.abort(); return result }
  await manager.directLoop(channel, firstController.signal)
  assert.deepEqual(calls, [undefined])
  assert.equal(inbox.events.listEvents().length, 0)
  assert.equal(inbox.cursors.get(channel.id).highWatermark, high)

  inbox.close()
  const restarted = await DurableInbox.open(path)
  register(restarted)
  const managerAfterRestart = new ChannelManager({}, store, credentials, { reply: async () => { agentRuns++; return { text: 'unexpected', attachments: [] } } }, '.', restarted)
  const secondController = new AbortController()
  const persistAfterRestart = restarted.events.persistPage.bind(restarted.events)
  restarted.events.persistPage = (...args) => { const result = persistAfterRestart(...args); secondController.abort(); return result }
  await managerAfterRestart.directLoop(channel, secondController.signal)
  assert.deepEqual(calls, [undefined, String(high - 60_000)])
  assert.equal(restarted.events.listEvents('ready').length, 2)
  assert.equal(restarted.cursors.get(channel.id).highWatermark, high)
  assert.equal(agentRuns, 0)
})

test('Mattermost transport sends since overlap to REST and refuses a full page without advancing', async t => {
  const requests = []
  let fullPage = false
  const server = createServer((req, res) => {
    requests.push(req.url)
    const send = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.url === '/api/v4/users/me') return send({ id: 'mm-bot' })
    if (req.url === '/api/v4/channels/dm') return send({ type: 'D' })
    if (req.url.startsWith('/api/v4/channels/dm/members')) return send([{ user_id: 'mm-bot' }, { user_id: 'mm-peer' }])
    if (req.url.startsWith('/api/v4/channels/dm/posts?')) {
      const count = fullPage ? 200 : 2
      const order = Array.from({ length: count }, (_, i) => `post-${i}`)
      const posts = Object.fromEntries(order.map((id, i) => [id, { id, user_id: 'mm-peer', message: id, create_at: 1_700_000_000_000 }]))
      return send({ order, posts })
    }
    res.writeHead(404); res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address()
  const api = new DirectTransport({ platform: 'mattermost', baseUrl: `http://127.0.0.1:${address.port}`, targetId: 'dm' }, 'token', { accountId: 'mm-bot', peerId: 'mm-peer' })
  t.after(() => api.close())
  const since = String(1_700_000_000_000 - 60_000)
  const batch = await api.poll(since, new AbortController().signal, 0)
  assert.equal(new URL(requests.find(url => url.startsWith('/api/v4/channels/dm/posts?')), 'http://localhost').searchParams.get('since'), since)
  assert.deepEqual(batch.messages.map(item => item.id), ['post-0', 'post-1'])
  fullPage = true
  await assert.rejects(api.poll(since, new AbortController().signal, 0), /超出单批上限/)
})

test('Mattermost poll failure, including a full page, leaves the durable cursor unchanged', async t => {
  const { inbox } = await fixture(t)
  const high = 1_700_000_000_000
  inbox.cursors.commit(cursorMattermost(high))
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: 'dm-channel', peerId: 'mm-peer' } }
  const manager = new ChannelManager({}, makeStore(channel, 'mm-peer'), { read: async () => ({ baseUrl: channel.direct.baseUrl, botToken: 'not-a-real-token' }) }, { reply: async () => ({ text: '', attachments: [] }) }, '.', inbox)
  const controller = new AbortController()
  const failingTransport = { poll: async () => {
    setTimeout(() => controller.abort(), 20)
    throw new Error('Mattermost 消息积压超出单批上限，已暂停以免遗漏')
  } }
  await manager.pollMattermostInbox(channel, failingTransport, controller.signal)
  assert.equal(inbox.cursors.get(channel.id).highWatermark, high)
  assert.equal(inbox.events.listEvents().length, 0)
})
