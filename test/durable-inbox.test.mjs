import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { DEFAULT_INBOX_BATCH_POLICY, MATTERMOST_INBOX_BATCH_POLICY, canAppendEnvelope, coalescedReadyAt, hasSubstantiveMattermostText, renderCoalescedUserText, renderMattermostSteerUserText } from '../lib/inbox/coalescer.js'
import { InboxDispatcher } from '../lib/inbox/dispatcher.js'
import { mattermostInboxItem, weixinInboxItem } from '../lib/inbox/channel-events.js'
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

async function waitUntil(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('timed out waiting for asynchronous inbox state')
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
  const conversationType = options.conversationType ?? 'dm'
  const conversationId = options.conversationId ?? (platform === 'weixin' ? 'wx-peer' : 'mm-dm-channel')
  const threadRootId = options.threadRootId
  const envelope = {
    platform, accountId, channelConfigId,
    externalEventId, externalMessageId: options.externalMessageId ?? externalEventId,
    conversationType, conversationId, ...(threadRootId ? { threadRootId } : {}),
    conversationKey: createConversationKey({ platform, accountId, channelConfigId, conversationType, conversationId, ...(threadRootId ? { threadRootId } : {}) }),
    ...(platform === 'mattermost' ? {
      channelId: options.channelId ?? conversationId,
      ...(options.isChannelConversation === undefined ? {} : { isChannelConversation: options.isChannelConversation }),
    } : {}),
    actorId: options.actorId ?? 'peer', ...(options.actorName ? { actorName: options.actorName } : {}), text: options.text ?? 'hello', mentions: [], isBotMentioned: false,
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
  assert.equal(provider.read(db => db.prepare('PRAGMA user_version').get().user_version), 3)
  assert.ok(provider.read(db => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_events'").get()))
  assert.ok(provider.read(db => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_acknowledgements'").get()))
})

test('coalescer respects quiet and hard windows, isolates speakers, and merges Mattermost with a 5-second quiet window and 15-second cap', () => {
  const first = event('merge-1', { text: '先画一只鹈鹕', receivedAt: 10_000, platformTimestamp: 10_000 })
  const second = event('merge-2', { text: '在湖边骑车', receivedAt: 11_000, platformTimestamp: 11_000 })
  const otherSpeaker = event('merge-3', { text: '换个独立要求', actorId: 'other', receivedAt: 11_100 })
  assert.equal(canAppendEnvelope([first], second, DEFAULT_INBOX_BATCH_POLICY), true)
  assert.equal(canAppendEnvelope([first], otherSpeaker, DEFAULT_INBOX_BATCH_POLICY), false)
  assert.equal(coalescedReadyAt(10_000, 11_000, DEFAULT_INBOX_BATCH_POLICY), 12_200)
  assert.equal(coalescedReadyAt(10_000, 14_000, DEFAULT_INBOX_BATCH_POLICY), 14_000)
  assert.equal(coalescedReadyAt(10_000, 14_500, DEFAULT_INBOX_BATCH_POLICY), 14_000)
  assert.match(renderCoalescedUserText([first, second]), /先画一只鹈鹕[\s\S]*在湖边骑车/)
  assert.equal(renderCoalescedUserText([first]), first.text)

  const threadA = event('thread-a', { platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-a', threadRootId: 'root-a', actorId: 'alice', actorName: 'Alice', text: '先查收件链路', receivedAt: 12_000 })
  const threadB = event('thread-b', { platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-a', threadRootId: 'root-a', actorId: 'bob', actorName: 'Bob', text: '再看错误日志', receivedAt: 12_100 })
  const otherThread = event('thread-c', { platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-a', threadRootId: 'root-b', actorId: 'alice', text: '不同线程', receivedAt: 12_200 })
  assert.equal(canAppendEnvelope([threadA], threadB, DEFAULT_INBOX_BATCH_POLICY), false)
  assert.equal(canAppendEnvelope([threadA], otherThread, DEFAULT_INBOX_BATCH_POLICY), false)
  const threadText = renderCoalescedUserText([threadA, threadB])
  assert.ok(threadText.indexOf('Alice：') < threadText.indexOf('再看错误日志'))
  assert.ok(threadText.indexOf('先查收件链路') < threadText.indexOf('再看错误日志'))
  const sameSpeakerThreadReply = { ...threadB, actorId: 'alice', actorName: 'Alice' }
  assert.equal(canAppendEnvelope([threadA], sameSpeakerThreadReply, MATTERMOST_INBOX_BATCH_POLICY), true)
  assert.equal(MATTERMOST_INBOX_BATCH_POLICY.debounceMs, 5_000)
  assert.equal(MATTERMOST_INBOX_BATCH_POLICY.maxCollectionMs, 15_000)
  assert.equal(coalescedReadyAt(10_000, 10_000, MATTERMOST_INBOX_BATCH_POLICY), 15_000)
  assert.equal(coalescedReadyAt(10_000, 11_000, MATTERMOST_INBOX_BATCH_POLICY), 16_000)
  assert.equal(coalescedReadyAt(10_000, 20_000, MATTERMOST_INBOX_BATCH_POLICY), 25_000)
  assert.equal(coalescedReadyAt(10_000, 24_000, MATTERMOST_INBOX_BATCH_POLICY), 25_000)
})

test('Mattermost substantive task validation strips mentions and requires more than two meaningful characters', () => {
  assert.equal(hasSubstantiveMattermostText('@ajiu'), false)
  assert.equal(hasSubstantiveMattermostText('@ajiu hi'), false)
  assert.equal(hasSubstantiveMattermostText('！？'), false)
  assert.equal(hasSubstantiveMattermostText('@ajiu 你再画'), true)
  assert.equal(hasSubstantiveMattermostText('再来一个'), true)
})

test('Mattermost contextual prompt keeps paired USER/BOT history before the latest task and filters system noise', () => {
  const current = event('current-post', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', actorName: 'xiaom',
    text: '你能看到任务了吗？', platformTimestamp: 20_000,
  })
  current.mattermostContext = [
    { postId: 'old-user', actorId: 'xiaom', actorName: 'xiaom', text: '较早用户消息', timestamp: 1_000, isBot: false },
    { postId: 'bot-answer-old', actorId: 'bot', actorName: 'ajiu', text: '我已经检查过目录。', timestamp: 2_000, isBot: true },
    { postId: 'bot-answer-duplicate', actorId: 'bot', actorName: 'ajiu', text: '我已经检查过目录。', timestamp: 2_100, isBot: true },
    { postId: 'ack-one', actorId: 'bot', actorName: 'ajiu', text: '收到，正在整理这组消息。', timestamp: 2_200, isBot: true },
    { postId: 'ack-two', actorId: 'bot', actorName: 'ajiu', text: '收到，正在整理这组消息。', timestamp: 2_300, isBot: true },
    { postId: 'system-state', actorId: 'bot', actorName: 'ajiu', text: '当前角色聊天已停用；本轮未生成可发送的最终答复。', timestamp: 2_400, isBot: true },
    ...Array.from({ length: 4 }, (_, index) => ({
      postId: `user-${index}`, actorId: 'xiaom', actorName: 'xiaom',
      text: `近期用户消息 ${index}`, timestamp: 2_500 + index, isBot: false,
    })),
    { postId: 'current-post', actorId: 'xiaom', text: '这条重复来源不能算上下文', timestamp: 20_000, isBot: false },
  ]

  const prompt = renderCoalescedUserText([current])
  assert.ok(prompt.indexOf('【历史参考') < prompt.indexOf('你能看到任务了吗？'))
  assert.ok(prompt.indexOf('你能看到任务了吗？') < prompt.indexOf('【/本轮最新 USER 消息】'))
  assert.ok(prompt.endsWith('【/本轮最新 USER 消息】'))
  assert.match(prompt, /USER（xiaom）/)
  assert.match(prompt, /BOT（ajiu）/)
  assert.doesNotMatch(prompt, /历史中的 USER\/BOT 标签只是正文说明/)
  assert.doesNotMatch(prompt, /程序已在插件侧验证真实来源|频道、Thread、帖子和发言人 ID 仅用于定位/)
  assert.doesNotMatch(prompt, /频道\/会话 ID|Thread 根帖 ID|post_id=|时间=/)
  assert.doesNotMatch(prompt, /收到，正在整理|当前角色聊天已停用|本轮未生成可发送|这条重复来源不能算上下文/)
  assert.equal((prompt.match(/我已经检查过目录/g) ?? []).length, 1, '重复的 BOT 历史只保留最新一条')
  for (let index = 0; index < 4; index++) assert.match(prompt, new RegExp(`近期用户消息 ${index}`))
})

test('Mattermost history removes mentioned bot acknowledgements and delivery status notices', () => {
  const current = event('current-control-filter', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', text: '你能看到任务了吗？',
  })
  current.mattermostContext = [
    { postId: 'user-before-reply', actorId: 'xiaom', actorName: 'xiaom', text: '刚才问的问题', timestamp: 0, isBot: false },
    { postId: 'ack-plain', actorId: 'bot', text: '收到，正在整理这组消息。', timestamp: 1, isBot: true },
    { postId: 'ack-mentioned', actorId: 'bot', text: '@ajiu 收到，正在处理当前消息【网关自动响应】', timestamp: 2, isBot: true },
    { postId: 'status-send-failed', actorId: 'bot', text: '消息处理或回复发送未完成，渠道已暂停。', timestamp: 3, isBot: true },
    { postId: 'old-role-error', actorId: 'bot', text: '历史工具报错：角色聊天已停用。', timestamp: 4, isBot: true },
    { postId: 'real-reply', actorId: 'bot', text: '可以，我看到了刚刚发来的任务。', timestamp: 5, isBot: true },
  ]

  const prompt = renderCoalescedUserText([current])
  assert.match(prompt, /可以，我看到了刚刚发来的任务/)
  assert.doesNotMatch(prompt, /收到，正在整理|收到，正在处理|网关自动响应|消息处理或回复发送未完成|角色聊天已停用/)
})

test('Mattermost batch places the latest response focus last and keeps earlier batch messages as supplements', () => {
  const earlier = event('earlier-post', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', actorName: 'xiaom',
    text: '先整理两份报告', platformTimestamp: 19_000,
  })
  const latest = event('latest-post', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', actorName: 'xiaom',
    text: '第二份用表格展示', platformTimestamp: 20_000,
  })
  const prompt = renderCoalescedUserText([earlier, latest])
  assert.ok(prompt.indexOf('先整理两份报告') < prompt.indexOf('第二份用表格展示'))
  assert.ok(prompt.indexOf('第二份用表格展示') < prompt.indexOf('【/本轮最新 USER 消息】'))
  assert.ok(prompt.endsWith('【/本轮最新 USER 消息】'))
  assert.match(prompt, /先整理两份报告/)
  assert.match(prompt, /【同批较早的用户补充】/)
  assert.doesNotMatch(prompt, /post_id=latest-post/)
})

test('mention-only Mattermost wake resolves to the latest substantive USER from the same speaker even after a BOT reply', () => {
  const current = event('mention-wake', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', actorName: 'xiaom',
    text: '@ajiu', isBotMentioned: true, platformTimestamp: 20_000,
  })
  current.mattermostContext = [
    { postId: 'role', actorId: 'xiaom', actorName: 'xiaom', text: '你是个民国的诗人，你喜欢写一些苦情的诗歌', timestamp: 1_000, isBot: false },
    { postId: 'ack', actorId: 'bot', actorName: 'ajiu', text: '收到，正在整理这组消息。', timestamp: 1_100, isBot: true },
    { postId: 'task', actorId: 'xiaom', actorName: 'xiaom', text: '你再歌颂下你的mother', timestamp: 2_000, isBot: false },
    { postId: 'task-answer', actorId: 'bot', actorName: 'ajiu', text: '我来写一首深圳秋诗。', timestamp: 2_100, isBot: true },
    { postId: 'other-speaker-task', actorId: 'bob', actorName: 'bob', text: '帮我查一下发布状态', timestamp: 2_200, isBot: false },
    { postId: 'other-speaker-answer', actorId: 'bot', actorName: 'ajiu', text: '发布状态正常。', timestamp: 2_300, isBot: true },
  ]
  const prompt = renderCoalescedUserText([current])
  assert.ok(prompt.indexOf('你再歌颂下你的mother') < prompt.indexOf('【/本轮最新 USER 消息】'))
  assert.match(prompt, /【本轮最新 USER 消息｜唯一回应焦点】\n你再歌颂下你的mother/)
  assert.ok(prompt.endsWith('【/本轮最新 USER 消息】'))
  assert.doesNotMatch(prompt, /当前唤醒消息|@ajiu/)
  assert.doesNotMatch(prompt, /【本轮实质任务】\n帮我查一下发布状态/)
  assert.doesNotMatch(prompt, /收到，正在整理|post_id=|channel-mm|thread-root/)
})

test('same-speaker adjacent message and pure Mattermost mention become one current task', () => {
  const substantive = event('adjacent-task', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', actorName: 'xiaom',
    text: '你再歌颂下你的mother', platformTimestamp: 19_999,
  })
  const wake = event('adjacent-wake', {
    ...substantive, externalMessageId: 'adjacent-wake', externalEventId: 'adjacent-wake',
    text: '@ajiu', isBotMentioned: true, platformTimestamp: 20_000,
  })
  const prompt = renderCoalescedUserText([substantive, wake])
  assert.match(prompt, /【本轮最新 USER 消息｜唯一回应焦点】\n你再歌颂下你的mother/)
  assert.doesNotMatch(prompt, /当前唤醒消息|@ajiu/)
  assert.equal((prompt.match(/你再歌颂下你的mother/g) ?? []).length, 1)
})

test('Mattermost prompt removes leading wake mentions and pure mention noise from same-batch supplements and history', () => {
  const current = event('mention-clean-current', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', actorName: 'xiaom',
    text: '@ajiu, 你再歌颂下你的mother',
  })
  current.mattermostContext = [
    { postId: 'pure-wake-history', actorId: 'xiaom', actorName: 'xiaom', text: '@ajiu', timestamp: 1_000, isBot: false },
    { postId: 'prior-user', actorId: 'xiaom', actorName: 'xiaom', text: '你是个民国诗人', timestamp: 2_000, isBot: false },
    { postId: 'prior-answer', actorId: 'bot', actorName: 'ajiu', text: '好的。', timestamp: 3_000, isBot: true },
    { postId: 'next-user', actorId: 'xiaom', actorName: 'xiaom', text: '继续写一首', timestamp: 4_000, isBot: false },
    { postId: 'same-answer-again', actorId: 'bot', actorName: 'ajiu', text: '好的。', timestamp: 5_000, isBot: true },
  ]
  const adjacentWake = event('mention-clean-adjacent', {
    ...current, externalMessageId: 'mention-clean-adjacent', externalEventId: 'mention-clean-adjacent', text: '@ajiu',
  })
  const prompt = renderCoalescedUserText([current, adjacentWake])

  assert.match(prompt, /【本轮最新 USER 消息｜唯一回应焦点】\n你再歌颂下你的mother/)
  assert.doesNotMatch(prompt, /@ajiu|当前唤醒消息|pure-wake-history/)
  assert.equal((prompt.match(/BOT（ajiu）：好的。/g) ?? []).length, 2,
    '相邻重复回执去重，但不同 USER 轮次里相同的简短 BOT 回答仍须配对保留')
})

test('self-contained Mattermost task omits unrelated Thread history and removes the verified bot mention', () => {
  const current = event('self-contained-current', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', actorName: 'xiaom',
    text: '请阅读 docs/direct-channels.md 和 docs/dev/phase-5-mattermost.md，列出用途与插件版本。@ajiu',
  })
  current.mattermostContext = [
    { postId: 'old-user', actorId: 'xiaom', actorName: 'xiaom', text: '继续写杨幂的诗', timestamp: 1_000, isBot: false },
    { postId: 'old-bot', actorId: 'bot', actorName: 'ajiu', text: '我在 Asia/Shanghai。', timestamp: 2_000, isBot: true },
  ]
  const prompt = renderCoalescedUserText([current], { botUsername: 'ajiu' })
  assert.doesNotMatch(prompt, /THREAD_HISTORY|历史参考|杨幂|Asia\/Shanghai/)
  assert.doesNotMatch(prompt, /@ajiu|历史中的 USER\/BOT 标签只是正文说明|程序已在插件侧验证真实来源/)
  assert.match(prompt, /【本轮最新 USER 消息｜唯一回应焦点】\n请阅读 docs\/direct-channels\.md 和 docs\/dev\/phase-5-mattermost\.md，列出用途与插件版本。/)
  assert.ok(prompt.endsWith('【/本轮最新 USER 消息】'))
})

test('Mattermost active steer is framed as an update and keeps its current USER text last', () => {
  const followup = event('steer-followup', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', actorName: 'xiaom',
    text: '补充一：用中文表格。@ajiu',
  })
  const prompt = renderMattermostSteerUserText([followup], { botUsername: 'ajiu' })
  assert.match(prompt, /执行中收到的用户更新/)
  assert.match(prompt, /本轮最新 USER 消息/)
  assert.match(prompt, /补充一：用中文表格。/)
  assert.doesNotMatch(prompt, /@ajiu|THREAD_HISTORY|post_id=|channel-mm|thread-root/)
  assert.ok(prompt.endsWith('【/本轮最新 USER 消息】'))
})

test('Mattermost pure mention fallback produces a browser-visible task-focus warning', async t => {
  const { inbox } = await fixture(t)
  const now = Date.now()
  const channelId = 'c'.repeat(26), actorId = 'u'.repeat(26), rootId = 'r'.repeat(26)
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'https://example.test', targetId: '', peerId: '', allowedChannelIds: [channelId] } }
  const pairing = { id: 'approved-channel', channelId: channel.id, userId: actorId, displayName: actorId, status: 'approved', allowedChannelIds: [channelId], createdAt: 1, updatedAt: 1 }
  const store = makeStore(channel, actorId, [pairing])
  const trigger = event('focus-warning', { platform: 'mattermost', channelConfigId: channel.id, accountId: channel.accountId,
    conversationType: 'thread', conversationId: channelId, channelId, threadRootId: rootId, actorId, isChannelConversation: true,
    text: '@ajiu', receivedAt: now, platformTimestamp: now })
  trigger.mattermostContextRounds = 3
  trigger.mattermostContext = [{ postId: 'p'.repeat(26), actorId, text: '你再歌颂下你的mother', timestamp: now - 1_000, isBot: false }]
  inbox.events.persistPage([{ envelope: trigger }], cursorMattermost(now))
  const batch = inbox.events.claimNext('task-focus-test', now + 40_000, 30_000)
  assert.ok(batch)

  const agentInputs = []
  const manager = new ChannelManager({}, store, { read: async () => ({ baseUrl: 'https://example.test', botToken: 'test-only-token' }) }, {
    reply: async (_companion, _channelId, _userId, message) => { agentInputs.push(message); return { text: '我会继续处理这项任务。', attachments: [] } },
  }, '.', inbox)
  t.mock.method(DirectTransport.prototype, 'validate', async () => ({ accountId: 'mm-bot' }))
  t.mock.method(DirectTransport.prototype, 'sendText', async () => {})

  assert.equal(await manager.processInboxBatch(batch, new AbortController().signal), 'completed')
  assert.match(agentInputs[0].text, /【本轮最新 USER 消息｜唯一回应焦点】\n你再歌颂下你的mother/)
  assert.ok(manager.channelDiagnostics().some(item => item.phase === 'task-focus-fallback' && item.level === 'warn'))
})

test('Mattermost history marks a bot answer corrected by the user as an error example', () => {
  const current = event('mention-wake-correction', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-mm', channelId: 'channel-mm',
    threadRootId: 'thread-root', isChannelConversation: true, actorId: 'xiaom', actorName: 'xiaom', text: '@ajiu', isBotMentioned: true,
  })
  current.mattermostContext = [
    { postId: 'ask', actorId: 'xiaom', actorName: 'xiaom', text: '你是个民国的诗人', timestamp: 1_000, isBot: false },
    { postId: 'bad-answer', actorId: 'bot', actorName: 'ajiu', text: '我先来一首无关的深圳秋', timestamp: 2_000, isBot: true },
    { postId: 'correction', actorId: 'xiaom', actorName: 'xiaom', text: '你没有被停用。你记住', timestamp: 3_000, isBot: false },
  ]
  const prompt = renderCoalescedUserText([current])
  assert.match(prompt, /本轮最新 USER 消息[\s\S]*你没有被停用。你记住/)
  assert.match(prompt, /BOT（ajiu；随后用户已纠正，视为错误示例，不要模仿）/)
})

test('WeChat steer requires an explicit supplement marker; an independent request remains queued', async t => {
  const { inbox } = await fixture(t)
  const channel = { id: 'wx-config', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot', name: 'wx', enabled: true, createdAt: 1, updatedAt: 1 }
  const manager = new ChannelManager({}, makeStore(channel, 'wx-peer'), {}, {}, '.', inbox)
  const active = { events: [{ payload: event('active-task', { text: '整理项目结构' }) }] }
  const supplement = { events: [{ payload: event('marked-supplement', { text: '补充：再检查启动日志' }) }] }
  const independent = { events: [{ payload: event('independent-task', { text: '另外帮我写发布说明' }) }] }
  assert.equal(manager.canSteerInboxBatch(active, supplement), true)
  assert.equal(manager.canSteerInboxBatch(active, independent), false)
})

test('Mattermost steers ordinary messages only within the same authorized DM or exact thread source', async t => {
  const { inbox } = await fixture(t)
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: '', peerId: '' } }
  const manager = new ChannelManager({}, makeStore(channel, 'alice'), {}, {}, '.', inbox)
  const dmBatch = payload => ({ events: [{ payload }] })
  const activeDm = event('active-dm', { platform: 'mattermost', conversationId: 'dm-one', channelId: 'dm-one', actorId: 'alice', text: '请检查发布过程' })
  const ordinaryFollowup = event('dm-followup', { platform: 'mattermost', conversationId: 'dm-one', channelId: 'dm-one', actorId: 'alice', text: '另外也看看启动日志' })
  assert.equal(manager.canSteerInboxBatch(dmBatch(activeDm), dmBatch(ordinaryFollowup)), true)
  assert.equal(manager.canSteerInboxBatch(dmBatch(activeDm), dmBatch(event('other-actor', {
    platform: 'mattermost', conversationId: 'dm-one', channelId: 'dm-one', actorId: 'bob', text: '另一个人发言',
  }))), false)
  assert.equal(manager.canSteerInboxBatch(dmBatch(activeDm), dmBatch(event('other-dm', {
    platform: 'mattermost', conversationId: 'dm-two', channelId: 'dm-two', actorId: 'alice', text: '另一个私聊',
  }))), false)
  assert.equal(manager.canSteerInboxBatch(dmBatch(activeDm), dmBatch(event('forged-channel', {
    platform: 'mattermost', conversationId: 'dm-one', channelId: 'dm-other', actorId: 'alice', text: '来源 channel 不一致',
  }))), false)
  assert.equal(manager.canSteerInboxBatch(dmBatch(activeDm), dmBatch(event('other-account', {
    platform: 'mattermost', accountId: 'another-bot', conversationId: 'dm-one', channelId: 'dm-one', actorId: 'alice', text: '另一机器人账号',
  }))), false)
  assert.equal(manager.canSteerInboxBatch(dmBatch(activeDm), dmBatch(event('other-config', {
    platform: 'mattermost', channelConfigId: 'another-config', conversationId: 'dm-one', channelId: 'dm-one', actorId: 'alice', text: '另一渠道配置',
  }))), false)

  const activeThread = event('active-thread', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-one', channelId: 'channel-one',
    threadRootId: 'root-one', isChannelConversation: true, actorId: 'alice', text: '检查这个发布任务',
  })
  const threadFollowup = event('thread-followup', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-one', channelId: 'channel-one',
    threadRootId: 'root-one', isChannelConversation: true, actorId: 'alice', text: '再核对 README',
  })
  assert.equal(manager.canSteerInboxBatch(dmBatch(activeThread), dmBatch(threadFollowup)), true)
  assert.equal(manager.canSteerInboxBatch(dmBatch(activeThread), dmBatch(event('different-thread', {
    platform: 'mattermost', conversationType: 'thread', conversationId: 'channel-one', channelId: 'channel-one',
    threadRootId: 'root-two', isChannelConversation: true, actorId: 'alice', text: '另一条线程',
  }))), false)
})

test('Mattermost active DM followup is sent through native DSH steer with verified source identity', async t => {
  const { inbox } = await fixture(t)
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: '', peerId: '' } }
  const store = makeStore(channel, 'alice', [{ id: 'approved', channelId: channel.id, userId: 'alice', displayName: 'alice', status: 'approved', directTargetId: 'dm-one', createdAt: 1, updatedAt: 1 }])
  const received = []
  const routed = []
  const manager = new ChannelManager({}, store, { read: async () => ({ baseUrl: 'http://localhost', botToken: 'test-token' }) }, {
    steer: async (_companion, channelId, actorId, message) => { received.push({ channelId, actorId, message }); return true },
  }, '.', inbox)
  manager.directTransports.set(channel.id, {
    forTarget: (targetId, identity) => {
      routed.push({ targetId, identity })
      return { validate: async () => {}, close() {} }
    },
  })
  const active = { events: [{ payload: event('active-source', { platform: 'mattermost', accountId: 'mm-bot', conversationId: 'dm-one', channelId: 'dm-one', actorId: 'alice', text: '请检查构建' }) }] }
  const incoming = { events: [{ payload: event('ordinary-followup', { platform: 'mattermost', accountId: 'mm-bot', conversationId: 'dm-one', channelId: 'dm-one', actorId: 'alice', text: '顺便确认版本号' }) }] }
  assert.equal(await manager.steerInboxBatch(active, incoming, new AbortController().signal), true)
  assert.equal(routed[0].targetId, 'dm-one')
  assert.equal(routed[0].identity.accountId, 'mm-bot')
  assert.equal(received.length, 1)
  assert.equal(received[0].channelId, 'mm-config')
  assert.equal(received[0].actorId, 'alice')
  assert.match(received[0].message.text, /顺便确认版本号/)
  assert.doesNotMatch(received[0].message.text, /频道\/会话 ID|post_id=ordinary-followup/)
  assert.equal(received[0].message.inboxConversation.conversationId, 'dm-one')
  await store.update(state => { state.pairings[0].status = 'blocked' })
  assert.equal(await manager.steerInboxBatch(active, incoming, new AbortController().signal), false)
  assert.equal(received.length, 1)
})

test('multiple ordinary Mattermost DM messages from one sender steer the active lane instead of starting FIFO turns', async t => {
  const { inbox } = await fixture(t)
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: '', peerId: '' } }
  const store = makeStore(channel, 'alice', [{ id: 'approved', channelId: channel.id, userId: 'alice', displayName: 'alice', status: 'approved', directTargetId: 'dm-one', createdAt: 1, updatedAt: 1 }])
  const steered = []
  const started = []
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const running = new Promise(resolve => { markStarted = resolve })
  const manager = new ChannelManager({}, store, { read: async () => ({ baseUrl: 'http://localhost', botToken: 'test-token' }) }, {
    steer: async (_companion, _channelId, _actorId, message) => { steered.push(message.text); return true },
  }, '.', inbox)
  manager.directTransports.set(channel.id, {
    forTarget: () => ({ validate: async () => {}, close() {} }),
  })
  const processor = {
    process: async batch => { started.push(batch); markStarted(); await gate; return 'completed' },
    canSteer: manager.canSteerInboxBatch.bind(manager),
    steer: manager.steerInboxBatch.bind(manager),
  }
  const observed = []
  const dispatcher = new InboxDispatcher(inbox.events, processor, item => observed.push(item.kind), { pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1000 })
  const now = Date.now()
  const first = event('active-lane', { platform: 'mattermost', accountId: 'mm-bot', conversationId: 'dm-one', channelId: 'dm-one', actorId: 'alice', text: '请检查当前构建', receivedAt: now - 10_000 })
  const followups = ['顺便也检查启动日志', '再核对一下版本号']
  try {
    inbox.events.persistPage([{ envelope: first }], cursorMattermost(now - 1))
    dispatcher.start()
    await running
    // 同一 Agent 仍运行时逐条发入；每条都必须走 native steer，不能形成后续 FIFO lane。
    for (const [index, text] of followups.entries()) {
      const receivedAt = now + index + 1
      inbox.events.persistPage([{
        envelope: event(`dm-followup-${index + 1}`, {
          platform: 'mattermost', accountId: 'mm-bot', conversationId: 'dm-one', channelId: 'dm-one',
          actorId: 'alice', text, receivedAt,
        }),
      }], cursorMattermost(receivedAt, receivedAt))
      dispatcher.notify()
      await waitUntil(() => steered.length === index + 1)
    }
    assert.equal(steered.length, followups.length)
    followups.forEach((text, index) => {
      assert.match(steered[index], new RegExp(text))
      assert.doesNotMatch(steered[index], /频道\/会话 ID|post_id=dm-followup/)
    })
    assert.equal(started.length, 1)
    release()
    await waitUntil(() => inbox.events.listEvents('completed').length === 3)
    assert.deepEqual(started.map(batch => batch.events[0].payload.text), ['请检查当前构建'])
    assert.equal(inbox.events.pendingCounts().total, 0)
  } finally {
    release()
    await dispatcher.close()
  }
})

test('multiple explicitly mentioned Mattermost channel Thread messages steer the same active Agent lane', async t => {
  const { inbox } = await fixture(t)
  const channelId = 'c'.repeat(26), rootId = 'r'.repeat(26)
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: '', peerId: '', allowedChannelIds: [channelId] } }
  const pairing = { id: 'approved', channelId: channel.id, userId: 'alice', displayName: 'alice', status: 'approved', allowedChannelIds: [channelId], createdAt: 1, updatedAt: 1 }
  const store = makeStore(channel, 'alice', [pairing])
  const steered = []
  const routed = []
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const running = new Promise(resolve => { markStarted = resolve })
  const manager = new ChannelManager({}, store, { read: async () => ({ baseUrl: 'http://localhost', botToken: 'test-token' }) }, {
    steer: async (_companion, _channelId, actorId, message) => { steered.push({ actorId, text: message.text }); return true },
  }, '.', inbox)
  manager.directTransports.set(channel.id, {
    forThread: (targetId, threadRootId, accountId, authorize, mode) => {
      routed.push({ targetId, threadRootId, accountId, mode })
      return { validate: async () => authorize?.(), close() {} }
    },
  })
  const processor = {
    process: async () => { markStarted(); await gate; return 'completed' },
    canSteer: manager.canSteerInboxBatch.bind(manager),
    steer: manager.steerInboxBatch.bind(manager),
  }
  const observed = []
  const dispatcher = new InboxDispatcher(inbox.events, processor, item => observed.push(item.kind), { pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1000 })
  const now = Date.now()
  const withMention = (id, text, receivedAt) => {
    const message = event(id, {
      platform: 'mattermost', accountId: 'mm-bot', conversationType: 'thread', conversationId: channelId,
      channelId, threadRootId: rootId, isChannelConversation: true, actorId: 'alice', text, receivedAt,
    })
    // 频道中的每条续接都必须经过明确 @ 过滤后才能入 Inbox。
    message.isBotMentioned = true
    return message
  }
  try {
    inbox.events.persistPage([{ envelope: withMention('thread-active', '@ajiu 检查发布流程', now - 10_000) }], cursorMattermost(now - 1))
    dispatcher.start()
    await running
    const followups = ['@ajiu 再看一下 README', '@ajiu 最后确认测试命令']
    for (const [index, text] of followups.entries()) {
      const receivedAt = now + index + 1
      inbox.events.persistPage([{ envelope: withMention(`thread-followup-${index + 1}`, text, receivedAt) }], cursorMattermost(receivedAt, receivedAt))
      dispatcher.notify()
      await waitUntil(() => steered.length === index + 1)
    }
    assert.equal(steered.length, followups.length)
    followups.forEach((text, index) => {
      assert.equal(steered[index].actorId, 'alice')
      assert.match(steered[index].text, new RegExp(text.replace(/^@ajiu\s*/u, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.doesNotMatch(steered[index].text, /post_id=|Thread 根帖 ID/)
    })
    assert.equal(routed.length, 2)
    assert.ok(routed.every(route => route.targetId === channelId && route.threadRootId === rootId && route.accountId === 'mm-bot' && route.mode === 'channel'))
    release()
    await waitUntil(() => inbox.events.listEvents('completed').length === 3)
    assert.equal(inbox.events.pendingCounts().total, 0)
    assert.equal(observed.filter(kind => kind === 'steered').length, 2)
  } finally {
    release()
    await dispatcher.close()
  }
})

test('acknowledgement ledger is at-most-once and records an ambiguous send for diagnosis', async t => {
  const { path, inbox, register } = await fixture(t)
  inbox.events.persistPage([{ envelope: event('ack-event') }], cursorWeixin())
  const record = inbox.events.listEvents('ready')[0]
  assert.equal(inbox.events.acknowledgementStatus(record.id), 'pending')
  assert.equal(inbox.events.claimAcknowledgement(record.id, 1000), true)
  assert.equal(inbox.events.claimAcknowledgement(record.id, 1001), false)
  inbox.events.finishAcknowledgement(record.id, 'unknown', new Error('connection lost'), 1002)
  assert.equal(inbox.events.acknowledgementStatus(record.id), 'unknown')
  assert.equal(inbox.events.claimAcknowledgement(record.id, 1003), false)

  const second = event('ack-restart')
  inbox.events.persistPage([{ envelope: second }], cursorWeixin('next', 200, 'wx-config'))
  const pending = inbox.events.listEvents('ready').find(item => item.externalEventId === second.externalEventId)
  assert.equal(inbox.events.claimAcknowledgement(pending.id, Date.now() - 300_000), true)
  inbox.close()
  const restarted = await DurableInbox.open(path)
  register(restarted)
  assert.equal(restarted.events.acknowledgementStatus(pending.id), 'unknown')
  assert.equal(restarted.events.claimAcknowledgement(pending.id), false)
})

test('dispatcher runs one lane per conversation and steered supplements join the leased batch', async t => {
  const { inbox } = await fixture(t)
  const started = []
  const events = []
  let release
  let entered
  const gate = new Promise(resolve => { release = resolve })
  const running = new Promise(resolve => { entered = resolve })
  const processor = {
    process: async batch => { started.push(batch); entered(); await gate; return 'completed' },
    canSteer: () => true,
    steer: async (_active, incoming) => { events.push(incoming.events[0].payload.text); return true },
  }
  const dispatcher = new InboxDispatcher(inbox.events, processor, item => events.push(item.kind), { pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1000 })
  try {
    inbox.events.persistPage([{ envelope: event('lane-first', { text: '原始任务', receivedAt: 100 }) }], cursorWeixin())
    dispatcher.start()
    await running
    inbox.events.persistPage([{ envelope: event('lane-extra', { text: '补充：湖边', receivedAt: 200 }) }], cursorWeixin('next'))
    dispatcher.notify()
    await waitUntil(() => events.includes('补充：湖边'))
    assert.equal(started.length, 1)
    release()
    await waitUntil(() => inbox.events.listEvents('completed').length === 2)
    assert.equal(inbox.events.pendingCounts().total, 0)
    assert.ok(events.includes('steered'))
  } finally {
    release()
    await dispatcher.close()
  }
})

test('steer reservations freeze source batches and accept additions beyond initial collection limit', async t => {
  const { inbox } = await fixture(t)
  const policy = DEFAULT_INBOX_BATCH_POLICY
  const activeItems = Array.from({ length: 8 }, (_, index) => ({ envelope: event(`active-cap-${index}`, {
    actorId: 'alice', conversationId: 'dm-cap', text: `active-${index}`, receivedAt: 1_000 + index * 100,
  }) }))
  inbox.events.persistPage(activeItems, cursorWeixin('active-cap', 3_000), policy)
  const active = inbox.events.claimNext('worker-cap', 5_000, 100_000)
  assert.equal(active.events.length, 8)

  inbox.events.persistPage([{ envelope: event('reserved-source', { actorId: 'alice', conversationId: 'dm-cap', text: 'first supplement', receivedAt: 5_100 }) }], cursorWeixin('source', 5_100), policy)
  const source = inbox.events.nextReadyForConversation(active.batch.conversationKey, 7_000, active.batch.id)
  assert.ok(source)
  assert.equal(inbox.events.reserveReadyBatchForActiveSteer(source.batch.id, active.batch.id, 'worker-cap', 7_000), true)
  assert.equal(inbox.events.getBatch(source.batch.id).events.length, 1)

  // 该时间点仍在原收集静默窗口内；预留中的来源不能再被持久化入口改写。
  inbox.events.persistPage([{ envelope: event('arrived-during-steer', { actorId: 'alice', conversationId: 'dm-cap', text: 'later supplement', receivedAt: 5_500 }) }], cursorWeixin('during-steer', 7_001), policy)
  assert.equal(inbox.events.getBatch(source.batch.id).events.length, 1)
  assert.equal(inbox.events.attachReservedSteerBatch(source.batch.id, active.batch.id, 'worker-cap', 7_002), true)
  const merged = inbox.events.getBatch(active.batch.id)
  assert.equal(merged.events.length, 9)
  assert.ok(merged.events.some(item => item.externalEventId === 'reserved-source'))
  assert.equal(inbox.events.getBatch(source.batch.id), undefined)
  assert.equal(inbox.events.listEvents('ready').some(item => item.externalEventId === 'arrived-during-steer'), true)
})

test('dispatcher waits for an in-flight steer before settling a just-finished Agent turn', async t => {
  const { inbox } = await fixture(t)
  let finishProcess
  let finishSteer
  let markStarted
  const processGate = new Promise(resolve => { finishProcess = resolve })
  const steerGate = new Promise(resolve => { finishSteer = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  const dispatcher = new InboxDispatcher(inbox.events, {
    process: async () => { await processGate; return 'completed' },
    canSteer: () => true,
    steer: async () => { markStarted(); await steerGate; return true },
  }, () => {}, { pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1000 })
  try {
    const now = Date.now()
    inbox.events.persistPage([{ envelope: event('barrier-active', { conversationId: 'barrier-dm', receivedAt: now - 10 }) }], cursorWeixin('barrier-active'))
    dispatcher.start()
    await waitUntil(() => inbox.events.listEvents('processing').length === 1)
    inbox.events.persistPage([{ envelope: event('barrier-steer', { conversationId: 'barrier-dm', receivedAt: now + 1 }) }], cursorWeixin('barrier-steer', now + 1))
    dispatcher.notify()
    await started
    finishProcess()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(inbox.events.listEvents('completed').length, 0)
    assert.equal(inbox.events.listEvents('processing').length, 2)
    finishSteer()
    await waitUntil(() => inbox.events.listEvents('completed').length === 2)
  } finally {
    finishProcess()
    finishSteer()
    await dispatcher.close()
  }
})

test('a rejected WeChat steer releases its reserved source to the normal FIFO lane', async t => {
  const { inbox } = await fixture(t)
  let finishFirst
  let markStarted
  let markSteer
  const firstGate = new Promise(resolve => { finishFirst = resolve })
  const activeStarted = new Promise(resolve => { markStarted = resolve })
  const steerStarted = new Promise(resolve => { markSteer = resolve })
  const turns = []
  const dispatcher = new InboxDispatcher(inbox.events, {
    process: async batch => {
      turns.push(batch.events.map(item => item.payload.text).join('|'))
      if (turns.length === 1) { markStarted(); await firstGate }
      return 'completed'
    },
    canSteer: () => true,
    steer: async () => { markSteer(); return false },
  }, () => {}, { pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1000 })
  try {
    const now = Date.now()
    inbox.events.persistPage([{ envelope: event('reject-active', { conversationId: 'reject-dm', text: 'active', receivedAt: now - 10 }) }], cursorWeixin('reject-active'))
    dispatcher.start()
    await activeStarted
    inbox.events.persistPage([{ envelope: event('reject-source', { conversationId: 'reject-dm', text: 'source remains valid', receivedAt: now + 1 }) }], cursorWeixin('reject-source', now + 1))
    dispatcher.notify()
    await steerStarted
    await waitUntil(() => inbox.events.listEvents('ready').some(item => item.externalEventId === 'reject-source'))
    assert.equal(inbox.events.listEvents('dead_letter').length, 0)
    finishFirst()
    await waitUntil(() => inbox.events.listEvents('completed').length === 2)
    assert.equal(turns.length, 2)
    assert.equal(turns[1], 'source remains valid')
  } finally {
    finishFirst()
    await dispatcher.close()
  }
})

test('an active Mattermost conversation steers immediately without waiting for the quiet window', async t => {
  const { inbox } = await fixture(t)
  let finishFirst
  let markStarted
  let markSteered
  const firstGate = new Promise(resolve => { finishFirst = resolve })
  const activeStarted = new Promise(resolve => { markStarted = resolve })
  const steered = new Promise(resolve => { markSteered = resolve })
  const turns = []
  const dispatcher = new InboxDispatcher(inbox.events, {
    process: async batch => { turns.push(batch.events.map(item => item.payload.text).join('|')); markStarted(); await firstGate; return 'completed' },
    canSteer: () => true,
    steer: async (_active, incoming) => { markSteered(incoming.events[0].payload.text); return true },
  }, () => {}, { pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1_000 })
  try {
    const now = Date.now()
    const oldReceivedAt = now - 20_000
    const active = event('mm-steer-active', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: '正在执行的任务', receivedAt: oldReceivedAt })
    inbox.events.persistPage([{ envelope: active }], cursorMattermost(oldReceivedAt), MATTERMOST_INBOX_BATCH_POLICY)
    dispatcher.start()
    await activeStarted

    const receivedAt = Date.now()
    const followup = event('mm-steer-followup', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: '同一会话里的补充问题', receivedAt })
    inbox.events.persistPage([{ envelope: followup }], cursorMattermost(receivedAt, receivedAt), MATTERMOST_INBOX_BATCH_POLICY)
    dispatcher.notify()

    assert.equal(await Promise.race([steered, new Promise(resolve => setTimeout(() => resolve('timeout'), 1_200))]), '同一会话里的补充问题')
    assert.equal(turns.length, 1, 'supplement must not start a second DSH turn')
    assert.equal(inbox.events.listEvents('processing').length, 2, 'accepted steer is attached to the active durable lease')
    finishFirst()
    await waitUntil(() => inbox.events.listEvents('completed').length === 2)
  } finally {
    finishFirst()
    await dispatcher.close()
  }
})

test('successive Mattermost follow-ups attach to one active DSH turn in source order', async t => {
  const { inbox } = await fixture(t)
  let finishFirst
  let finishFirstSteer
  let markStarted
  let markFirstSteer
  const processGate = new Promise(resolve => { finishFirst = resolve })
  const firstSteerGate = new Promise(resolve => { finishFirstSteer = resolve })
  const activeStarted = new Promise(resolve => { markStarted = resolve })
  const firstSteerStarted = new Promise(resolve => { markFirstSteer = resolve })
  const turns = []
  const steers = []
  const dispatcher = new InboxDispatcher(inbox.events, {
    process: async batch => { turns.push(batch.events.map(item => item.payload.text)); markStarted(); await processGate; return 'completed' },
    canSteer: () => true,
    steer: async (active, incoming) => {
      steers.push({ active: active.events.map(item => item.payload.externalEventId), incoming: incoming.events.map(item => item.payload.externalEventId) })
      if (steers.length === 1) { markFirstSteer(); await firstSteerGate }
      return true
    },
  }, () => {}, { pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1_000 })
  try {
    const now = Date.now()
    const activeAt = now - 31_000
    const active = event('mm-multi-active', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: '先做中的任务', receivedAt: activeAt })
    inbox.events.persistPage([{ envelope: active }], cursorMattermost(activeAt), MATTERMOST_INBOX_BATCH_POLICY)
    dispatcher.start()
    await activeStarted

    const firstAt = Date.now()
    inbox.events.persistPage([{ envelope: event('mm-multi-followup-1', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: '第一条补充', receivedAt: firstAt }) }], cursorMattermost(firstAt, firstAt), MATTERMOST_INBOX_BATCH_POLICY)
    dispatcher.notify()
    await firstSteerStarted

    const secondAt = Date.now()
    inbox.events.persistPage([{ envelope: event('mm-multi-followup-2', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: '第二条补充', receivedAt: secondAt }) }], cursorMattermost(secondAt, secondAt), MATTERMOST_INBOX_BATCH_POLICY)
    dispatcher.notify()
    finishFirstSteer()

    await waitUntil(() => steers.length === 2)
    assert.deepEqual(turns, [['先做中的任务']], 'follow-ups stay in the existing DSH turn')
    assert.deepEqual(steers.map(item => item.incoming), [['mm-multi-followup-1'], ['mm-multi-followup-2']])
    assert.deepEqual(steers[1].active, ['mm-multi-active', 'mm-multi-followup-1'], 'later steer sees the already-linked durable source')
    assert.equal(inbox.events.listEvents('processing').length, 3)

    finishFirst()
    await waitUntil(() => inbox.events.listEvents('completed').length === 3)
  } finally {
    finishFirstSteer()
    finishFirst()
    await dispatcher.close()
  }
})

test('a Mattermost message arriving during finalization is not steered into a finished Agent turn', async t => {
  const { inbox } = await fixture(t)
  const shortTestPolicy = { ...MATTERMOST_INBOX_BATCH_POLICY, debounceMs: 40, maxCollectionMs: 40 }
  let finishFirst
  let finishSteer
  let markStarted
  let markSteer
  const processGate = new Promise(resolve => { finishFirst = resolve })
  const steerGate = new Promise(resolve => { finishSteer = resolve })
  const activeStarted = new Promise(resolve => { markStarted = resolve })
  const steerStarted = new Promise(resolve => { markSteer = resolve })
  const turns = []
  let steerCount = 0
  const dispatcher = new InboxDispatcher(inbox.events, {
    process: async batch => {
      turns.push(batch.events.map(item => item.payload.externalEventId))
      if (turns.length === 1) { markStarted(); await processGate }
      return 'completed'
    },
    canSteer: () => true,
    steer: async () => {
      steerCount++
      if (steerCount === 1) { markSteer(); await steerGate }
      return true
    },
  }, () => {}, { pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1_000 })
  try {
    const now = Date.now()
    const activeAt = now - 1_000
    inbox.events.persistPage([{ envelope: event('mm-finalize-active', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: '当前任务', receivedAt: activeAt }) }], cursorMattermost(activeAt), shortTestPolicy)
    dispatcher.start()
    await activeStarted

    const firstAt = Date.now()
    inbox.events.persistPage([{ envelope: event('mm-finalize-followup-1', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: '正在注入的补充', receivedAt: firstAt }) }], cursorMattermost(firstAt, firstAt), shortTestPolicy)
    dispatcher.notify()
    await steerStarted

    const secondAt = Date.now()
    inbox.events.persistPage([{ envelope: event('mm-finalize-followup-2', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: 'Agent 收尾时到达的消息', receivedAt: secondAt }) }], cursorMattermost(secondAt, secondAt), shortTestPolicy)
    dispatcher.notify()
    finishFirst()
    finishSteer()

    await waitUntil(() => inbox.events.listEvents('completed').length === 3)
    assert.equal(steerCount, 1, 'after the active turn finishes, the next source starts a fresh DSH turn')
    assert.deepEqual(turns, [['mm-finalize-active'], ['mm-finalize-followup-2']])
    assert.equal(inbox.events.listEvents('dead_letter').length, 0)
  } finally {
    finishFirst()
    finishSteer()
    await dispatcher.close()
  }
})

test('a rejected active Mattermost steer is quarantined instead of becoming a FIFO turn', async t => {
  const { inbox } = await fixture(t)
  let finishFirst
  let markStarted
  let markSteer
  const firstGate = new Promise(resolve => { finishFirst = resolve })
  const activeStarted = new Promise(resolve => { markStarted = resolve })
  const steerStarted = new Promise(resolve => { markSteer = resolve })
  const turns = []
  const observed = []
  const dispatcher = new InboxDispatcher(inbox.events, {
    process: async batch => { turns.push(batch.events.map(item => item.payload.text).join('|')); if (turns.length === 1) { markStarted(); await firstGate } return 'completed' },
    canSteer: () => true,
    steer: async () => { markSteer(); return false },
  }, event => observed.push(event), { pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1_000 })
  try {
    const now = Date.now()
    const activeAt = now - 31_000
    const active = event('mm-reject-active', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: '活跃任务', receivedAt: activeAt })
    inbox.events.persistPage([{ envelope: active }], cursorMattermost(activeAt), MATTERMOST_INBOX_BATCH_POLICY)
    dispatcher.start()
    await activeStarted

    const receivedAt = Date.now()
    const source = event('mm-reject-source', { platform: 'mattermost', channelId: 'mm-dm', conversationId: 'mm-dm', actorId: 'alice', text: '活跃期间补充', receivedAt })
    inbox.events.persistPage([{ envelope: source }], cursorMattermost(receivedAt, receivedAt), MATTERMOST_INBOX_BATCH_POLICY)
    dispatcher.notify()
    await steerStarted
    await waitUntil(() => inbox.events.listEvents('dead_letter').some(item => item.externalEventId === 'mm-reject-source'))
    assert.equal(turns.length, 1)
    assert.ok(observed.some(item => item.kind === 'failed' && item.detail.includes('没有转入 FIFO')))

    finishFirst()
    await waitUntil(() => inbox.events.listEvents('completed').length === 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(turns.length, 1, 'rejected Mattermost supplement must not run as a later turn')
    assert.equal(inbox.events.listEvents('dead_letter').length, 1)
  } finally {
    finishFirst()
    await dispatcher.close()
  }
})

test('a blocked conversation does not block another lane and same-conversation batches stay FIFO', async t => {
  const { inbox } = await fixture(t)
  const started = []
  let releaseFirst
  let markFirstStarted
  let markOtherCompleted
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve })
  const otherCompleted = new Promise(resolve => { markOtherCompleted = resolve })
  const dispatcher = new InboxDispatcher(inbox.events, {
    process: async batch => {
      const text = batch.events[0].payload.text
      started.push(text)
      if (text === 'A-1') { markFirstStarted(); await firstGate }
      if (text === 'B-1') markOtherCompleted()
      return 'completed'
    },
  }, () => {}, { maxConcurrentLanes: 2, pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1000 })
  try {
    inbox.events.persistPage([
      { envelope: event('lane-a-1', { actorId: 'contact-a', conversationId: 'contact-a', text: 'A-1', receivedAt: 100 }) },
      { envelope: event('lane-a-2', { actorId: 'contact-a', conversationId: 'contact-a', text: 'A-2', receivedAt: 200 }) },
      { envelope: event('lane-b-1', { actorId: 'contact-b', conversationId: 'contact-b', text: 'B-1', receivedAt: 150 }) },
    ], cursorWeixin('parallel', 300))
    dispatcher.start()
    await firstStarted
    await otherCompleted
    assert.deepEqual(started.slice(0, 2), ['A-1', 'B-1'])
    assert.equal(started.includes('A-2'), false)
    releaseFirst()
    await waitUntil(() => inbox.events.listEvents('completed').length === 3)
    assert.deepEqual(started, ['A-1', 'B-1', 'A-2'])
  } finally {
    releaseFirst()
    await dispatcher.close()
  }
})

test('queue pressure is diagnosed while persisted messages remain available for FIFO drain', async t => {
  const { inbox } = await fixture(t)
  const diagnostics = []
  let releaseFirst
  let markFirstStarted
  const gate = new Promise(resolve => { releaseFirst = resolve })
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve })
  const dispatcher = new InboxDispatcher(inbox.events, {
    process: async batch => {
      if (batch.events[0].payload.text === 'Q-1') { markFirstStarted(); await gate }
      return 'completed'
    },
  }, event => diagnostics.push(event), { maxConcurrentLanes: 1, maxPendingGlobal: 1, maxPendingPerConversation: 1, pollIntervalMs: 5, leaseRenewMs: 100, leaseMs: 1000 })
  try {
    inbox.events.persistPage(['Q-1', 'Q-2', 'Q-3'].map((text, index) => ({ envelope: event(`pressure-${index}`, { actorId: 'contact-q', conversationId: 'contact-q', text, receivedAt: 100 + index }) })), cursorWeixin('pressure', 200))
    dispatcher.start()
    await firstStarted
    await waitUntil(() => diagnostics.some(item => item.kind === 'queue-pressure'))
    assert.equal(inbox.events.listEvents().length, 3)
    assert.equal(inbox.events.pendingCounts().total, 3)
    assert.ok(diagnostics.some(item => item.kind === 'queue-pressure' && item.pendingConversation === 3))
    assert.ok(diagnostics.some(item => item.kind === 'queue-pressure' && item.pendingGlobal === 3))
    releaseFirst()
    await waitUntil(() => inbox.events.listEvents('completed').length === 3)
  } finally {
    releaseFirst()
    await dispatcher.close()
  }
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

test('Mattermost DM and each approved channel retain independent durable cursor scopes', async t => {
  const { inbox } = await fixture(t)
  inbox.cursors.commit(cursorMattermost(1_000))
  inbox.cursors.commit({ ...cursorMattermost(2_000), scopeId: 'mattermost-dm' })
  inbox.cursors.commit({ ...cursorMattermost(3_000), scopeId: `mattermost-channel:${'c'.repeat(26)}` })
  inbox.cursors.commit({ ...cursorMattermost(4_000), scopeId: `mattermost-channel:${'d'.repeat(26)}` })
  assert.equal(inbox.cursors.get('mm-config').highWatermark, 1_000)
  assert.equal(inbox.cursors.get('mm-config', 'mattermost-dm').highWatermark, 2_000)
  assert.equal(inbox.cursors.get('mm-config', `mattermost-channel:${'c'.repeat(26)}`).highWatermark, 3_000)
  assert.equal(inbox.cursors.get('mm-config', `mattermost-channel:${'d'.repeat(26)}`).highWatermark, 4_000)
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

test('WeChat durable poll resumes its buffer and deduplicates replay without a started dispatcher', async t => {
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
  t.mock.method(WeixinApi.prototype, 'sendText', async () => {})
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

test('each approved WeChat event is acknowledged immediately and its private context token stays out of diagnostics', async t => {
  const { inbox } = await fixture(t)
  const channel = { id: 'wx-config', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot', name: 'wx', enabled: true, createdAt: 1, updatedAt: 1 }
  const store = makeStore(channel, 'wx-peer')
  const controller = new AbortController()
  const sent = []
  const manager = new ChannelManager({}, store, {}, { reply: async () => ({ text: '', attachments: [] }) }, '.', inbox)
  t.mock.method(WeixinApi.prototype, 'getUpdates', async () => ({ get_updates_buf: 'next', msgs: [{ message_type: 1, from_user_id: 'wx-peer', message_id: 'ack-1', context_token: 'secret-context', item_list: [{ type: 1, text_item: { text: '任务内容' } }] }] }))
  t.mock.method(WeixinApi.prototype, 'sendText', async (...args) => { sent.push(args); controller.abort() })
  await manager.pollLoop(channel, new WeixinApi('https://example.test', 'secret-bot-token'), controller.signal)
  const [record] = inbox.events.listEvents('ready')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'wx-peer')
  assert.equal(sent[0][1], '收到，正在整理这组消息。')
  assert.equal(sent[0][2], 'secret-context')
  assert.equal(inbox.events.acknowledgementStatus(record.id), 'sent')
  assert.doesNotMatch(JSON.stringify(manager.channelDiagnostics()), /secret-context|secret-bot-token/)
  assert.ok(manager.channelDiagnostics().some(item => item.phase === 'inbox-ack-sent'))
})

test('starting a WeChat channel dispatches its persisted message to the DSH Agent and delivers the reply', async t => {
  const { inbox } = await fixture(t)
  const channel = { id: 'wx-config', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot', name: 'wx', enabled: true, createdAt: 1, updatedAt: 1 }
  const store = makeStore(channel, 'wx-peer')
  const steps = []
  const agentInputs = []
  const sent = []
  let pollCount = 0
  const logger = { info() {}, warn() {}, error() {} }
  const manager = new ChannelManager({ logger, settings: {} }, store, {
    read: async () => ({ baseUrl: 'https://example.test', botToken: 'test-only-token' }),
  }, {
    reply: async (_companion, _channelId, _userId, message) => {
      steps.push('agent')
      agentInputs.push(message)
      return { text: 'DSH 已完成处理', attachments: [] }
    },
  }, '.', inbox)
  t.mock.method(WeixinApi.prototype, 'getUpdates', async (_buffer, _timeoutMs, signal) => {
    if (pollCount++ === 0) return { get_updates_buf: 'buffer-live', msgs: [{
      message_type: 1, from_user_id: 'wx-peer', message_id: 'live-post-1', context_token: 'route-live',
      item_list: [{ type: 1, text_item: { text: '请读取这个请求' } }],
    }] }
    if (signal.aborted) return { get_updates_buf: 'buffer-live', msgs: [] }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { get_updates_buf: 'buffer-live', msgs: [] }
  })
  t.mock.method(WeixinApi.prototype, 'sendText', async (...args) => {
    sent.push(args)
    steps.push(args[1] === '收到，正在整理这组消息。' ? 'ack' : 'reply')
  })
  try {
    await manager.start(channel.id)
    await waitUntil(() => inbox.events.listEvents('completed').length === 1, 10_000)
    const [record] = inbox.events.listEvents('completed')
    assert.equal(inbox.events.acknowledgementStatus(record.id), 'sent')
    assert.equal(agentInputs.length, 1)
    assert.equal(agentInputs[0].text, '请读取这个请求')
    assert.equal(agentInputs[0].inboxConversation.accountId, 'wx-bot')
    assert.equal(agentInputs[0].inboxConversation.conversationId, 'wx-peer')
    assert.doesNotMatch(agentInputs[0].text, /route-live|test-only-token/)
    assert.deepEqual(steps, ['ack', 'agent', 'reply'])
    assert.equal(sent[1][1], 'DSH 已完成处理')
    assert.equal(sent[1][2], 'route-live')
    assert.ok(manager.channelDiagnostics().some(item => item.phase === 'inbox-claimed'))
    assert.ok(manager.channelDiagnostics().some(item => item.phase === 'inbox-completed'))
  } finally {
    await manager.close()
  }
})

test('Mattermost acknowledgement stays in the verified DM that supplied the post', async t => {
  const { inbox } = await fixture(t)
  const high = 1_700_000_000_000
  inbox.cursors.commit(cursorMattermost(high))
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: '', peerId: '' } }
  const store = makeStore(channel, 'mm-peer', [{ id: 'approved', channelId: channel.id, userId: 'mm-peer', displayName: 'mm-peer', status: 'approved', directTargetId: 'verified-dm', createdAt: 1, updatedAt: 1 }])
  const controller = new AbortController()
  const sent = []
  const transport = {
    poll: async () => ({ cursor: String(high + 100), messages: [{ id: 'mm-ack-1', sender: 'mm-peer', targetId: 'verified-dm', text: '任务内容', timestamp: high + 100 }] }),
    forTarget: targetId => ({
      sendText: async (userId, text) => { sent.push({ targetId, userId, text }); controller.abort() },
      close() {},
    }),
  }
  const manager = new ChannelManager({}, store, {}, { reply: async () => ({ text: '', attachments: [] }) }, '.', inbox)
  await manager.pollMattermostInbox(channel, transport, controller.signal)
  const [record] = inbox.events.listEvents('ready')
  assert.equal(inbox.events.acknowledgementStatus(record.id), 'sent')
  assert.deepEqual(sent, [{ targetId: 'verified-dm', userId: 'mm-peer', text: '收到，正在整理这组消息。' }])
  assert.ok(manager.channelDiagnostics().some(item => item.phase === 'inbox-ack-sent' && item.conversationId === 'verified-dm'))
})

test('Mattermost channel mention persists its own cursor, reads thread context, and acknowledges in that thread', async t => {
  const { inbox } = await fixture(t)
  const high = 1_700_000_000_000
  const postId = 'p'.repeat(26), channelId = 'c'.repeat(26), actorId = 'u'.repeat(26)
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: 'mm-bot', name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: '', peerId: '', allowedChannelIds: [channelId] } }
  const store = makeStore(channel, actorId, [{ id: 'approved', channelId: channel.id, userId: actorId, displayName: actorId, status: 'blocked', allowedChannelIds: [channelId], createdAt: 1, updatedAt: 1 }])
  inbox.cursors.commit(cursorMattermost(high))
  const controller = new AbortController()
  const sent = []
  const transport = {
    poll: async since => ({ cursor: String(high + 10), messages: [] }),
    forMattermostChannel: () => ({
      poll: async since => ({ cursor: String(high + 100), messages: [{ id: postId, sender: actorId, targetId: channelId, text: '@ajiu 检查一下', isBotMentioned: true, timestamp: high + 100, updateAt: high + 100 }] }),
      readMattermostThread: async root => [{ postId: root, actorId, text: '@ajiu 检查一下', timestamp: high + 100, isBot: false }],
      close() {},
    }),
    forThread: (targetId, rootId) => ({
      sendText: async (userId, text) => { sent.push({ targetId, rootId, userId, text }); controller.abort() },
      close() {},
    }),
  }
  const manager = new ChannelManager({}, store, {}, { reply: async () => assert.fail('收件测试不应启动 Agent') }, '.', inbox)
  const hardStop = setTimeout(() => controller.abort(), 2_000)
  try { await manager.pollMattermostInbox(channel, transport, controller.signal) }
  finally { clearTimeout(hardStop) }
  const [record] = inbox.events.listEvents('ready')
  assert.equal(record.payload.channelId, channelId)
  assert.equal(record.payload.isChannelConversation, true)
  assert.equal(record.payload.conversationType, 'thread')
  assert.equal(record.payload.threadRootId, postId)
  assert.equal(record.payload.mattermostContext[0].postId, postId)
  assert.equal(inbox.events.acknowledgementStatus(record.id), 'sent')
  assert.deepEqual(sent, [{ targetId: channelId, rootId: postId, userId: actorId, text: '收到，正在整理这组消息。' }])
  assert.equal(inbox.cursors.get(channel.id, 'mattermost-dm').highWatermark, high + 10)
  assert.equal(inbox.cursors.get(channel.id, `mattermost-channel:${channelId}`).highWatermark, high + 100)
})

test('Mattermost channel drops non-mentions and bot-authored posts before thread reads, acknowledgements, or Inbox persistence', async t => {
  const { inbox } = await fixture(t)
  const high = 1_700_000_100_000
  const channelId = 'c'.repeat(26), actorId = 'u'.repeat(26), botId = 'b'.repeat(26)
  const channel = { id: 'mm-config', platform: 'mattermost', companionId: 'companion', accountId: botId, name: 'mm', enabled: true, createdAt: 1, updatedAt: 1,
    direct: { baseUrl: 'http://localhost', targetId: '', peerId: '', allowedChannelIds: [channelId] } }
  const store = makeStore(channel, actorId, [])
  const controller = new AbortController()
  let threadReads = 0, acknowledgements = 0
  const api = {
    poll: async () => ({ cursor: String(high + 10), messages: [] }),
    forMattermostChannel: () => ({
      poll: async () => ({ cursor: String(high + 200), messages: [
        { id: 'n'.repeat(26), sender: actorId, targetId: channelId, text: '普通频道消息', isBotMentioned: false, timestamp: high + 100 },
        // 模拟机器人自己的确认被错误标成 mention，入口仍必须拒收。
        { id: 'o'.repeat(26), sender: botId, targetId: channelId, text: '@ajiu 收到，正在整理', isBotMentioned: true, timestamp: high + 200 },
      ] }),
      readMattermostThread: async () => { threadReads++; return [] },
      close() {},
    }),
    close() {},
  }
  const manager = new ChannelManager({}, store, {}, { reply: async () => assert.fail('无 @ 消息不得启动 Agent') }, '.', inbox)
  manager.sendInboxAcknowledgements = async () => { acknowledgements++ }
  const stopAfterFirstPoll = setTimeout(() => controller.abort(), 50)
  try { await manager.pollMattermostInbox(channel, api, controller.signal) }
  finally { clearTimeout(stopAfterFirstPoll) }

  assert.equal(threadReads, 0)
  assert.equal(acknowledgements, 0)
  assert.equal(inbox.events.listEvents().length, 0)
  assert.equal(inbox.cursors.get(channel.id, `mattermost-channel:${channelId}`).highWatermark, high + 200)
})

test('coalesced WeChat user content reaches the DSH Agent once in order and the final reply uses the latest route token', async t => {
  const { inbox } = await fixture(t)
  const channel = { id: 'wx-config', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot', name: 'wx', enabled: true, createdAt: 1, updatedAt: 1 }
  const store = makeStore(channel, 'wx-peer')
  const now = Date.now()
  const first = event('prompt-1', { accountId: 'wx-bot', actorId: 'wx-peer', text: '整理本次变更', receivedAt: now - 5000, platformTimestamp: now - 5000, replyContextToken: 'route-old' })
  const second = event('prompt-2', { accountId: 'wx-bot', actorId: 'wx-peer', text: '最后列出测试结果', receivedAt: now - 4500, platformTimestamp: now - 4500, replyContextToken: 'route-latest' })
  inbox.events.persistPage([{ envelope: first }, { envelope: second }], cursorWeixin('merged', now), DEFAULT_INBOX_BATCH_POLICY)
  const batch = inbox.events.claimNext('test-agent', now + 10_000, 30_000)
  assert.equal(batch.events.length, 2)
  const agentInputs = []
  const sends = []
  const manager = new ChannelManager({}, store, { read: async () => ({ baseUrl: 'https://example.test', botToken: 'private-token' }) }, {
    reply: async (...args) => { agentInputs.push(args[3]); return { text: '已完成并列出结果', attachments: [] } },
  }, '.', inbox)
  t.mock.method(WeixinApi.prototype, 'sendText', async (...args) => { sends.push(args) })
  const disposition = await manager.processInboxBatch(batch, new AbortController().signal)
  assert.equal(disposition, 'completed')
  assert.equal(agentInputs.length, 1)
  assert.match(agentInputs[0].text, /整理本次变更[\s\S]*最后列出测试结果/)
  assert.equal(agentInputs[0].inboxConversation.conversationKey, first.conversationKey)
  assert.equal(agentInputs[0].inboxConversation.accountId, first.accountId)
  assert.doesNotMatch(agentInputs[0].text, /route-old|route-latest|private-token/)
  assert.equal(sends.length, 1)
  assert.equal(sends[0][1], '已完成并列出结果')
  assert.equal(sends[0][2], 'route-latest')
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
    forTarget: (targetId, expected) => ({ sendText: async (userId, text) => { sent.push({ targetId, expected, userId, text }) }, close() {} }),
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
  assert.equal(inbox.cursors.get(channel.id, 'mattermost-dm').highWatermark, high + 100)
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
  const store = makeStore(channel, 'mm-peer', [{ id: 'approved', channelId: channel.id, userId: 'mm-peer', displayName: 'mm-peer', status: 'approved', directTargetId: 'dm-channel', createdAt: 1, updatedAt: 1 }])
  let agentRuns = 0
  const credentials = { read: async () => ({ baseUrl: channel.direct.baseUrl, botToken: 'not-a-real-token' }) }
  const calls = []
  t.mock.method(DirectTransport.prototype, 'sendText', async () => {})
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
  assert.equal(inbox.cursors.get(channel.id, 'mattermost-dm').highWatermark, high)

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
  assert.equal(restarted.cursors.get(channel.id, 'mattermost-dm').highWatermark, high)
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
      const count = fullPage ? 1000 : 2
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
  await assert.rejects(api.poll(since, new AbortController().signal, 0), /since 接口上限/)
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

test('WeChat context tokens stay isolated by bot account for the same contact', async t => {
  const { inbox } = await fixture(t)
  const channels = [
    { id: 'wx-a', platform: 'weixin', companionId: 'companion', accountId: 'bot-a', name: 'A', enabled: true, createdAt: 1, updatedAt: 1 },
    { id: 'wx-b', platform: 'weixin', companionId: 'companion', accountId: 'bot-b', name: 'B', enabled: true, createdAt: 1, updatedAt: 1 },
  ]
  const state = {
    channels,
    companions: [{ id: 'companion' }],
    sessions: [],
    recentReceipts: [],
    pairings: channels.map(channel => ({ id: `approved-${channel.id}`, channelId: channel.id, userId: 'same-contact', displayName: 'same-contact', status: 'approved', createdAt: 1, updatedAt: 1 })),
  }
  const store = { snapshot: () => structuredClone(state), update: async change => { change(state); return structuredClone(state) }, isCompanionRemoving: () => false }
  const sent = []
  const manager = new ChannelManager({}, store, { read: async () => ({ baseUrl: 'https://example.test', botToken: 'test-only-token' }) }, {
    reply: async () => ({ text: '完成', attachments: [] }),
  }, '.', inbox)
  t.mock.method(WeixinApi.prototype, 'sendText', async (...args) => { sent.push(args) })

  // A 账号先建立 token，B 账号随后覆盖同一联系人的 token 槽位，最后确认 A 仍走自己的路由。
  const cases = [
    { channel: channels[0], eventId: 'wx-a-first', token: 'route-token-a' },
    { channel: channels[1], eventId: 'wx-b-first', token: 'route-token-b' },
    { channel: channels[0], eventId: 'wx-a-resume', token: undefined },
  ]
  for (const [index, item] of cases.entries()) {
    const now = Date.now() + index
    inbox.events.persistPage([{
      envelope: event(item.eventId, {
        platform: 'weixin', channelConfigId: item.channel.id, accountId: item.channel.accountId,
        conversationId: 'same-contact', actorId: 'same-contact', text: item.eventId,
        ...(item.token ? { replyContextToken: item.token } : {}), receivedAt: now, platformTimestamp: now,
      }),
    }], cursorWeixin(`buffer-${index}`, now, item.channel.id))
    const batch = inbox.events.claimNext('token-isolation-test', Date.now() + 10_000, 30_000)
    assert.ok(batch)
    assert.equal(await manager.processInboxBatch(batch, new AbortController().signal), 'completed')
    inbox.events.settle(batch.batch.id, 'token-isolation-test', Date.now() + 10_001)
  }

  assert.deepEqual(sent.map(args => args[2]), ['route-token-a', 'route-token-b', 'route-token-a'])
})

test('WeChat media references survive inbox restart and inbound/outbound attachments keep the contact route', async t => {
  const { root, path, inbox, register } = await fixture(t)
  const channel = { id: 'wx-config', platform: 'weixin', companionId: 'companion', accountId: 'wx-bot', name: 'wx', enabled: true, createdAt: 1, updatedAt: 1 }
  const store = makeStore(channel, 'wx-peer')
  const receivedImage = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1])
  const receivedFile = Buffer.from('persisted inbound file')
  const outboundImage = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2, 3])
  const outboundFile = Buffer.from('generated outbound file')
  const outboundImagePath = join(root, 'answer.png')
  const outboundFilePath = join(root, 'answer.txt')
  await writeFile(outboundImagePath, outboundImage)
  await writeFile(outboundFilePath, outboundFile)
  const posts = []
  const uploads = []
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input))
    if (url.hostname === 'media.wechat.com') {
      return new Response(url.pathname.endsWith('.png') ? receivedImage : receivedFile, { status: 200 })
    }
    if (url.hostname === 'novac2c.cdn.weixin.qq.com') {
      uploads.push({ url: url.toString(), bytes: Buffer.from(init.body) })
      return new Response('', { status: 200, headers: { 'x-encrypted-param': `signed-${uploads.length}` } })
    }
    if (url.pathname.endsWith('/ilink/bot/getuploadurl')) {
      return Response.json({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload' })
    }
    if (url.pathname.endsWith('/ilink/bot/sendmessage')) {
      posts.push(JSON.parse(init.body).msg)
      return Response.json({ ret: 0 })
    }
    assert.fail(`Unexpected fetch: ${url.toString()}`)
  })

  const page = weixinInboxItem(channel, {
    message_type: 1, from_user_id: 'wx-peer', message_id: 'media-post', context_token: 'durable-context-token',
    item_list: [
      { type: 1, text_item: { text: '请检查这张图片和文件' } },
      { type: 2, image_item: { filename: 'input.png', content_type: 'image/png', media: { full_url: 'https://media.wechat.com/input.png' } } },
      { type: 4, file_item: { file_name: 'input.txt', content_type: 'text/plain', media: { full_url: 'https://media.wechat.com/input.txt' } } },
    ],
  }, userId => userId === 'wx-peer', Date.now())
  inbox.events.persistPage([page], cursorWeixin('buffer-media', Date.now(), channel.id))

  // 模拟 DSH 在入队与执行之间重启，消费者必须从 SQLite 还原媒体引用。
  inbox.close()
  const reopened = await DurableInbox.open(path)
  register(reopened)
  const batch = reopened.events.claimNext('media-restart-test', Date.now() + 10_000, 30_000)
  assert.ok(batch)
  const agentInputs = []
  const manager = new ChannelManager({}, store, { read: async () => ({ baseUrl: 'https://api.example.test', botToken: 'test-only-token' }) }, {
    reply: async (_companion, _channelId, _userId, message) => {
      agentInputs.push(message)
      return { text: '检查完成', attachments: [
        { path: outboundImagePath, name: 'answer.png', kind: 'image', mediaType: 'image/png' },
        { path: outboundFilePath, name: 'answer.txt', kind: 'file', mediaType: 'text/plain' },
      ] }
    },
  }, '.', reopened)

  assert.equal(await manager.processInboxBatch(batch, new AbortController().signal), 'completed')
  assert.equal(agentInputs.length, 1)
  assert.equal(agentInputs[0].text, '请检查这张图片和文件')
  assert.deepEqual(agentInputs[0].attachments.map(item => item.kind), ['image', 'file'])
  assert.deepEqual(Buffer.from(agentInputs[0].attachments[0].data), receivedImage)
  assert.deepEqual(Buffer.from(agentInputs[0].attachments[1].data), receivedFile)
  assert.doesNotMatch(JSON.stringify(agentInputs[0]), /durable-context-token|media\.wechat\.com|test-only-token/)
  assert.equal(posts.length, 3)
  assert.deepEqual(posts.map(item => item.context_token), ['durable-context-token', 'durable-context-token', 'durable-context-token'])
  assert.equal(posts[0].item_list[0].type, 1)
  assert.equal(posts[1].item_list[0].type, 2)
  assert.equal(posts[2].item_list[0].type, 4)
  assert.equal(posts[2].item_list[0].file_item.file_name, 'answer.txt')
  assert.equal(uploads.length, 2)
  assert.ok(uploads.every(item => item.bytes.length > 0))
})
