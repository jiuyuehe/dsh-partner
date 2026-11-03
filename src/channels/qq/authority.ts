import {canFinishIdleActivity} from '../../character/activity-tool.js'
import { activityPolicyCurrent } from '../../character/post-reply.js'
import type { ToolAccessAdapter } from '../../execution/tool-access-adapter.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerState } from '../../domain.js'
import { isInternalTaskNotice } from '../delivery-policy.js'
import { isIdleContactNotice } from '../../character/idle-contact.js'
import { currentQqIdentityRelation } from './identity-binding.js'

const autonomousAgents = new WeakSet<object>()
/** Only internal schedulers can mark an execution; message text cannot. */
export function markAutonomousAgent(agent: object): () => void {
  autonomousAgents.add(agent)
  return () => { autonomousAgents.delete(agent) }
}

export const QQ_CHAT_ONLY_REASON = '当前 QQ 账号未归属此伙伴，仅允许当前会话的文字、表情发送与收藏整理、语音回复、当前群提及与已开启的戳一戳、回忆检索及已开启的当前会话表情回应和群信息查询；不能使用私有能力、修改设定或触发自主任务。'

/** Re-evaluate at dispatch, so stale schemas and saved revocations cannot authorize work. */
export function qqChatOnly(agent: Pick<Agent, 'session'>, state: Pick<PartnerState, 'sessions' | 'channels'> & Partial<Pick<PartnerState, 'companions' | 'pairings'>>, inputEvents?: readonly SessionEvent[]): boolean {
  if (autonomousAgents.has(agent)) return false
  const routes = state.sessions.filter(r => r.sessionId === agent.session.id)
  if (!state.channels?.some(c => c.platform === 'qq' && routes.some(r => r.channelId === c.id))) return false
  const events = inputEvents ?? agent.session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'user/message') continue
    // Only trusted plugin notices can run autonomous work. A group observation
    // remains an ordinary user's message even when the bot chooses to answer.
    if (isInternalTaskNotice(event)) return false
    if (isIdleContactNotice(event)) return !routes.some(r => {
      if (r.idleContactState?.messageId !== event.data.id) return false
      if (r.idleContactState.kind !== 'post-reply' && r.idleContactState.kind !== 'thought' && r.idleContactState.kind !== 'autonomous') return true
      const companion = state.companions?.find(c=>c.id===r.companionId)
      return !!companion && activityPolicyCurrent(state as PartnerState,companion,r)
    })
    if (event.data.source.kind === 'user') break
  }
  const relation = currentQqIdentityRelation(agent.session.id, events, state.sessions, state.channels)
  return Boolean(relation && !relation.matched)
}

export const qqToolAccessAdapter: ToolAccessAdapter = {
  resolve({ agent, state, events }) {
    if (!state.channels?.some(c => c.platform === 'qq' && state.sessions.some(r => r.sessionId === agent.session.id && r.channelId === c.id))) return undefined
    if (!qqChatOnly(agent, state, events)) return { sendTools: true }
    const full=state as PartnerState
    const mayFinish=(full.companions??[]).some(c=>canFinishIdleActivity(c.id,full,agent.session.id,events??agent.session.snapshotEvents()))
    return { sendTools: true, allowedTools: ['partner_tools', 'partner_channel_access', 'partner_chat_reply', 'partner_stickers', 'partner_qq', 'partner_qq_reply', 'partner_memory_recall', 'partner_agreement','partner_chat_say','partner_chat_progress', ...(mayFinish?['partner_activity_finish']:[])], denialReason: QQ_CHAT_ONLY_REASON }
  },
}
