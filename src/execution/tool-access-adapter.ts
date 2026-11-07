import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerState } from '../domain.js'
import { qqToolAccessAdapter } from '../channels/qq/authority.js'

export interface ToolAccessDecision {
  /** Whether the model receives the session's already-authorized tool list. */
  sendTools: boolean
  /** Optional channel-specific allowlist for ordinary reply tools. */
  allowedTools?: readonly string[]
  /** Channel- or task-specific tools hidden from the model and rejected at dispatch. */
  excludedTools?: readonly string[]
  denialReason?: string
}
export interface ToolAccessContext {
  agent: Pick<Agent, 'session'>
  state: Pick<PartnerState, 'sessions' | 'channels'>
  /** Host-admitted input during prompt preparation only; dispatch uses persisted events. */
  events?: readonly SessionEvent[]
}
export interface ToolAccessAdapter {
  resolve(context: ToolAccessContext): ToolAccessDecision | undefined
}

/** Channel adapters only narrow access; they never grant new capabilities. */
export const defaultToolAccessAdapter: ToolAccessAdapter = {
  resolve: () => ({ sendTools: true }),
}

/** 渠道会话不能等待 DSH 页面上的 ask_user_question；澄清必须回到消息来源渠道。 */
export const channelQuestionToolAdapter: ToolAccessAdapter = {
  resolve({ agent, state }) {
    const route = state.sessions.find(item => item.sessionId === agent.session.id
      && item.kind === 'channel' && !!item.inboxConversationKey
      && (item.inboxPlatform === 'weixin' || item.inboxPlatform === 'mattermost'))
    if (!route) return undefined
    return {
      sendTools: true,
      excludedTools: ['ask_user_question'],
      denialReason: '这是外部渠道会话，不能等待 DSH 页面输入；需要澄清时请通过 partner_chat_reply 在原渠道提问并结束本轮。',
    }
  },
}

const channelAdapters: readonly ToolAccessAdapter[] = [qqToolAccessAdapter, channelQuestionToolAdapter]

/** 所有模型可见性与运行时派发统一使用此判定，防止被隐藏的工具从另一入口调用。 */
export function isToolAllowed(access: ToolAccessDecision, name: string): boolean {
  return access.sendTools
    && (!access.allowedTools || access.allowedTools.includes(name))
    && !access.excludedTools?.includes(name)
}

export function resolveToolAccess(context: ToolAccessContext): ToolAccessDecision {
  for (const adapter of channelAdapters) {
    const decision = adapter.resolve(context)
    if (decision) return decision
  }
  return defaultToolAccessAdapter.resolve(context)!
}

/** The same adapter also rejects stale, hidden and nested tool dispatches. */
export function installToolAccessGuard(tools: ToolRuntime, snapshot: () => ToolAccessContext['state']): () => void {
  return tools.guard(exec => {
    if (!exec.agent) return
    const access = resolveToolAccess({ agent: exec.agent, state: snapshot() })
    if (!isToolAllowed(access, exec.name)) return access.denialReason ?? '当前渠道账号仅允许正常对话'
  })
}
