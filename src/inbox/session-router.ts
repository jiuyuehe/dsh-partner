import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ChannelSession, Companion } from '../domain.js'
import type { PartnerStore } from '../store.js'
import type { ChannelPlatform, ConversationType } from './domain.js'

/** 渠道来源元数据只用于路由，不会拼进用户正文或模型提示词。 */
export interface InboxSessionIdentity {
  conversationKey: string
  platform: ChannelPlatform
  conversationType: ConversationType
  channelConfigId: string
  accountId: string
  conversationId: string
  channelId?: string
  isChannelConversation?: boolean
  threadRootId?: string
}

/** 将 Durable Inbox 会话稳定映射到独立 DSH Session，并保留历史映射供重启恢复。 */
export class InboxSessionRouter {
  constructor(private readonly store: PartnerStore, private readonly defaultCwd: string) {}

  async ensure(companion: Companion, channelId: string, userId: string, identity: InboxSessionIdentity): Promise<ChannelSession> {
    if (identity.channelConfigId !== channelId || !identity.conversationKey || !identity.accountId || !identity.conversationId) {
      throw new Error('Durable Inbox 会话身份不完整')
    }
    const channel = this.store.snapshot().channels.find(item => item.id === channelId)
    if (!channel || !channel.enabled || channel.companionId !== companion.id || channel.accountId !== identity.accountId
      || (channel.platform ?? 'weixin') !== identity.platform) throw new Error('Durable Inbox 渠道配置已变化')

    const digest = createHash('sha256').update(identity.conversationKey).digest('hex').slice(0, 32)
    const candidate: ChannelSession = {
      id: `route-${randomUUID()}`,
      kind: 'channel',
      channelId,
      userId,
      companionId: companion.id,
      sessionId: `session-${randomUUID()}`,
      cwd: join(this.defaultCwd, 'partners', companion.id, 'channel-sessions', digest),
      lastMessageAt: Date.now(),
      // 沿用联系人私有记忆键，旧联系人记忆保持可读且不会并入主会话。
      memoryScopeId: identity.platform === 'mattermost' && identity.conversationType === 'thread'
        ? `${channelId}:mattermost-thread:${identity.threadRootId}`
        : `${channelId}:${userId}`,
      inboxConversationKey: identity.conversationKey,
      inboxPlatform: identity.platform,
      inboxAccountId: identity.accountId,
      inboxConversationType: identity.conversationType,
      inboxConversationId: identity.conversationId,
      ...(identity.channelId === undefined ? {} : { inboxChannelId: identity.channelId }),
      ...(identity.isChannelConversation ? { inboxIsChannelConversation: true } : {}),
      ...(identity.threadRootId === undefined ? {} : { inboxThreadRootId: identity.threadRootId }),
      lastActorId: userId,
    }

    let result: ChannelSession | undefined
    await this.store.update(state => {
      const currentChannel = state.channels.find(item => item.id === channelId)
      if (this.store.isCompanionRemoving(companion.id) || !state.companions.some(item => item.id === companion.id)) throw new Error('伙伴已移除')
      if (!currentChannel?.enabled || currentChannel.accountId !== identity.accountId || currentChannel.companionId !== companion.id
        || (currentChannel.platform ?? 'weixin') !== identity.platform) throw new Error('Durable Inbox 渠道授权已变化')
      const existing = state.sessions.find(item => item.companionId === companion.id && item.inboxConversationKey === identity.conversationKey)
      if (existing) {
        const sharedMattermostThread = identity.platform === 'mattermost' && identity.conversationType === 'thread'
        // 兼容旧 DM 路由中未保存该标志的情况，同时严格隔离 Mattermost 频道线程。
        if (existing.channelId !== channelId || (!sharedMattermostThread && existing.userId !== userId) || existing.inboxAccountId !== identity.accountId
          || existing.inboxPlatform !== identity.platform || existing.inboxConversationId !== identity.conversationId
          || existing.inboxConversationType !== identity.conversationType || existing.inboxChannelId !== identity.channelId
          || existing.inboxThreadRootId !== identity.threadRootId
          || (existing.inboxIsChannelConversation === true) !== (identity.isChannelConversation === true)) throw new Error('Durable Inbox 会话键与已保存来源不一致')
        existing.lastActorId = userId
        existing.lastMessageAt = Date.now()
        result = existing
        return
      }
      state.sessions.push(candidate)
      result = candidate
    })
    return result!
  }
}
