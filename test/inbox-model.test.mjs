import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createConversationKey } from '../lib/inbox/conversation-key.js'
import { deserializeInboundEnvelope, serializeInboundEnvelope } from '../lib/inbox/codec.js'
import { findConversationRoute, outboundTargetFor } from '../lib/inbox/routing.js'
import { memoryScopeForRoute } from '../lib/inbox/memory-scope.js'
import {
  asBatchId, asConversationKey, asExternalAttachmentId, asExternalEventId,
  asExternalMessageId, asMemoryScopeId, asRouteId, asSessionId,
} from '../lib/inbox/ids.js'

function makeEnvelope(overrides = {}) {
  const source = {
    platform: 'mattermost', accountId: 'bot-a', channelConfigId: 'cfg-a',
    conversationType: 'thread', conversationId: 'channel-a', threadRootId: 'root-a',
  }
  return {
    platform: source.platform,
    accountId: source.accountId,
    channelConfigId: source.channelConfigId,
    externalEventId: asExternalEventId('event-1'),
    externalMessageId: asExternalMessageId('post-1'),
    conversationType: source.conversationType,
    conversationId: source.conversationId,
    conversationKey: createConversationKey(source),
    channelId: 'channel-a',
    threadRootId: 'root-a',
    actorId: 'user-a',
    actorName: 'A User',
    text: 'hello',
    mentions: ['bot'],
    isBotMentioned: true,
    isBotMessage: false,
    attachments: [{ externalAttachmentId: asExternalAttachmentId('file-1'), fileName: 'notes.txt', contentType: 'text/plain', sizeBytes: 12 }],
    platformTimestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_100,
    ...overrides,
  }
}

function makeRoute(key, overrides = {}) {
  return {
    id: asRouteId(`route-${key}`), companionId: 'companion-a', conversationKey: asConversationKey(key),
    platform: 'mattermost', conversationType: 'thread', channelConfigId: 'cfg-a', accountId: 'bot-a',
    externalConversationId: 'channel-a', channelId: 'channel-a', threadRootId: 'root-a',
    sessionId: asSessionId(`session-${key}`), memoryScopeId: asMemoryScopeId(`scope-${key}`),
    memorySharingMode: 'isolated', lastMessageAt: 1, createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

test('InboundEnvelope serializes and restores platform, thread, attachment and routing metadata', () => {
  const envelope = makeEnvelope({ replyContextToken: 'private-routing-context', rawEventVersion: 'edit-2' })
  const restored = deserializeInboundEnvelope(serializeInboundEnvelope(envelope))
  assert.deepEqual(restored, envelope)
  assert.equal(restored.threadRootId, 'root-a')
  assert.equal(restored.attachments[0].externalAttachmentId, 'file-1')
  assert.equal(restored.replyContextToken, 'private-routing-context')
})

test('InboundEnvelope decoder rejects inconsistent source keys and malformed fields', () => {
  assert.throws(() => deserializeInboundEnvelope(JSON.stringify(makeEnvelope({ conversationKey: asConversationKey('wrong') }))), /conversationKey/)
  assert.throws(() => deserializeInboundEnvelope(JSON.stringify(makeEnvelope({ mentions: 'bot' }))), /mentions/)
  assert.throws(() => deserializeInboundEnvelope(JSON.stringify(makeEnvelope({ threadRootId: undefined }))), /threadRootId/)
})

test('ConversationKey is stable, uses source IDs, separates account/config and thread root', () => {
  const base = { platform: 'mattermost', accountId: 'bot-a', channelConfigId: 'cfg-a', conversationType: 'thread', conversationId: 'channel-a', threadRootId: 'root-a' }
  const first = createConversationKey(base)
  assert.equal(first, createConversationKey({ ...base }))
  assert.notEqual(first, createConversationKey({ ...base, threadRootId: 'root-b' }))
  assert.notEqual(first, createConversationKey({ ...base, channelConfigId: 'cfg-b' }))
  assert.notEqual(first, createConversationKey({ ...base, accountId: 'bot-b' }))
  assert.throws(() => createConversationKey({ ...base, threadRootId: undefined }), /threadRootId/)
})

test('OutboundTarget preserves WeChat, Mattermost DM peer and original thread root', () => {
  const weixin = makeEnvelope({
    platform: 'weixin', accountId: 'wx-bot', channelConfigId: 'wx-cfg', conversationType: 'dm',
    conversationId: 'wx-user', conversationKey: createConversationKey({ platform: 'weixin', accountId: 'wx-bot', channelConfigId: 'wx-cfg', conversationType: 'dm', conversationId: 'wx-user' }),
    channelId: undefined, threadRootId: undefined, replyContextToken: 'wx-context',
  })
  assert.deepEqual(outboundTargetFor(weixin), { platform: 'weixin', channelConfigId: 'wx-cfg', toUserId: 'wx-user', contextToken: 'wx-context' })

  const dm = makeEnvelope({ conversationType: 'dm', conversationId: 'dm-channel', threadRootId: undefined, channelId: 'dm-channel' })
  assert.deepEqual(outboundTargetFor(dm), { platform: 'mattermost', channelConfigId: 'cfg-a', channelId: 'dm-channel', conversationType: 'dm', directUserId: 'user-a' })

  assert.deepEqual(outboundTargetFor(makeEnvelope()), { platform: 'mattermost', channelConfigId: 'cfg-a', channelId: 'channel-a', conversationType: 'thread', rootId: 'root-a' })
  const channelPost = makeEnvelope({ conversationType: 'channel', threadRootId: undefined })
  assert.equal(outboundTargetFor(channelPost).rootId, 'post-1')
})

test('Session route lookup is exact by ConversationKey and detects duplicate persisted routes', () => {
  const first = makeRoute('conversation-a')
  const second = makeRoute('conversation-b', { sessionId: asSessionId('session-b'), threadRootId: 'root-b' })
  assert.equal(findConversationRoute([first, second], first.conversationKey), first)
  assert.equal(findConversationRoute([first, second], second.conversationKey), second)
  assert.equal(findConversationRoute([first, second], asConversationKey('missing')), undefined)
  assert.throws(() => findConversationRoute([first, first], first.conversationKey), /duplicate route/)
})

test('Memory scope is isolated by default and shared only by explicit channel or companion mode', () => {
  const first = makeRoute('conversation-a')
  const second = makeRoute('conversation-b', { threadRootId: 'root-b' })
  assert.notEqual(memoryScopeForRoute(first), memoryScopeForRoute(second))
  assert.equal(memoryScopeForRoute(first, 'channel'), memoryScopeForRoute(second, 'channel'))
  assert.equal(memoryScopeForRoute(first, 'companion'), memoryScopeForRoute(second, 'companion'))
  assert.notEqual(memoryScopeForRoute(first, 'channel'), memoryScopeForRoute({ ...first, channelConfigId: 'cfg-b' }, 'channel'))
})

test('Inbox SQL migration creates constrained tables and fully rolls back for a fresh rerun', () => {
  const up = readFileSync(new URL('../src/inbox/migrations/001-inbox-schema.up.sql', import.meta.url), 'utf8')
  const down = readFileSync(new URL('../src/inbox/migrations/001-inbox-schema.down.sql', import.meta.url), 'utf8')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys = ON')
    for (let cycle = 0; cycle < 2; cycle++) {
      db.exec(up)
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name)
      assert.deepEqual(tables, ['channel_cursors', 'inbox_events', 'message_batches', 'outbound_deliveries'])
      db.prepare(`INSERT INTO message_batches(id, conversation_key, status, event_ids_json, first_received_at, last_received_at, ready_at, created_at, updated_at)
        VALUES (?, ?, 'buffered', '[]', 1, 1, 2, 1, 1)`).run(`batch-${cycle}`, 'ck:v1:test')
      const insertEvent = db.prepare(`INSERT INTO inbox_events(id, channel_config_id, platform, account_id, external_event_id,
        external_message_id, conversation_key, actor_id, payload_json, status, batch_id, received_at)
        VALUES (?, ?, 'mattermost', ?, ?, ?, ?, ?, '{}', 'buffered', ?, 1)`)
      insertEvent.run(`event-${cycle}`, 'cfg', 'account', 'external-event', 'post', 'ck:v1:test', 'actor', `batch-${cycle}`)
      assert.throws(() => insertEvent.run(`event-duplicate-${cycle}`, 'cfg', 'account', 'external-event', 'post-2', 'ck:v1:test', 'actor', `batch-${cycle}`), /UNIQUE constraint failed/)
      assert.throws(() => db.prepare(`INSERT INTO channel_cursors(channel_config_id, platform, cursor_type, cursor_json, updated_at)
        VALUES ('bad', 'mattermost', 'unsupported', '{}', 1)`).run(), /CHECK constraint failed/)
      db.exec(down)
      assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('inbox_events','message_batches','channel_cursors','outbound_deliveries')").get().count, 0)
    }
  } finally {
    db.close()
  }
})
