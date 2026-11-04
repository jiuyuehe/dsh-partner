import type {
  BatchId,
  ConversationKey,
  DeliveryId,
  ExternalAttachmentId,
  ExternalEventId,
  ExternalMessageId,
  InboxEventId,
  JobId,
  GoalId,
  MemoryScopeId,
  RouteId,
  RunId,
  SessionId,
  SubagentId,
} from './ids.js'

export type ChannelPlatform = 'weixin' | 'mattermost'
export type ConversationType = 'dm' | 'channel' | 'thread'
export type MemorySharingMode = 'isolated' | 'channel' | 'companion'

/** Portable attachment metadata. File bytes, signed URLs and credentials stay in the adapter. */
export interface InboundAttachment {
  externalAttachmentId: ExternalAttachmentId
  fileName: string
  contentType?: string
  sizeBytes?: number
}

/** Normalized platform event. replyContextToken is routing-only and must never enter model input or logs. */
export interface InboundEnvelope {
  platform: ChannelPlatform
  accountId: string
  channelConfigId: string
  externalEventId: ExternalEventId
  externalMessageId: ExternalMessageId
  conversationType: ConversationType
  conversationId: string
  conversationKey: ConversationKey
  channelId?: string
  threadRootId?: string
  replyToMessageId?: string
  actorId: string
  actorName?: string
  text: string
  mentions: string[]
  isBotMentioned: boolean
  isBotMessage: boolean
  attachments: InboundAttachment[]
  platformTimestamp: number
  receivedAt: number
  /** WeChat reply routing only. Do not expose this value to the Agent or logs. */
  replyContextToken?: string
  rawEventVersion?: string
}

export type OutboundTarget =
  | {
      platform: 'weixin'
      channelConfigId: string
      toUserId: string
      contextToken?: string
    }
  | {
      platform: 'mattermost'
      channelConfigId: string
      channelId: string
      conversationType: 'dm'
      /** Verified human peer; not interchangeable with channelId. */
      directUserId: string
    }
  | {
      platform: 'mattermost'
      channelConfigId: string
      channelId: string
      conversationType: 'thread'
      rootId: string
    }

export interface ConversationRoute {
  id: RouteId
  companionId: string
  conversationKey: ConversationKey
  platform: ChannelPlatform
  conversationType: ConversationType
  channelConfigId: string
  accountId: string
  externalConversationId: string
  channelId?: string
  peerId?: string
  threadRootId?: string
  sessionId: SessionId
  cwd?: string
  memoryScopeId: MemoryScopeId
  memorySharingMode: MemorySharingMode
  lastActorId?: string
  lastMessageAt: number
  createdAt: number
  updatedAt: number
}

export type InboxStatus =
  | 'received'
  | 'filtered'
  | 'buffered'
  | 'ready'
  | 'processing'
  | 'completed'
  | 'retryable_failed'
  | 'dead_letter'
  | 'interrupted'

export interface InboxEventRecord {
  id: InboxEventId
  channelConfigId: string
  platform: ChannelPlatform
  accountId: string
  externalEventId: ExternalEventId
  externalMessageId: ExternalMessageId
  conversationKey: ConversationKey
  actorId: string
  payload: InboundEnvelope
  status: InboxStatus
  batchId?: BatchId
  attemptCount: number
  receivedAt: number
  processedAt?: number
  lastError?: string
}

export interface MessageBatch {
  id: BatchId
  conversationKey: ConversationKey
  sessionId?: SessionId
  eventIds: InboxEventId[]
  status: InboxStatus
  firstReceivedAt: number
  lastReceivedAt: number
  readyAt: number
  attemptCount: number
  leaseOwner?: string
  leaseUntil?: number
  createdAt: number
  updatedAt: number
  lastError?: string
}

export type CursorType = 'timestamp' | 'opaque-buffer'

export interface ChannelCursor {
  channelConfigId: string
  platform: ChannelPlatform
  cursorType: CursorType
  cursorJson: string
  highWatermark?: number
  updatedAt: number
}

export type OutboundDeliveryStatus = 'pending' | 'sending' | 'sent' | 'unknown' | 'failed'

export interface OutboundDelivery {
  id: DeliveryId
  conversationKey: ConversationKey
  target: OutboundTarget
  batchId: BatchId
  contentHash: string
  status: OutboundDeliveryStatus
  externalMessageId?: ExternalMessageId
  attemptCount: number
  createdAt: number
  updatedAt: number
  lastError?: string
}

/** IDs from DSH and Partner execution domains remain distinct at compile time. */
export interface ExecutionIdentity {
  runId: RunId
  sessionId?: SessionId
  subagentId?: SubagentId
  jobId?: JobId
  goalId?: GoalId
  externalEventId?: ExternalEventId
  batchId?: BatchId
}
