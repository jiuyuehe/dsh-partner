import { createConversationKey } from './conversation-key.js'
import {
  asExternalAttachmentId,
  asExternalEventId,
  asExternalMessageId,
  asConversationKey,
} from './ids.js'
import type { ChannelPlatform, ConversationType, InboundAttachment, InboundEnvelope } from './domain.js'

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
  if (typeof value.isBotMentioned !== 'boolean') throw new Error('isBotMentioned must be a boolean')
  if (typeof value.isBotMessage !== 'boolean') throw new Error('isBotMessage must be a boolean')

  const channelId = optionalString(value, 'channelId')
  const replyToMessageId = optionalString(value, 'replyToMessageId')
  const actorName = optionalString(value, 'actorName')
  const replyContextToken = optionalString(value, 'replyContextToken')
  const rawEventVersion = optionalString(value, 'rawEventVersion')
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
    ...(threadRootId === undefined ? {} : { threadRootId }),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    actorId: requiredString(value, 'actorId'),
    ...(actorName === undefined ? {} : { actorName }),
    text: typeof value.text === 'string' ? value.text : (() => { throw new Error('text must be a string') })(),
    mentions: [...mentions] as string[],
    isBotMentioned: value.isBotMentioned,
    isBotMessage: value.isBotMessage,
    attachments: attachments.map(readAttachment),
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
