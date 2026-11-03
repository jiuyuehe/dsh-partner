import type { ChannelSession, PartnerState, WeixinChannel } from '../domain.js'
import { channelReplyAllowed } from './reply-access.js'

/** Discovery metadata only. The named tool must still enforce live authorization. */
export interface ChannelActivity {
  id: string
  title: string
  tool: string
  visibility: 'public' | 'private'
  description: string
  operations?: readonly string[]
}
export interface ChannelActivityContext {
  channel: Readonly<WeixinChannel>
  companionId: string
  /** Existing, approved targets of this channel only; never a cross-channel recipient list. */
  sessions: readonly Readonly<ChannelSession>[]
}
export interface ChannelActivityProvider {
  id: string
  /** '*' supplies common activities; concrete providers extend their own channel. */
  platform: string
  discover(context: ChannelActivityContext): readonly ChannelActivity[]
}
export interface ChannelActivitySummary {
  channelId: string
  platform: string
  provider: string
  activities: ChannelActivity[]
}

/** Per-plugin-instance registry. Registration does not install tools or grant permissions. */
export class ChannelActivityRegistry {
  private readonly providers = new Map<string, ChannelActivityProvider>()
  constructor(private readonly onError: (provider: string, error: unknown) => void = () => {}) {}
  register(provider: ChannelActivityProvider): () => void {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(provider.id) || !provider.platform || typeof provider.discover !== 'function') throw Error('Invalid channel activity provider')
    if (this.providers.has(provider.id)) throw Error('Channel activity provider already registered: ' + provider.id)
    const registration = {...provider}
    this.providers.set(registration.id, registration)
    return () => { if (this.providers.get(registration.id) === registration) this.providers.delete(registration.id) }
  }
  describe(state: PartnerState, companionId: string): ChannelActivitySummary[] {
    const result: ChannelActivitySummary[] = []
    for (const channel of state.channels.filter(c => c.companionId === companionId && c.enabled)) {
      const platform = channel.platform ?? 'weixin'
      for (const provider of this.providers.values()) {
        if (provider.platform !== '*' && provider.platform !== platform) continue
        try {
          const sessions = state.sessions.filter(r => r.companionId === companionId && r.channelId === channel.id && r.kind === 'channel' && channelReplyAllowed(state, channel.id, r.userId))
          // A discovery callback cannot accidentally edit stored channel settings or routes.
          const entries = provider.discover({channel: structuredClone(channel), companionId, sessions: structuredClone(sessions)})
          if (!Array.isArray(entries) || entries.length > 64) throw Error('Invalid activity list')
          const ids = new Set<string>()
          const activities: ChannelActivity[] = entries.map(a => {
            if (!a || typeof a.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(a.id) || ids.has(a.id) ||
              typeof a.title !== 'string' || !a.title.trim() || a.title.length > 100 || typeof a.description !== 'string' || a.description.length > 1000 ||
              !['public','private'].includes(a.visibility) || typeof a.tool !== 'string' || !/^[a-zA-Z0-9_.:-]{1,150}$/.test(a.tool) ||
              (a.operations !== undefined && (!Array.isArray(a.operations) || a.operations.length > 256 || a.operations.some((op: unknown) => typeof op !== 'string' || !/^[a-zA-Z0-9_.:-]{1,150}$/.test(op))))) throw Error('Invalid channel activity metadata')
            ids.add(a.id)
            return {id:a.id,title:a.title,tool:a.tool,visibility:a.visibility,description:a.description,...(a.operations ? {operations:[...a.operations]} : {})}
          })
          if (activities.length) result.push({channelId:channel.id,platform,provider:provider.id,activities})
        } catch (error) { this.onError(provider.id, error) }
      }
    }
    return result
  }
}
