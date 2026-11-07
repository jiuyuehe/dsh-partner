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

/** Mattermost thread 历史只包含经服务端读取的纯文本元数据；作为引用上下文注入用户消息。 */
export interface MattermostContextPost {
  postId: string
  actorId: string
  actorName?: string
  text: string
  timestamp: number
  isBot: boolean
}

/** 微信附件续读所需的短期 CDN 引用；属于渠道敏感数据，不能写入提示词或诊断日志。 */
export interface WeixinMediaSource {
  kind: 'image' | 'file'
  fileName?: string
  contentType?: string
  imageAesKey?: string
  fullUrl?: string
  encryptQueryParam?: string
  aesKey?: string
  encryptType?: number
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
  /** 区分 Mattermost 频道和双人 DM 中的线程，权限模型不同。 */
  isChannelConversation?: boolean
  threadRootId?: string
  replyToMessageId?: string
  actorId: string
  actorName?: string
  text: string
  mentions: string[]
  isBotMentioned: boolean
  isBotMessage: boolean
  attachments: InboundAttachment[]
  /** 仅供微信 Adapter 在重启后下载附件，不得暴露给 Agent。 */
  weixinMediaSources?: WeixinMediaSource[]
  platformTimestamp: number
  receivedAt: number
  /** WeChat reply routing only. Do not expose this value to the Agent or logs. */
  replyContextToken?: string
  rawEventVersion?: string
  /** 经过频道/线程来源验证的有限历史，不包含 token、文件 URL 或原始 API 对象。 */
  mattermostContext?: MattermostContextPost[]
  /** Mattermost 按渠道配置注入的历史轮数；只影响提示结构，不参与路由或授权。 */
  mattermostContextRounds?: number
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
  /** 微信和旧 Mattermost DM 使用空作用域；每个 Mattermost 频道使用独立 scopeId。 */
  scopeId?: string
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
