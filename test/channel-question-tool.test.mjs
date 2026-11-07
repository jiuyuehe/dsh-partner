import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { Session } from '@deepseek-ai/dsh-session'
import { resolveToolAccess, isToolAllowed, installToolAccessGuard } from '../lib/execution/tool-access-adapter.js'
import { renderChannelQuestionGuidance } from '../lib/character/conversation-behavior.js'
import { projectConversationPrompt } from '../lib/character/prompt-projection.js'

function fixture(platform = 'weixin') {
  const session = Session.create(`channel-question-${platform}`)
  const agent = { session, options: {} }
  const state = {
    channels: [{ id: 'channel-1', platform, enabled: true }],
    sessions: [{
      id: 'route-1', kind: 'channel', channelId: 'channel-1', userId: 'external-user', companionId: 'companion-1',
      sessionId: session.id, inboxConversationKey: 'direct:verified-conversation', inboxPlatform: platform,
      inboxConversationType: 'dm', inboxConversationId: 'verified-conversation', lastMessageAt: Date.now(),
    }],
  }
  return { session, agent, state }
}

// 微信和 Mattermost 入站会话只能通过渠道发起澄清，不能挂起等待本地 UI。
test('WeChat and Mattermost inbox sessions hide the DSH page question tool', () => {
  for (const platform of ['weixin', 'mattermost']) {
    const { agent, state } = fixture(platform)
    const access = resolveToolAccess({ agent, state })
    assert.equal(isToolAllowed(access, 'ask_user_question'), false)
    assert.equal(isToolAllowed(access, 'partner_chat_reply'), true)
    assert.equal(isToolAllowed(access, 'partner_work_execute'), true)
    assert.match(access.denialReason, /原渠道提问/)
  }
})

test('only durable external-channel routes receive the question-tool restriction', () => {
  const { agent, state } = fixture()
  state.sessions[0].inboxConversationKey = undefined
  const local = resolveToolAccess({ agent, state })
  assert.equal(isToolAllowed(local, 'ask_user_question'), true)

  state.sessions[0].inboxConversationKey = 'direct:verified-conversation'
  state.sessions[0].inboxPlatform = 'qq'
  const otherChannel = resolveToolAccess({ agent, state })
  assert.equal(isToolAllowed(otherChannel, 'ask_user_question'), true)
})

test('runtime guard denies hidden UI questions while allowing normal tools', async t => {
  const { agent, state } = fixture('mattermost')
  const root = new Context()
  root.provide('systemPrompt', { tools: () => () => {} })
  new ToolRuntime(root)
  agent.ctx = root
  let calls = 0
  for (const name of ['ask_user_question', 'partner_chat_reply']) {
    root.tools.register(defineContentToolFixture({
      name, description: 'test', parameters: {},
      execute: async () => { calls++; return [{ type: 'text', text: 'ok' }] },
    }))
  }
  t.after(installToolAccessGuard(root.tools, () => state))
  const invoke = name => root.tools.execute({ callId: 'test', name, arguments: {}, agent, signal: new AbortController().signal })
  assert.equal((await invoke('ask_user_question')).isError, true)
  assert.equal(calls, 0)
  assert.equal((await invoke('partner_chat_reply')).isError, false)
  assert.equal(calls, 1)
})

test('channel guidance tells the agent to ask through the source conversation and finish the turn', () => {
  const guidance = renderChannelQuestionGuidance()
  assert.match(guidance, /不要调用 ask_user_question/)
  assert.match(guidance, /partner_chat_reply/)
  assert.match(guidance, /同一渠道会话/)
  assert.match(guidance, /像“你好”这样的问候应自然问候/)
  assert.match(guidance, /旧的 ask_user_question.*已经过期/)
})

test('exclusive persona projection preserves the hidden channel-routing system context', () => {
  const { agent } = fixture()
  const assembly = { sections: [
    { name: 'partner-identity', text: 'persona' },
    { name: 'partner-channel-routing', text: renderChannelQuestionGuidance() },
    { name: 'partner-conversation-memory', text: 'private contextual memory' },
  ], tools: [] }
  const result = projectConversationPrompt(assembly, agent, { roleEnabled: true, discovery: false, exclusive: true })
  assert.deepEqual(result.sections.map(section => section.name), ['partner-identity', 'partner-channel-routing'])
})
