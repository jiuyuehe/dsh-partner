import { createConversationKey } from './conversation-key.js'
import { asExternalAttachmentId, asExternalEventId, asExternalMessageId } from './ids.js'
import type { InboundEnvelope, WeixinMediaSource } from './domain.js'
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

function weixinMediaSources(message: WeixinRawMessage): WeixinMediaSource[] {
  const result: WeixinMediaSource[] = []
  for (const item of message.item_list ?? []) {
    if (item.type === 2 && item.image_item) {
      const source = item.image_item
      result.push({
        kind: 'image' as const,
        ...(source.filename ? { fileName: safeFileName(source.filename, '微信图片') } : {}),
        ...(source.content_type ? { contentType: source.content_type } : {}),
        ...(source.aeskey ? { imageAesKey: source.aeskey } : {}),
        ...(source.media?.full_url ? { fullUrl: source.media.full_url } : {}),
        ...(source.media?.encrypt_query_param ? { encryptQueryParam: source.media.encrypt_query_param } : {}),
        ...(source.media?.aes_key ? { aesKey: source.media.aes_key } : {}),
        ...(source.media?.encrypt_type === undefined ? {} : { encryptType: source.media.encrypt_type }),
      })
      continue
    }
    if (item.type === 4 && item.file_item) {
      const source = item.file_item
      result.push({
        kind: 'file' as const,
        ...(source.file_name || source.filename ? { fileName: safeFileName(source.file_name ?? source.filename, '微信文件') } : {}),
        ...(source.content_type ? { contentType: source.content_type } : {}),
        ...(source.media?.full_url ? { fullUrl: source.media.full_url } : {}),
        ...(source.media?.encrypt_query_param ? { encryptQueryParam: source.media.encrypt_query_param } : {}),
        ...(source.media?.aes_key ? { aesKey: source.media.aes_key } : {}),
        ...(source.media?.encrypt_type === undefined ? {} : { encryptType: source.media.encrypt_type }),
      })
    }
  }
  return result
}

/** 先完成授权判断再规范化微信事件；未批准联系人的正文不会进入持久化收件箱。 */
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
    ...(accepted && message.item_list?.some(item => item.type === 2 || item.type === 4) ? { weixinMediaSources: weixinMediaSources(message) } : {}),
    platformTimestamp: timestamp(message.create_time_ms, receivedAt), receivedAt,
    ...(accepted && message.context_token ? { replyContextToken: message.context_token } : {}),
    rawEventVersion: 'weixin-message-v1',
  }
  return { envelope, status: accepted ? 'ready' : 'filtered' }
}

/** 将 Mattermost 传输层返回的已验证私聊帖子转换成统一事件。 */
export function mattermostInboxItem(
  channel: WeixinChannel,
  message: DirectMessage,
  isApproved: (userId: string, targetId: string, conversationType: 'dm'|'thread', isChannelConversation: boolean) => boolean,
  receivedAt = Date.now(),
  isChannelConversation = false,
): InboxPageItem {
  const accountId = requiredId(channel.accountId, 'Mattermost accountId')
  const channelConfigId = requiredId(channel.id, 'Mattermost channelConfigId')
  // 自动发现 DM 时，传输层已验证的消息来源比固定配置 targetId 更准确。
  const channelId = requiredId(message.targetId ?? channel.direct?.targetId, 'Mattermost DM channel ID')
  const actorId = requiredId(message.sender, 'Mattermost sender ID')
  const externalMessageId = requiredId(message.id, 'Mattermost post ID')
  const isBotMentioned = message.isBotMentioned === true
  const isBotAuthor = actorId === accountId
  const threadRootId = message.rootId ?? (isChannelConversation && isBotMentioned ? externalMessageId : undefined)
  const conversationType = threadRootId ? 'thread' : 'dm'
  // 机器人自己的帖子即使带有提及元数据，也不能作为新请求重新进入收件链路。
  // Mattermost 频道中的顶层消息和线程回复还必须明确 @机器人，避免普通消息触发 Agent。
  const accepted = !isBotAuthor && (!isChannelConversation || isBotMentioned)
    && isApproved(actorId, channelId, conversationType, isChannelConversation)
  // 优先按帖子正文版本去重；update_at 也会随线程活动变化，不能单独充当事件版本。
  const eventVersion = message.contentVersion
    ? `${externalMessageId}:${message.contentVersion}`
    : message.updateAt === undefined ? externalMessageId : `${externalMessageId}:${message.updateAt}`
  const envelope: InboundEnvelope = {
    platform: 'mattermost', accountId, channelConfigId,
    externalEventId: asExternalEventId(eventVersion), externalMessageId: asExternalMessageId(externalMessageId),
    conversationType, conversationId: channelId,
    conversationKey: createConversationKey({ platform: 'mattermost', accountId, channelConfigId, conversationType, conversationId: channelId, ...(threadRootId ? {threadRootId} : {}) }),
    channelId, ...(isChannelConversation ? {isChannelConversation:true} : {}), ...(threadRootId ? {threadRootId,replyToMessageId:externalMessageId} : {}),
    actorId, ...(message.senderName ? { actorName: message.senderName } : {}),
    text: accepted ? message.text : '', mentions: message.mentions ?? [], isBotMentioned, isBotMessage: false,
    attachments: accepted ? (message.media ?? []).map((media, index) => ({
      externalAttachmentId: asExternalAttachmentId(requiredId(media.source, 'Mattermost file ID')),
      fileName: safeFileName(media.name, `附件-${index + 1}`),
      ...(media.mediaType ? { contentType: media.mediaType } : {}),
      ...(media.size === undefined ? {} : { sizeBytes: media.size }),
    })) : [],
    ...(accepted&&message.mattermostContext?.length?{mattermostContext:message.mattermostContext}:{}),
    platformTimestamp: timestamp(message.timestamp, receivedAt), receivedAt,
    rawEventVersion: `mattermost-post-v3:${message.contentVersion??message.updateAt??0}`,
  }
  return { envelope, status: accepted ? 'ready' : 'filtered' }
}
