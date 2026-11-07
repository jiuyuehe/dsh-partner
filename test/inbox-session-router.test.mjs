import test from 'node:test'
import assert from 'node:assert/strict'
import { InboxSessionRouter } from '../lib/inbox/session-router.js'

function createStore() {
  const state = {
    channels: [
      { id: 'wx-config', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot', enabled: true },
      { id: 'wx-other', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot-2', enabled: true },
      { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', enabled: true },
    ],
    companions: [{ id: 'companion' }],
    sessions: [],
  }
  return {
    snapshot: () => structuredClone(state),
    update: async change => { change(state); return structuredClone(state) },
    isCompanionRemoving: () => false,
  }
}

function identity({ key, platform = 'weixin', channelConfigId = 'wx-config', accountId = 'wx-bot', conversationId }) {
  return {
    conversationKey: key,
    platform,
    conversationType: 'dm',
    channelConfigId,
    accountId,
    conversationId,
    ...(platform === 'mattermost' ? { channelId: conversationId } : {}),
  }
}

test('each account/contact gets a stable isolated Session and CWD across router restart', async () => {
  const store = createStore()
  const companion = store.snapshot().companions[0]
  const firstIdentity = identity({ key: 'wx:bot-a:user-a', conversationId: 'user-a' })
  const first = await new InboxSessionRouter(store, 'D:/dsh-work').ensure(companion, 'wx-config', 'user-a', firstIdentity)
  const sameAfterRestart = await new InboxSessionRouter(store, 'D:/dsh-work').ensure(companion, 'wx-config', 'user-a', firstIdentity)
  const otherContact = await new InboxSessionRouter(store, 'D:/dsh-work').ensure(companion, 'wx-config', 'user-b', identity({ key: 'wx:bot-a:user-b', conversationId: 'user-b' }))
  const sameContactOtherBot = await new InboxSessionRouter(store, 'D:/dsh-work').ensure(companion, 'wx-other', 'user-a', identity({ key: 'wx:bot-b:user-a', channelConfigId: 'wx-other', accountId: 'wx-bot-2', conversationId: 'user-a' }))
  const otherAccount = await new InboxSessionRouter(store, 'D:/dsh-work').ensure(companion, 'mm-config', 'user-a', identity({ key: 'mm:bot-b:dm-a', platform: 'mattermost', channelConfigId: 'mm-config', accountId: 'mm-bot', conversationId: 'dm-a' }))

  assert.equal(sameAfterRestart.id, first.id)
  assert.equal(sameAfterRestart.sessionId, first.sessionId)
  assert.equal(sameAfterRestart.cwd, first.cwd)
  assert.notEqual(otherContact.sessionId, first.sessionId)
  assert.notEqual(otherContact.cwd, first.cwd)
  assert.notEqual(otherContact.memoryScopeId, first.memoryScopeId)
  assert.notEqual(sameContactOtherBot.sessionId, first.sessionId)
  assert.notEqual(sameContactOtherBot.cwd, first.cwd)
  assert.notEqual(sameContactOtherBot.memoryScopeId, first.memoryScopeId)
  assert.notEqual(otherAccount.sessionId, first.sessionId)
  assert.notEqual(otherAccount.memoryScopeId, first.memoryScopeId)
  assert.equal(store.snapshot().sessions.length, 4)
  assert.equal(first.inboxConversationKey, firstIdentity.conversationKey)
})

test('first inbox route leaves the legacy channel Session and its history location untouched', async () => {
  const store = createStore()
  const legacy = {
    id: 'legacy-wechat-route', kind: 'channel', channelId: 'wx-config', userId: 'user-a', companionId: 'companion',
    sessionId: 'legacy-session', cwd: 'D:/old-wechat-session', memoryScopeId: 'wx-config:user-a', lastMessageAt: 10,
    inboundMessageIds: ['old-message'],
  }
  await store.update(state => { state.sessions.push(legacy) })
  const route = await new InboxSessionRouter(store, 'D:/dsh-work').ensure(
    store.snapshot().companions[0], 'wx-config', 'user-a', identity({ key: 'wx:bot-a:user-a', conversationId: 'user-a' }),
  )
  const sessions = store.snapshot().sessions
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions.find(item => item.id === legacy.id), legacy)
  assert.notEqual(route.sessionId, legacy.sessionId)
  assert.notEqual(route.cwd, legacy.cwd)
  assert.equal(route.memoryScopeId, legacy.memoryScopeId)
})

test('a stored conversation key cannot be rebound to a different account, platform, or DM', async () => {
  const store = createStore()
  const companion = store.snapshot().companions[0]
  const router = new InboxSessionRouter(store, 'D:/dsh-work')
  const original = identity({ key: 'stable-key', conversationId: 'user-a' })
  await router.ensure(companion, 'wx-config', 'user-a', original)
  await assert.rejects(router.ensure(companion, 'wx-config', 'user-a', identity({ key: 'stable-key', accountId: 'other-bot', conversationId: 'user-a' })), /渠道配置已变化|会话键与已保存来源不一致/)
  await assert.rejects(router.ensure(companion, 'wx-config', 'user-a', identity({ key: 'stable-key', conversationId: 'user-b' })), /会话键与已保存来源不一致/)
})
