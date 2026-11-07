import { createConversationKey } from './conversation-key.js'
import {
  asExternalAttachmentId,
  asExternalEventId,
  asExternalMessageId,
  asConversationKey,
} from './ids.js'
import type { ChannelPlatform, ConversationType, InboundAttachment, InboundEnvelope, MattermostContextPost, WeixinMediaSource } from './domain.js'

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: RecordValue, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function optionalString(record: RecordValue, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${field} must be a non-empty string when present`)
  }
  return value
}

function optionalBoundedString(record: RecordValue, field: string, limit = 16_384): string | undefined {
  const value = optionalString(record, field)
  if (value !== undefined && value.length > limit) throw new Error(`${field} exceeds its size limit`)
  return value
}

function requiredTimestamp(record: RecordValue, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`)
  }
  return value
}

function readAttachment(value: unknown, index: number): InboundAttachment {
  if (!isRecord(value)) throw new Error(`attachments[${index}] must be an object`)
  const contentType = optionalString(value, 'contentType')
  const sizeBytes = value.sizeBytes
  if (sizeBytes !== undefined && (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
    throw new Error(`attachments[${index}].sizeBytes must be a non-negative integer`)
  }
  return {
    externalAttachmentId: asExternalAttachmentId(requiredString(value, 'externalAttachmentId')),
    fileName: requiredString(value, 'fileName'),
    ...(contentType === undefined ? {} : { contentType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  }
}

function readWeixinMediaSource(value: unknown, index: number): WeixinMediaSource {
  if (!isRecord(value)) throw new Error(`weixinMediaSources[${index}] must be an object`)
  const kind = value.kind
  if (kind !== 'image' && kind !== 'file') throw new Error(`weixinMediaSources[${index}].kind is invalid`)
  const encryptType = value.encryptType
  if (encryptType !== undefined && (typeof encryptType !== 'number' || !Number.isSafeInteger(encryptType) || encryptType < 0)) {
    throw new Error(`weixinMediaSources[${index}].encryptType is invalid`)
  }
  const fileName = optionalBoundedString(value, 'fileName', 255)
  const contentType = optionalBoundedString(value, 'contentType', 255)
  const imageAesKey = optionalBoundedString(value, 'imageAesKey', 256)
  const fullUrl = optionalBoundedString(value, 'fullUrl')
  const encryptQueryParam = optionalBoundedString(value, 'encryptQueryParam', 16_384)
  const aesKey = optionalBoundedString(value, 'aesKey', 256)
  return {
    kind,
    ...(fileName === undefined ? {} : { fileName }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(imageAesKey === undefined ? {} : { imageAesKey }),
    ...(fullUrl === undefined ? {} : { fullUrl }),
    ...(encryptQueryParam === undefined ? {} : { encryptQueryParam }),
    ...(aesKey === undefined ? {} : { aesKey }),
    ...(encryptType === undefined ? {} : { encryptType }),
  }
}

/** 只持久化经过限长的 Mattermost 线程纯文本，不保存帖子原始对象或附件 URL。 */
function readMattermostContextPost(value: unknown, index: number): MattermostContextPost {
  if (!isRecord(value)) throw new Error(`mattermostContext[${index}] must be an object`)
  const actorName = optionalBoundedString(value, 'actorName', 120)
  const text = value.text
  if (typeof text !== 'string' || text.length > 8_000) throw new Error(`mattermostContext[${index}].text is invalid`)
  if (typeof value.isBot !== 'boolean') throw new Error(`mattermostContext[${index}].isBot must be a boolean`)
  return {
    postId: requiredString(value, 'postId'),
    actorId: requiredString(value, 'actorId'),
    ...(actorName === undefined ? {} : { actorName }),
    text,
    timestamp: requiredTimestamp(value, 'timestamp'),
    isBot: value.isBot,
  }
}

/** Validates and normalizes the durable envelope shape; it is not a model-prompt formatter. */
export function assertInboundEnvelope(value: unknown): InboundEnvelope {
  if (!isRecord(value)) throw new Error('InboundEnvelope must be an object')
  const platform = value.platform
  if (platform !== 'weixin' && platform !== 'mattermost') throw new Error('platform is invalid')
  const conversationType = value.conversationType
  if (conversationType !== 'dm' && conversationType !== 'channel' && conversationType !== 'thread') {
    throw new Error('conversationType is invalid')
  }
  const accountId = requiredString(value, 'accountId')
  const channelConfigId = requiredString(value, 'channelConfigId')
  const conversationId = requiredString(value, 'conversationId')
  const threadRootId = optionalString(value, 'threadRootId')
  const conversationKey = asConversationKey(requiredString(value, 'conversationKey'))
  const expectedKey = createConversationKey({
    platform: platform as ChannelPlatform,
    accountId,
    channelConfigId,
    conversationType: conversationType as ConversationType,
    conversationId,
    ...(threadRootId === undefined ? {} : { threadRootId }),
  })
  if (expectedKey !== conversationKey) throw new Error('conversationKey does not match stable source identity')

  const mentions = value.mentions
  if (!Array.isArray(mentions) || mentions.some(item => typeof item !== 'string')) {
    throw new Error('mentions must be an array of strings')
  }
  const attachments = value.attachments
  if (!Array.isArray(attachments)) throw new Error('attachments must be an array')
  const rawWeixinMediaSources = value.weixinMediaSources
  if (rawWeixinMediaSources !== undefined && (platform !== 'weixin' || !Array.isArray(rawWeixinMediaSources) || rawWeixinMediaSources.length > 8)) {
    throw new Error('weixinMediaSources is invalid for this platform or exceeds the attachment limit')
  }
  if (typeof value.isBotMentioned !== 'boolean') throw new Error('isBotMentioned must be a boolean')
  if (typeof value.isBotMessage !== 'boolean') throw new Error('isBotMessage must be a boolean')

  const channelId = optionalString(value, 'channelId')
  const isChannelConversation = value.isChannelConversation
  if (isChannelConversation !== undefined && (typeof isChannelConversation !== 'boolean' || platform !== 'mattermost')) {
    throw new Error('isChannelConversation is invalid for this platform')
  }
  if (isChannelConversation === true && conversationType !== 'thread') throw new Error('Mattermost channel messages must be normalized to a thread source')
  const replyToMessageId = optionalString(value, 'replyToMessageId')
  const actorName = optionalString(value, 'actorName')
  const replyContextToken = optionalString(value, 'replyContextToken')
  const rawEventVersion = optionalString(value, 'rawEventVersion')
  const rawMattermostContext = value.mattermostContext
  if (rawMattermostContext !== undefined && (platform !== 'mattermost' || !Array.isArray(rawMattermostContext) || rawMattermostContext.length > 60)) {
    throw new Error('mattermostContext is invalid for this platform or exceeds its limit')
  }
  const mattermostContextRounds = value.mattermostContextRounds
  if (mattermostContextRounds !== undefined && (platform !== 'mattermost' || !Number.isSafeInteger(mattermostContextRounds) || (mattermostContextRounds as number) < 0 || (mattermostContextRounds as number) > 10)) {
    throw new Error('mattermostContextRounds is invalid for this platform')
  }
  return {
    platform,
    accountId,
    channelConfigId,
    externalEventId: asExternalEventId(requiredString(value, 'externalEventId')),
    externalMessageId: asExternalMessageId(requiredString(value, 'externalMessageId')),
    conversationType,
    conversationId,
    conversationKey,
    ...(channelId === undefined ? {} : { channelId }),
    ...(isChannelConversation === true ? { isChannelConversation: true } : {}),
    ...(threadRootId === undefined ? {} : { threadRootId }),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    actorId: requiredString(value, 'actorId'),
    ...(actorName === undefined ? {} : { actorName }),
    text: typeof value.text === 'string' ? value.text : (() => { throw new Error('text must be a string') })(),
    mentions: [...mentions] as string[],
    isBotMentioned: value.isBotMentioned,
    isBotMessage: value.isBotMessage,
    attachments: attachments.map(readAttachment),
    ...(rawWeixinMediaSources === undefined ? {} : { weixinMediaSources: rawWeixinMediaSources.map(readWeixinMediaSource) }),
    ...(rawMattermostContext === undefined ? {} : { mattermostContext: rawMattermostContext.map(readMattermostContextPost) }),
    ...(mattermostContextRounds === undefined ? {} : { mattermostContextRounds: mattermostContextRounds as number }),
    platformTimestamp: requiredTimestamp(value, 'platformTimestamp'),
    receivedAt: requiredTimestamp(value, 'receivedAt'),
    ...(replyContextToken === undefined ? {} : { replyContextToken }),
    ...(rawEventVersion === undefined ? {} : { rawEventVersion }),
  }
}

export function serializeInboundEnvelope(envelope: InboundEnvelope): string {
  return JSON.stringify(assertInboundEnvelope(envelope))
}

export function deserializeInboundEnvelope(serialized: string): InboundEnvelope {
  return assertInboundEnvelope(JSON.parse(serialized) as unknown)
}
