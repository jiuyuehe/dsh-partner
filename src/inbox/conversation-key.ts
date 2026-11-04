import { asConversationKey } from './ids.js'
import type { ChannelPlatform, ConversationType } from './domain.js'
import type { ConversationKey } from './ids.js'

export interface ConversationIdentity {
  platform: ChannelPlatform
  accountId: string
  channelConfigId: string
  conversationType: ConversationType
  conversationId: string
  threadRootId?: string
}

function requiredId(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${field} must be a non-empty stable platform ID`)
  }
  return value
}

/** Versioned, collision-safe key. Display names and actor IDs are deliberately excluded. */
export function createConversationKey(identity: ConversationIdentity): ConversationKey {
  const accountId = requiredId(identity.accountId, 'accountId')
  const channelConfigId = requiredId(identity.channelConfigId, 'channelConfigId')
  const conversationId = requiredId(identity.conversationId, 'conversationId')
  const threadRootId = identity.threadRootId === undefined
    ? undefined
    : requiredId(identity.threadRootId, 'threadRootId')

  if (identity.conversationType === 'thread' && !threadRootId) {
    throw new Error('threadRootId is required for a thread conversation')
  }
  if (identity.conversationType !== 'thread' && threadRootId) {
    throw new Error('threadRootId is only valid for a thread conversation')
  }

  const parts = [identity.platform, accountId, channelConfigId, identity.conversationType, conversationId]
  if (threadRootId) parts.push(threadRootId)
  return asConversationKey(`ck:v1:${parts.map(encodeURIComponent).join('|')}`)
}
