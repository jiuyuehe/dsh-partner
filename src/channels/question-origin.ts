import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ChannelSession } from '../domain.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from './delivery-policy.js'

/** A binding is not an origin. Unknown/browser messages always stay in DSH. */
export function questionOrigin(sessionId: string, events: readonly SessionEvent[], routes: readonly ChannelSession[]): ChannelSession | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (isRequirementDeliveryReceipt(event)) continue
    if (isInternalTaskNotice(event)) return undefined
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const route = routes.find(route => route.sessionId === sessionId && route.kind === 'channel' && route.inboundMessageIds?.includes(event.data.id))
    if (!route) return undefined
    // 同一 Mattermost thread 可由多位获准成员协作；提问必须记住本条消息的真实发言人。
    const origin = events.slice(0, index).reverse().map(item => pluginRecordOf(item))
      .find(record => record?.type === 'plugin:dsh-partner/input-origin' && (record.data as {messageId?:unknown})?.messageId === event.data.id)
    const actorId = origin?.type === 'plugin:dsh-partner/input-origin'
      ? (origin.data as {userId?:unknown}).userId : undefined
    return typeof actorId === 'string' ? { ...route, userId: actorId, lastActorId: actorId } : route
  }
  return undefined
}
