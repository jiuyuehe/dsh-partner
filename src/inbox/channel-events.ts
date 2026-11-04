import { createConversationKey } from './conversation-key.js'
import { asExternalAttachmentId, asExternalEventId, asExternalMessageId } from './ids.js'
import type { InboundEnvelope } from './domain.js'
import type { InboxPageItem } from './repository.js'
import type { WeixinChannel } from '../domain.js'
import type { WeixinRawMessage } from '../channels/weixin/types.js'
import type { DirectMessage } from '../channels/direct/transport.js'

function requiredId(value: string | undefined, label: string): string {
  const result = value?.trim()
  if (!result) throw new Error(`${label} is required before the channel cursor can advance`)
  return result
}

function timestamp(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function safeFileName(value: string | undefined, fallback: string): string {
  const name = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return name || fallback
}

function weixinText(message: WeixinRawMessage): string {
  return (message.item_list ?? []).flatMap(item => {
    if (item.type === 1 && item.text_item?.text?.trim()) return [item.text_item.text.trim()]
    if (item.type === 3 && item.voice_item?.text?.trim()) return [item.voice_item.text.trim()]
    return []
  }).join('\n\n')
}

function weixinAttachments(message: WeixinRawMessage, eventId: string) {
  return (message.item_list ?? []).flatMap((item, index) => {
    if (item.type === 2 && item.image_item) return [{
      externalAttachmentId: asExternalAttachmentId(`${eventId}:attachment:${index}`),
      fileName: safeFileName(item.image_item.filename, `图片-${index + 1}`),
      ...(item.image_item.content_type ? { contentType: item.image_item.content_type } : {}),
    }]
    if (item.type === 4 && item.file_item) {
      const size = Number(item.file_item.len)
      return [{
        externalAttachmentId: asExternalAttachmentId(`${eventId}:attachment:${index}`),
        fileName: safeFileName(item.file_item.file_name ?? item.file_item.filename, `文件-${index + 1}`),
        ...(item.file_item.content_type ? { contentType: item.file_item.content_type } : {}),
        ...(Number.isSafeInteger(size) && size >= 0 ? { sizeBytes: size } : {}),
      }]
    }
    return []
  })
}

/** Normalize WeChat only after auth is known; unapproved content is not copied into durable storage. */
export function weixinInboxItem(
  channel: WeixinChannel,
  message: WeixinRawMessage,
  isApproved: (userId: string) => boolean,
  receivedAt = Date.now(),
): InboxPageItem {
  const accountId = requiredId(channel.accountId, 'WeChat accountId')
  const channelConfigId = requiredId(channel.id, 'WeChat channelConfigId')
  const actorId = requiredId(message.from_user_id, 'WeChat sender ID')
  const sourceId = message.message_id ?? message.msg_id ?? message.seq
  const stableId = requiredId(sourceId === undefined ? undefined : String(sourceId), 'WeChat message ID')
  const externalEventId = `message:${stableId}`
  const acceptedType = message.message_type === undefined || message.message_type === 1
  const accepted = acceptedType && isApproved(actorId)
  const envelope: InboundEnvelope = {
    platform: 'weixin', accountId, channelConfigId,
    externalEventId: asExternalEventId(externalEventId), externalMessageId: asExternalMessageId(stableId),
    conversationType: 'dm', conversationId: actorId,
    conversationKey: createConversationKey({ platform: 'weixin', accountId, channelConfigId, conversationType: 'dm', conversationId: actorId }),
    actorId, text: accepted ? weixinText(message) : '', mentions: [], isBotMentioned: false,
    isBotMessage: !acceptedType, attachments: accepted ? weixinAttachments(message, stableId) : [],
    platformTimestamp: timestamp(message.create_time_ms, receivedAt), receivedAt,
    ...(accepted && message.context_token ? { replyContextToken: message.context_token } : {}),
    rawEventVersion: 'weixin-message-v1',
  }
  return { envelope, status: accepted ? 'ready' : 'filtered' }
}

/** Mattermost direct transport currently returns validated top-level posts from one DM. */
export function mattermostInboxItem(
  channel: WeixinChannel,
  message: DirectMessage,
  isApproved: (userId: string) => boolean,
  receivedAt = Date.now(),
): InboxPageItem {
  const accountId = requiredId(channel.accountId, 'Mattermost accountId')
  const channelConfigId = requiredId(channel.id, 'Mattermost channelConfigId')
  // 自动发现 DM 时，传输层已验证的消息来源比固定配置 targetId 更准确。
  const channelId = requiredId(message.targetId ?? channel.direct?.targetId, 'Mattermost DM channel ID')
  const actorId = requiredId(message.sender, 'Mattermost sender ID')
  const externalMessageId = requiredId(message.id, 'Mattermost post ID')
  const accepted = isApproved(actorId)
  const envelope: InboundEnvelope = {
    platform: 'mattermost', accountId, channelConfigId,
    externalEventId: asExternalEventId(externalMessageId), externalMessageId: asExternalMessageId(externalMessageId),
    conversationType: 'dm', conversationId: channelId,
    conversationKey: createConversationKey({ platform: 'mattermost', accountId, channelConfigId, conversationType: 'dm', conversationId: channelId }),
    channelId, actorId, ...(message.senderName ? { actorName: message.senderName } : {}),
    text: accepted ? message.text : '', mentions: [], isBotMentioned: false, isBotMessage: false,
    attachments: accepted ? (message.media ?? []).map((media, index) => ({
      externalAttachmentId: asExternalAttachmentId(requiredId(media.source, 'Mattermost file ID')),
      fileName: safeFileName(media.name, `附件-${index + 1}`),
      ...(media.mediaType ? { contentType: media.mediaType } : {}),
      ...(media.size === undefined ? {} : { sizeBytes: media.size }),
    })) : [],
    platformTimestamp: timestamp(message.timestamp, receivedAt), receivedAt, rawEventVersion: 'mattermost-post-v1',
  }
  return { envelope, status: accepted ? 'ready' : 'filtered' }
}
