import type { ConversationRoute, InboundEnvelope, OutboundTarget } from './domain.js'
import type { ConversationKey } from './ids.js'

function requiredRouteId(value: string | undefined, field: string): string {
  if (!value || value.length === 0 || value !== value.trim()) throw new Error(`${field} is required for Mattermost routing`)
  return value
}

/** Resolves the immutable reply destination from the validated inbound source. */
export function outboundTargetFor(envelope: InboundEnvelope): OutboundTarget {
  if (envelope.platform === 'weixin') {
    return {
      platform: 'weixin',
      channelConfigId: envelope.channelConfigId,
      toUserId: envelope.conversationId,
      ...(envelope.replyContextToken === undefined ? {} : { contextToken: envelope.replyContextToken }),
    }
  }

  const channelId = requiredRouteId(envelope.channelId ?? envelope.conversationId, 'channelId')
  if (envelope.conversationType === 'dm') {
    return {
      platform: 'mattermost',
      channelConfigId: envelope.channelConfigId,
      channelId,
      conversationType: 'dm',
      directUserId: envelope.actorId,
    }
  }
  return {
    platform: 'mattermost',
    channelConfigId: envelope.channelConfigId,
    channelId,
    conversationType: 'thread',
    rootId: envelope.conversationType === 'thread'
      ? requiredRouteId(envelope.threadRootId, 'threadRootId')
      : envelope.externalMessageId,
  }
}

/** Session routes are looked up only by the canonical source key, never by display name or actor alone. */
export function findConversationRoute(
  routes: readonly ConversationRoute[],
  conversationKey: ConversationKey,
): ConversationRoute | undefined {
  let match: ConversationRoute | undefined
  for (const route of routes) {
    if (route.conversationKey !== conversationKey) continue
    if (match) throw new Error(`duplicate route for conversationKey ${conversationKey}`)
    match = route
  }
  return match
}
