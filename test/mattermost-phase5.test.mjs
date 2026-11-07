import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DirectTransport } from '../lib/channels/direct/transport.js'
import { ChannelManager } from '../lib/channels/manager.js'
import { channelReplyAllowed } from '../lib/channels/reply-access.js'
import { mattermostInboxItem } from '../lib/inbox/channel-events.js'
import { createConversationKey } from '../lib/inbox/conversation-key.js'
import { InboxSessionRouter } from '../lib/inbox/session-router.js'

const botId = 'b'.repeat(26)
const channelId = 'c'.repeat(26)
const rootId = 'r'.repeat(26)
const replyId = 's'.repeat(26)
const mentionReplyId = 'm'.repeat(26)
const peerId = 'u'.repeat(26)

async function mattermostServer(t, { posts = [], thread = [] } = {}) {
  const requests = []
  const http = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body })
    const send = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (req.url === '/api/v4/users/me') return send({ id: botId, username: 'ajiu' })
    if (req.url.startsWith(`/api/v4/users/${botId}/channels?`)) return send([
      { id: channelId, name: '研发部', display_name: '研发部', type: 'O' },
      { id: 'd'.repeat(26), name: '私聊', display_name: '私聊', type: 'D' },
      { id: 'e'.repeat(26), name: '已删除', display_name: '已删除', type: 'P', delete_at: 1 },
    ])
    if (req.url === `/api/v4/channels/${channelId}`) return send({ id: channelId, type: 'O' })
    if (req.url === `/api/v4/channels/${channelId}/members/${botId}`) return send({ user_id: botId, channel_id: channelId })
    if (req.url === `/api/v4/channels/${channelId}/members?page=0&per_page=3`) return send([{ user_id: botId }, { user_id: peerId }])
    if (req.url.startsWith(`/api/v4/channels/${channelId}/posts?`)) {
      const value = Object.fromEntries(posts.map(post => [post.id, post]))
      return send({ order: posts.map(post => post.id), posts: value })
    }
    if (req.url?.startsWith(`/api/v4/posts/${rootId}/thread?`)) {
      const url = new URL(req.url, 'http://localhost')
      const perPage = Number(url.searchParams.get('perPage'))
      const ordered = [...thread].sort((left, right) => left.create_at - right.create_at)
      const page = url.searchParams.get('direction') === 'up' ? ordered.reverse().slice(0, perPage) : ordered.slice(0, perPage)
      const value = Object.fromEntries(page.map(post => [post.id, post]))
      return send({ order: page.map(post => post.id), posts: value })
    }
    if (req.url === '/api/v4/posts' && req.method === 'POST') return send({ id: 'z'.repeat(26) })
    return send({ error: 'not found' }, 404)
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections() }))
  return { url: `http://127.0.0.1:${http.address().port}`, requests }
}

test('Mattermost validates bot/channel membership and lists only joined public or private channels', async t => {
  const server = await mattermostServer(t)
  const root = new DirectTransport({ platform: 'mattermost', baseUrl: server.url, targetId: '', allowedChannelIds: [channelId] }, 'test-token', { accountId: botId, peerId: '' })
  t.after(() => root.close())
  assert.deepEqual(await root.validate(), { accountId: botId, peerId: '', username: 'ajiu' })
  assert.deepEqual(await root.mattermostChannels(), [{ id: channelId, name: '研发部', displayName: '研发部', type: 'O' }])
  const room = root.forMattermostChannel(channelId, botId)
  t.after(() => room.close())
  assert.deepEqual(await room.validate(), { accountId: botId, peerId: '', username: 'ajiu' })
  assert.ok(server.requests.some(item => item.path === `/api/v4/channels/${channelId}/members/${botId}`))
  assert.throws(() => root.forMattermostChannel('x'.repeat(26), botId), /未列入允许列表/)
  const noAllowlist = new DirectTransport({ platform: 'mattermost', baseUrl: server.url, targetId: channelId, roomMode: 'mattermost-channel' }, 'test-token')
  await assert.rejects(noAllowlist.validate(), /未列入允许列表/)
})

test('Mattermost legacy channel config can reload its missing channel catalog without changing DM runtime', async t => {
  const server = await mattermostServer(t)
  const state = { channels: [{ id: 'mm-config', platform: 'mattermost', accountId: botId, enabled: true, updatedAt: 1,
    direct: { baseUrl: server.url, targetId: '', peerId: '', allowedChannelIds: [] } }] }
  let stops = 0, starts = 0
  const store = { snapshot: () => structuredClone(state), update: async change => { change(state); return structuredClone(state) } }
  const manager = new ChannelManager({}, store, { read: async () => ({ baseUrl: server.url, botToken: 'test-token' }) }, {}, '/tmp')
  manager.stop = async () => { stops++ }
  manager.start = async () => { starts++ }

  // 复用既有白名单保存请求恢复升级前缺失的目录，且不重启仍在运行的 DM 通道。
  await manager.updateMattermostAllowedChannels('mm-config', [])

  assert.deepEqual(state.channels[0].direct.allowedChannelIds, [])
  assert.deepEqual(state.channels[0].direct.mattermostChannels, [{ id: channelId, name: '研发部', displayName: '研发部', type: 'O' }])
  assert.equal(state.channels[0].direct.botUsername, 'ajiu')
  assert.equal(stops, 0)
  assert.equal(starts, 0)
  assert.ok(server.requests.some(request => request.path === '/api/v4/users/me'))
  assert.ok(server.requests.some(request => request.path.startsWith(`/api/v4/users/${botId}/channels?`)))
})

test('Mattermost reads explicit mentions, keeps thread roots and sends text and progress into the same thread', async t => {
  const posts = [
    { id: rootId, user_id: peerId, channel_id: channelId, message: '@ajiu 请检查', metadata: { mentions: [botId] }, create_at: 100, update_at: 100 },
    { id: replyId, user_id: peerId, channel_id: channelId, message: '继续上一条', root_id: rootId, create_at: 110, update_at: 110 },
    { id: 't'.repeat(26), user_id: peerId, channel_id: channelId, message: '@ajiux 不应触发', create_at: 120, update_at: 120 },
    { id: mentionReplyId, user_id: peerId, channel_id: channelId, message: '@ajiu 补充说明', metadata: { mentions: [botId] }, root_id: rootId, create_at: 130, update_at: 130 },
  ]
  const thread = [
    { id: rootId, user_id: peerId, username: 'xiaom', channel_id: channelId, message: '请检查', create_at: 100 },
    { id: replyId, user_id: botId, username: 'ajiu', channel_id: channelId, message: '处理中', root_id: rootId, create_at: 105 },
    { id: 't'.repeat(26), user_id: peerId, channel_id: 'x'.repeat(26), message: '跨频道内容不应出现', root_id: rootId, create_at: 106 },
  ]
  const server = await mattermostServer(t, { posts, thread })
  const root = new DirectTransport({ platform: 'mattermost', baseUrl: server.url, targetId: '', allowedChannelIds: [channelId] }, 'test-token', { accountId: botId, peerId: '' })
  t.after(() => root.close())
  const room = root.forMattermostChannel(channelId, botId)
  t.after(() => room.close())

  const initial = await room.poll(undefined, new AbortController().signal, 0)
  assert.equal(initial.messages.length, 0)
  const next = await room.poll('99', new AbortController().signal, 0)
  assert.equal(next.messages.length, 2)
  assert.equal(next.messages[0].isBotMentioned, true)
  assert.equal(next.messages[0].id, rootId)
  assert.equal(next.messages[1].rootId, rootId)
  assert.equal(next.messages[1].id, mentionReplyId)
  assert.equal(next.messages[1].isBotMentioned, true)
  assert.ok(next.messages.every(message => message.isBotMentioned))

  const history = await room.readMattermostThread(rootId, new AbortController().signal)
  assert.deepEqual(history.map(post => post.postId), [rootId, replyId])
  assert.equal(history[1].isBot, true)
  const threadRead = server.requests.find(item => item.path.startsWith(`/api/v4/posts/${rootId}/thread?`))
  assert.match(threadRead.path, /perPage=5&direction=up/)

  const threadSender = root.forThread(channelId, rootId, botId, undefined, 'channel')
  t.after(() => threadSender.close())
  await threadSender.sendText(botId, '最终答复', undefined)
  const created = server.requests.find(item => item.path === '/api/v4/posts' && item.method === 'POST')
  assert.equal(JSON.parse(created.body).channel_id, channelId)
  assert.equal(JSON.parse(created.body).root_id, rootId)
  assert.ok(server.requests.every(item => item.authorization === 'Bearer test-token'))

  const progress = threadSender.progress(botId)
  await progress.create('处理中', new AbortController().signal)
  const card = server.requests.filter(item => item.path === '/api/v4/posts' && item.method === 'POST').at(-1)
  assert.equal(JSON.parse(card.body).root_id, rootId)
})

test('Mattermost thread reader returns at most five recent posts and excludes current batch sources', async t => {
  const sourcePostId = 'f'.repeat(26)
  const thread = [
    { id: rootId, user_id: peerId, username: 'xiaom', channel_id: channelId, message: 'root', create_at: 100 },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: index === 5 ? sourcePostId : index.toString(16).padStart(26, '0'),
      user_id: peerId, username: 'xiaom', channel_id: channelId, message: `reply-${index}`, root_id: rootId, create_at: 110 + index,
    })),
  ]
  const server = await mattermostServer(t, { thread })
  const root = new DirectTransport({ platform: 'mattermost', baseUrl: server.url, targetId: '', allowedChannelIds: [channelId] }, 'test-token', { accountId: botId, peerId: '' })
  t.after(() => root.close())
  const room = root.forMattermostChannel(channelId, botId)
  t.after(() => room.close())

  const context = await room.readMattermostThread(rootId, new AbortController().signal, 5, [sourcePostId])
  assert.equal(context.length, 5)
  assert.deepEqual(context.map(post => post.text), ['reply-0', 'reply-1', 'reply-2', 'reply-3', 'reply-4'])
  assert.ok(context.every(post => post.postId !== sourcePostId))
  const threadRead = server.requests.find(item => item.path.startsWith(`/api/v4/posts/${rootId}/thread?`))
  assert.match(threadRead.path, /perPage=6&direction=up/)
  assert.equal(Number(new URL(threadRead.path, 'http://localhost').searchParams.get('perPage')), 6, '服务端仅返回本轮所需历史与待排除来源')
})

test('Mattermost channel polling drops non-mentions and ignores update_at-only thread activity', async t => {
  const post = { id: rootId, user_id: peerId, channel_id: channelId, message: '@ajiu 检查', metadata: { mentions: [botId] }, create_at: 100, update_at: 100, edit_at: 0 }
  const posts = [
    post,
    { id: replyId, user_id: peerId, channel_id: channelId, message: '普通频道消息', create_at: 110, update_at: 110 },
    // 即使机器人自己的帖子错误带有提及元数据，也不能再次进入收件链路。
    { id: 'x'.repeat(26), user_id: botId, channel_id: channelId, message: '@ajiu 收到，正在整理', metadata: { mentions: [botId] }, create_at: 115, update_at: 115 },
  ]
  const server = await mattermostServer(t, { posts })
  const root = new DirectTransport({ platform: 'mattermost', baseUrl: server.url, targetId: '', allowedChannelIds: [channelId] }, 'test-token', { accountId: botId, peerId: '' })
  t.after(() => root.close())
  const room = root.forMattermostChannel(channelId, botId)
  t.after(() => room.close())

  const first = await room.poll('99', new AbortController().signal, 0)
  assert.deepEqual(first.messages.map(message => message.id), [rootId])
  const firstVersion = first.messages[0].contentVersion

  // 新线程回复会修改根帖 update_at；但根帖正文未变，不能作为第二条入站消息。
  post.update_at = 200
  posts[1].update_at = 200
  const threadActivity = await room.poll('100', new AbortController().signal, 0)
  assert.deepEqual(threadActivity.messages.map(message => message.id), [rootId])
  assert.equal(threadActivity.messages[0].contentVersion, firstVersion)
  assert.equal(threadActivity.messages[0].updateAt, 200)

  // 真正编辑正文时生成新的稳定版本，仍允许用户修订已 @机器人的请求。
  post.message = '@ajiu 检查已更新'
  post.update_at = 300
  post.edit_at = 300
  const edited = await room.poll('200', new AbortController().signal, 0)
  assert.equal(edited.messages[0].id, rootId)
  assert.notEqual(edited.messages[0].contentVersion, firstVersion)
})

test('Mattermost channel and thread sources normalize to isolated, actor-aware conversation keys', () => {
  const channel = { id: 'mm-config', platform: 'mattermost', accountId: botId, direct: { targetId: '', allowedChannelIds: [channelId] } }
  const approval = new Map([[peerId, { status: 'blocked', allowedChannelIds: [channelId], directTargetId: 'dm-id' }]])
  const access = (userId, targetId, type = 'thread', isChannel = true) => channelReplyAllowed({
    channels: [{ id: 'mm-config', enabled: true, platform: 'mattermost', direct: channel.direct }],
    pairings: [...approval].map(([userId, value]) => ({ channelId: 'mm-config', userId, ...value })),
  }, 'mm-config', userId, targetId, type, isChannel)
  assert.equal(access(peerId, channelId), true)
  assert.equal(access(peerId, 'x'.repeat(26)), false)
  assert.equal(access(peerId, channelId, 'dm', false), false)
  assert.equal(access('v'.repeat(26), channelId), false)

  const base = { id: 'mm-config', platform: 'mattermost', accountId: botId, direct: { targetId: '', allowedChannelIds: [channelId] } }
  const message = { id: rootId, sender: peerId, targetId: channelId, text: '@ajiu 处理', isBotMentioned: true, timestamp: 100 }
  const root = mattermostInboxItem(base, message, () => true, 110, true).envelope
  const followupItem = mattermostInboxItem(base, { ...message, id: replyId, rootId, text: '补充内容', isBotMentioned: false }, () => true, 120, true)
  const followup = followupItem.envelope
  const unrelated = mattermostInboxItem(base, { ...message, id: 't'.repeat(26), isBotMentioned: false }, () => true, 130, true).envelope
  assert.equal(root.conversationType, 'thread')
  assert.equal(root.threadRootId, rootId)
  assert.equal(followup.conversationKey, root.conversationKey)
  assert.equal(followup.actorId, peerId)
  assert.equal(followupItem.status, 'filtered')
  assert.equal(followup.text, '')
  assert.notEqual(unrelated.conversationKey, root.conversationKey)
  assert.equal(unrelated.text, '')

  const original = mattermostInboxItem(base, { ...message, contentVersion: 'content-a' }, () => true, 140, false).envelope
  const threadBump = mattermostInboxItem(base, { ...message, updateAt: 999, contentVersion: 'content-a' }, () => true, 150, false).envelope
  const edited = mattermostInboxItem(base, { ...message, contentVersion: 'content-b' }, () => true, 160, false).envelope
  const ownPost = mattermostInboxItem(base, { ...message, id: 'x'.repeat(26), sender: botId, text: '@ajiu 收到', isBotMentioned: true }, () => true, 170, true)
  assert.equal(threadBump.externalEventId, original.externalEventId)
  assert.notEqual(edited.externalEventId, original.externalEventId)
  assert.equal(ownPost.status, 'filtered')
  assert.equal(ownPost.envelope.text, '')
})

test('Mattermost thread session is shared only within the exact channel, account and root', async () => {
  const state = {
    channels: [{ id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: botId, enabled: true }],
    companions: [{ id: 'companion' }], sessions: [],
  }
  const store = { snapshot: () => structuredClone(state), update: async action => { action(state); return structuredClone(state) }, isCompanionRemoving: () => false }
  const router = new InboxSessionRouter(store, 'D:/dsh-work')
  const identity = root => ({
    conversationKey: createConversationKey({ platform: 'mattermost', accountId: botId, channelConfigId: 'mm-config', conversationType: 'thread', conversationId: channelId, threadRootId: root }),
    platform: 'mattermost', conversationType: 'thread', channelConfigId: 'mm-config', accountId: botId,
    conversationId: channelId, channelId, isChannelConversation: true, threadRootId: root,
  })
  const first = await router.ensure(state.companions[0], 'mm-config', peerId, identity(rootId))
  const collaborator = await router.ensure(state.companions[0], 'mm-config', 'v'.repeat(26), identity(rootId))
  const otherThread = await router.ensure(state.companions[0], 'mm-config', peerId, identity('w'.repeat(26)))
  assert.equal(collaborator.sessionId, first.sessionId)
  assert.equal(collaborator.cwd, first.cwd)
  assert.equal(collaborator.lastActorId, 'v'.repeat(26))
  assert.notEqual(otherThread.sessionId, first.sessionId)
  assert.notEqual(otherThread.memoryScopeId, first.memoryScopeId)
})
