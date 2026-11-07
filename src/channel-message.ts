export const PARTNER_MEDIA_MAX_BYTES = 64 * 1024 * 1024

export interface PartnerInboundAttachment {
  kind: 'image' | 'file'
  data: Uint8Array
  name: string
  mediaType?: string
}

export interface PartnerInboundMessage {
  sessionTitle?: string
  /** 渠道来源路由元数据；不属于用户正文，Agent 运行时不得将其写入提示词。 */
  inboxConversation?: import('./inbox/session-router.js').InboxSessionIdentity
  text: string
  attachments: PartnerInboundAttachment[]
}

export interface PartnerOutboundAttachment {
  contentHash?: string
  path: string
  name: string
  mediaType: string
  kind: 'image' | 'file'
}

export interface PartnerReply {
  /** A tool already delivered the reply to the channel (for example QQ voice). */
  alreadyDelivered?: boolean
  /** Internal provenance, armed only after confirmed channel delivery. */
  postReplySource?: { routeId: string; sessionId: string; userMessageId: string }
  idleContactOrigin?: {routeId:string;sessionId:string;messageId:string;userMessageId:string;policyRevision:number}
  chatParts?: import('./chat/protocol.js').ChatPart[]
  chatOriginRouteId?: string | null
  /** Freeze the direct source; never reroute a queued reply after account or room changes. */
  directSource?: {
    routeId: string
    sessionId: string
    accountId: string
    baseUrl: string
    targetId: string
    /** Mattermost 线程回复的可信来源；不能由模型提供。 */
    conversationType?: 'dm' | 'thread'
    threadRootId?: string
    actorId?: string
    isChannelConversation?: boolean
  }

  /** Status-only delivery must suppress even previously queued attachment parts. */
  attachmentPolicy?: 'text-only'
  attachmentScope?: string
  text: string
  attachments: PartnerOutboundAttachment[]
}

export function safeMediaName(value: string, fallback = '微信附件.bin', defaultExtension = ''): string {
  const cleaned = value.replace(/[\\/\0-\x1f<>:"|?*]+/g, '_').trim().replace(/^\.+/, '').slice(0, 160)
  if (!cleaned) return fallback
  return defaultExtension && !cleaned.includes('.') ? `${cleaned}${defaultExtension}` : cleaned
}
