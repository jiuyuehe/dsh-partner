import { OneBotTransport } from '../qq/transport.js'
import { qqId } from '../qq/message.js'
import type { OneBotConnection } from '../qq/connection.js'
import { createHash, randomUUID } from 'node:crypto'
import type { PartnerOutboundAttachment } from '../../channel-message.js'
import { pollDiscovered } from './discovery.js'
import { formatDirectMessages } from './message-format.js'
import { directProgressTransport, type ProgressTransport } from './progress-transport.js'
import { DirectMediaTransfer, type DirectMedia } from './media.js'
import { matrixMessage } from './message.js'
import {matrixTimeline} from './matrix-timeline.js'

export type DirectPlatform = 'matrix' | 'mattermost' | 'qq'
export interface DirectConfig {
  qq?: import('../qq/settings.js').QqSettings
  platform: DirectPlatform
  baseUrl: string
  targetId: string
  /** Mattermost channel mode is distinct from a verified two-person DM. */
  roomMode?: 'dm' | 'mattermost-channel' | 'mattermost-thread'
  threadRootId?: string | undefined
  allowedChannelIds?: string[]
}
export interface DirectMessage {
  qqReplyId?:string; qqQuote?:import('../qq/quote.js').QqQuote; senderName?: string
  qqGroup?: {groupId:string;userId:string;senderName:string;mentioned:boolean;autonomous:boolean;otherMention?:boolean;hasReply?:boolean;replyToId?:string;replyTo?:'self'|'other'}
  id: string; sender: string; text: string; targetId?: string; media?: DirectMedia[]; timestamp?: number; receivedAt?: number
  /** Mattermost root_id；顶层 @ 机器人帖子由规范化层以自身 post ID 作为 root。 */
  rootId?: string
  mentions?: string[]
  isBotMentioned?: boolean
  updateAt?: number
  /** Mattermost 帖子正文版本；不把线程回复造成的 update_at 变化当作新消息。 */
  contentVersion?: string
  mattermostContext?: import('../../inbox/domain.js').MattermostContextPost[]
}
export interface DirectBatch { cursor: string; messages: DirectMessage[]; warning?: string }
export interface ChannelSender {
  sendText(userId: string, text: string, context: string | undefined, signal?: AbortSignal): Promise<void>
  sendAttachment(userId: string, file: PartnerOutboundAttachment, context: string | undefined, signal?: AbortSignal): Promise<void>
}
/** 未明确标记为 Mattermost 频道/线程时，所有私聊传输都必须绑定已验证联系人。 */
function requiresVerifiedPeer(config: DirectConfig): boolean {
  return config.platform === 'matrix'
    || config.roomMode !== 'mattermost-channel' && config.roomMode !== 'mattermost-thread'
}
export class ChannelHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 0) { super(`渠道请求失败（HTTP ${status}）`) }
}
export function directConfig(value: Record<string, unknown>): DirectConfig {
  if (value.platform !== 'matrix' && value.platform !== 'mattermost' && value.platform !== 'qq') throw new Error('请选择 QQ、Matrix 或 Mattermost')
  if (typeof value.baseUrl !== 'string' || (value.targetId !== undefined && (typeof value.targetId !== 'string' || value.targetId.length > 512))) throw new Error('服务器地址或会话 ID 无效')
  const url = new URL(value.baseUrl)
  if (!(value.platform === 'qq' ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('连接地址协议不匹配；QQ 使用 ws:// 或 wss://，其他平台使用 HTTP(S)，令牌请单独填写')
  if (value.platform === 'qq' && value.targetId && !qqId(String(value.targetId).trim())) throw new Error('固定联系人请填写 QQ 号码')
  const allowedChannelIds = value.allowedChannelIds === undefined ? [] : value.allowedChannelIds
  if (!Array.isArray(allowedChannelIds) || allowedChannelIds.length > 50 || allowedChannelIds.some(id => typeof id !== 'string' || !/^[a-z0-9]{26}$/.test(id))) throw new Error('Mattermost 允许频道列表无效')
  if (allowedChannelIds.length && value.platform !== 'mattermost') throw new Error('只有 Mattermost 支持频道白名单')
  return {
    platform: value.platform, baseUrl: url.toString().replace(/\/$/, ''), targetId: (value.targetId as string|undefined)?.trim() ?? '',
    ...(allowedChannelIds.length ? { allowedChannelIds: [...new Set(allowedChannelIds as string[])] } : {}),
  }
}

/** Explicit, two-member conversations only. No group inference from display names. */
export class DirectTransport implements ChannelSender {
  private botId = ''
  private botUsername = ''
  private peerId = ''
  private readonly qq: OneBotTransport | undefined
  constructor(readonly config: DirectConfig, private readonly token: string, private readonly expected?: {accountId: string; peerId: string}, private readonly authorize?: () => void, connection?: OneBotConnection) {
    if (config.platform === 'qq') this.qq = new OneBotTransport(config, token, expected, connection)
  }
  get onebot(): OneBotTransport | undefined { return this.qq }
  forTarget(targetId: string, expected: {accountId: string; peerId: string}, authorize?: () => void): DirectTransport {
    return new DirectTransport({...this.config,targetId,roomMode:'dm',threadRootId:undefined},this.token,expected,authorize,this.qq?.connection)
  }
  /** 用已配置的频道白名单建立独立收发器，避免把频道误当成双人私聊。 */
  forMattermostChannel(channelId: string, expectedAccountId = this.expected?.accountId ?? this.botId, authorize?: () => void): DirectTransport {
    if (this.config.platform !== 'mattermost' || !this.config.allowedChannelIds?.includes(channelId)) throw new Error('Mattermost 频道未列入允许列表')
    return new DirectTransport({ ...this.config, targetId: channelId, roomMode: 'mattermost-channel', threadRootId: undefined }, this.token,
      { accountId: expectedAccountId, peerId: '' }, authorize)
  }
  /** 线程根 ID 来源于已验证的入站帖子或固定收件路由，绝不接受模型自报地址。 */
  forThread(channelId: string, rootId: string, expectedAccountId = this.expected?.accountId ?? this.botId, authorize?: () => void, conversationKind: 'dm' | 'channel' = 'dm'): DirectTransport {
    if (this.config.platform !== 'mattermost' || !/^[a-z0-9]{26}$/.test(channelId) || !/^[a-z0-9]{26}$/.test(rootId)) throw new Error('Mattermost 线程来源无效')
    if (conversationKind === 'channel' && !this.config.allowedChannelIds?.includes(channelId)) throw new Error('Mattermost 线程频道未列入允许列表')
    return new DirectTransport({ ...this.config, targetId: channelId, roomMode: 'mattermost-thread', threadRootId: rootId }, this.token,
      { accountId: expectedAccountId, peerId: conversationKind === 'dm' ? this.expected?.peerId ?? '' : '' }, authorize)
  }
  get mattermostBotUsername(): string { return this.botUsername }
  async mattermostChannels(signal?: AbortSignal): Promise<Array<{ id: string; name: string; displayName: string; type: 'O' | 'P' }>> {
    if (this.config.platform !== 'mattermost') throw new Error('只有 Mattermost 支持频道目录')
    this.authorize?.()
    if (!this.botId) await this.validate(signal)
    const result: Array<{ id: string; name: string; displayName: string; type: 'O' | 'P' }> = []
    for (let page = 0; page < 5; page++) {
      const entries = await this.request(`/api/v4/users/${encodeURIComponent(this.botId)}/channels?page=${page}&per_page=200`, signal)
      if (!Array.isArray(entries)) throw new Error('Mattermost 频道目录响应无效')
      for (const item of entries) {
        if ((item?.type !== 'O' && item?.type !== 'P') || item.delete_at || typeof item.id !== 'string' || typeof item.name !== 'string') continue
        result.push({ id: item.id, name: item.name, displayName: typeof item.display_name === 'string' && item.display_name ? item.display_name : item.name, type: item.type })
      }
      if (entries.length < 200) break
    }
    if (result.length > 1000) throw new Error('Mattermost 已加入频道超过读取上限')
    return result
  }
  close(): void { this.qq?.connection.close() }


  private async request(path: string, signal?: AbortSignal, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<any> {
    const response = await fetch(this.config.baseUrl + path, {
      method, redirect: 'error', headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
    })
    if (!response.ok) {
      const header=response.headers.get('retry-after')
      const retry=header ? (/^\d+$/.test(header) ? Number(header)*1000 : Date.parse(header)-Date.now()) : 0
      throw new ChannelHttpError(response.status,Number.isFinite(retry)?Math.max(0,Math.min(900_000,retry)):0)
    }
    if (response.status === 204) return {}
    if (!response.body) throw new Error('渠道返回空响应')
    let size = 0
    const chunks: Uint8Array[] = []
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > 4 * 1024 * 1024) throw new Error('渠道响应超过大小限制')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async validate(signal?: AbortSignal): Promise<{accountId: string; peerId: string; username?: string}> {
    this.authorize?.()
    if (this.qq) return this.qq.validate(signal)
    if(!this.config.targetId) {
      const who=await this.request(this.config.platform==='matrix'?'/_matrix/client/v3/account/whoami':'/api/v4/users/me',signal)
      const id=this.config.platform==='matrix'?who.user_id:who.id
      if(typeof id!=='string'||!id||this.expected&&this.expected.accountId!==id)throw new Error('渠道账号身份无效或已变化')
      this.botId=id
      if (this.config.platform === 'mattermost') this.botUsername = typeof who.username === 'string' ? who.username : ''
      return {accountId:id,peerId:'',...(this.botUsername?{username:this.botUsername}:{})}
    }
    const target = encodeURIComponent(this.config.targetId)
    if (this.config.platform === 'matrix') {
      const who = await this.request('/_matrix/client/v3/account/whoami', signal)
      if (typeof who.user_id !== 'string') throw new Error('Matrix 用户身份无效')
      const state = await this.request(`/_matrix/client/v3/rooms/${target}/state`, signal)
      if (!Array.isArray(state)) throw new Error('Matrix 房间状态无效')
      if (state.some(e => e.type === 'm.room.encryption')) throw new Error('检测到 Matrix 加密房间：暂不支持端到端加密，无法读取消息或发送配对码。请新建未开启加密的双人会话，邀请机器人后发送文字消息。')
      const members = state.filter(e => e.type === 'm.room.member' && e.content?.membership === 'join').map(e => e.state_key)
      if (members.length !== 2 || !members.includes(who.user_id) || members.some(id => typeof id !== 'string')) throw new Error('Matrix 房间必须只有机器人和一位已加入的联系人')
      this.botId = who.user_id; this.peerId = members.find(id => id !== this.botId)!
    } else {
      const who = await this.request('/api/v4/users/me', signal)
      const room = await this.request(`/api/v4/channels/${target}`, signal)
      if (typeof who.id !== 'string') throw new Error('Mattermost 机器人身份无效')
      this.botId = who.id; this.botUsername = typeof who.username === 'string' ? who.username : ''
      if (this.config.roomMode === 'mattermost-channel' || this.config.roomMode === 'mattermost-thread') {
        const threadInChannel = this.config.roomMode === 'mattermost-thread' && Boolean(this.config.allowedChannelIds?.includes(this.config.targetId))
        if (this.config.roomMode === 'mattermost-channel' && !this.config.allowedChannelIds?.includes(this.config.targetId)) throw new Error('Mattermost 频道未列入允许列表')
        const validType = this.config.roomMode === 'mattermost-thread' && !threadInChannel
          ? room.type === 'D'
          : room.type === 'O' || room.type === 'P'
        if (!validType) throw new Error('Mattermost 目标会话类型与线程来源不匹配')
        if (this.config.allowedChannelIds?.length && !this.config.allowedChannelIds.includes(this.config.targetId)) throw new Error('Mattermost 频道已不在允许列表中')
        const membership = await this.request(`/api/v4/channels/${target}/members/${encodeURIComponent(who.id)}`, signal)
        if (membership.user_id !== who.id || membership.channel_id !== this.config.targetId) throw new Error('Mattermost 机器人不在目标频道中')
        if (room.type === 'D') {
          const members = await this.request(`/api/v4/channels/${target}/members?page=0&per_page=3`, signal)
          const peer = Array.isArray(members) ? members.find((member:any)=>member.user_id!==who.id)?.user_id : undefined
          if (!Array.isArray(members) || members.length !== 2 || members.filter((member:any)=>member.user_id===who.id).length !== 1
            || typeof peer !== 'string' || this.expected?.peerId && peer !== this.expected.peerId) throw new Error('Mattermost DM 线程成员与已验证联系人不匹配')
          this.peerId = peer
        }
        this.peerId = ''
        if (this.expected && this.expected.accountId !== this.botId) throw new Error('Mattermost 机器人账号已变化')
        return { accountId: this.botId, peerId: '', ...(this.botUsername ? { username: this.botUsername } : {}) }
      }
      const members = await this.request(`/api/v4/channels/${target}/members?page=0&per_page=3`, signal)
      if (room.type !== 'D' || !Array.isArray(members) || members.length !== 2 || !members.some(m => m.user_id === who.id)) throw new Error('Mattermost 目标必须是机器人已加入的双人 DM，不能是群组或公开频道')
      const peer = members.find(m => m.user_id !== who.id)?.user_id
      if (typeof peer !== 'string') throw new Error('Mattermost 联系人无效')
      this.peerId = peer
    }
    if(this.expected && (this.expected.accountId!==this.botId||this.expected.peerId!==this.peerId))throw new Error('机器人或会话成员已变化，请重新配置，禁止沿用旧会话权限')
    return {accountId: this.botId, peerId: this.peerId, ...(this.botUsername ? { username: this.botUsername } : {})}
  }

  async poll(cursor: string | undefined, signal: AbortSignal, waitMs = 20000): Promise<DirectBatch> {
    if (this.qq) return this.qq.poll(signal, waitMs)
    await this.validate(signal)
    if(!this.config.targetId)return pollDiscovered(this.config.platform,this.botId,cursor,signal,
      (path,body)=>this.request(path,signal,body),
      targetId=>new DirectTransport({...this.config,targetId},this.token),waitMs)
    if (this.config.platform === 'matrix') {
      const filter = JSON.stringify({room:{rooms:[this.config.targetId],timeline:{limit:100}},presence:{types:[]}})
      const data = await this.request('/_matrix/client/v3/sync?timeout='+waitMs+'&filter='+encodeURIComponent(filter)+(cursor ? '&since='+encodeURIComponent(cursor) : ''), signal)
      if (typeof data.next_batch !== 'string') throw new Error('Matrix 同步游标缺失')
      const room = data.rooms?.join?.[this.config.targetId]
      const identity = {accountId: this.botId, peerId: this.peerId}
      const events = await matrixTimeline(this.config.targetId, room?.timeline, cursor, data.next_batch, path => this.request(path, signal), signal)
      if (cursor && room?.timeline?.limited) {
        const current = await this.validate(signal)
        if (current.accountId !== identity.accountId || current.peerId !== identity.peerId) throw new Error('Matrix 补拉期间会话成员已变化，保留原游标')
      }
      const messages: DirectMessage[] = []
      // First sync establishes a watermark, never executes historical messages.
      for (const event of events) {
        const message = matrixMessage(event, this.peerId)
        if (message) messages.push(message)
      }
      return {cursor:data.next_batch,messages}
    }
    const postsPath = `/api/v4/channels/${encodeURIComponent(this.config.targetId)}/posts` + (cursor
      ? `?since=${encodeURIComponent(cursor)}`
      : '?page=0&per_page=200')
    const data = await this.request(postsPath, signal)
    if (!Array.isArray(data.order) || !data.posts) throw new Error('Mattermost 消息响应无效')
    // 官方 since 接口最多返回 1000 条且不能同时使用分页参数；满页时保留旧游标避免静默漏消息。
    if (cursor && data.order.length >= 1000) throw new Error('Mattermost 消息积压达到 since 接口上限，保留原游标并暂停以免遗漏')
    const posts = data.order.map((id: string) => data.posts[id]).filter((p: any) => p && Number.isFinite(p.create_at))
      .sort((a:any,b:any)=>(a.update_at??a.create_at)-(b.update_at??b.create_at)||String(a.id).localeCompare(String(b.id)))
    const next = Math.max(Number(cursor ?? 0), ...posts.map((p:any)=>p.update_at??p.create_at))
    // 尽量在构造入站消息前完成过滤：频道只构造他人明确 @机器人的帖子，机器人自己的回复始终丢弃。
    const selectedPosts = cursor ? posts.filter((post:any) => {
      if (!post.id || post.user_id === this.botId || post.type || post.delete_at) return false
      if (this.config.roomMode === 'mattermost-channel') return mattermostPostMentionsBot(post, this.botId, this.botUsername)
      return post.user_id === this.peerId
    }) : []
    const messages = selectedPosts.map((post:any) => {
      const mentions = Array.isArray(post.metadata?.mentions) ? post.metadata.mentions.filter((id:unknown):id is string=>typeof id==='string') : []
      const isBotMentioned = mattermostPostMentionsBot(post, this.botId, this.botUsername)
      // Mattermost since 会在帖子或线程活动后返回旧帖子；以正文变化生成稳定版本，忽略仅由回复引起的 update_at 变化。
      const contentVersion = createHash('sha256').update(JSON.stringify({
        channelId: post.channel_id ?? this.config.targetId,
        senderId: post.user_id ?? '',
        rootId: post.root_id ?? '',
        message: typeof post.message === 'string' ? post.message : '',
        mentions: [...mentions].sort(),
        fileIds: Array.isArray(post.file_ids) ? post.file_ids.filter((id:unknown):id is string=>typeof id==='string').sort() : [],
        editAt: Number.isFinite(post.edit_at) ? post.edit_at : 0,
      })).digest('hex')
      return {
        id:post.id, sender:post.user_id, text:post.message ?? '', targetId:this.config.targetId,
        timestamp:post.create_at, updateAt:post.update_at??post.create_at,
        contentVersion,
        ...(post.root_id ? { rootId:post.root_id } : {}),
        ...(mentions.length ? { mentions } : {}), isBotMentioned,
        ...(Array.isArray(post.mattermost_context)?{mattermostContext:post.mattermost_context}:{}),
        ...(Array.isArray(post.file_ids)&&post.file_ids.length?{media:post.file_ids.map((source: unknown)=>({source}))}:{}),
      }
    })
    return { cursor:String(next), messages }
  }

  /** 从原生 Thread API 读取有限历史；触发本轮请求的帖子不计入引用上下文。 */
  async readMattermostThread(rootId: string, signal: AbortSignal, limit = 5, excludePostIds: readonly string[] = []): Promise<import('../../inbox/domain.js').MattermostContextPost[]> {
    if (this.config.platform !== 'mattermost' || !/^[a-z0-9]{26}$/.test(rootId)) throw new Error('Mattermost thread root ID 无效')
    this.authorize?.()
    const max = Math.max(0, Math.min(60, Math.floor(limit)))
    if (max === 0) return []
    const excluded = new Set(excludePostIds)
    // Mattermost 的 perPage 默认会返回整个 Thread；先在服务端取最近记录，并为本批来源留出排除空间。
    const perPage = Math.min(200, max + excluded.size)
    const query = new URLSearchParams({ perPage: String(perPage), direction: 'up' })
    const data = await this.request(`/api/v4/posts/${encodeURIComponent(rootId)}/thread?${query}`, signal)
    if (!Array.isArray(data.order) || !data.posts || typeof data.posts !== 'object') throw new Error('Mattermost thread 响应无效')
    return data.order.map((id:unknown)=>typeof id==='string'?data.posts[id]:undefined)
      .filter((post:any)=>post&&post.channel_id===this.config.targetId&&(post.id===rootId||post.root_id===rootId)&&Number.isFinite(post.create_at)&&!post.delete_at&&!excluded.has(post.id))
      .sort((a:any,b:any)=>a.create_at-b.create_at||String(a.id).localeCompare(String(b.id)))
      .slice(-max)
      .map((post:any)=>({
        postId:post.id, actorId:post.user_id,
        ...(typeof post.username==='string'?{actorName:post.username}:{}),
        text:String(post.message??'').slice(0,8_000), timestamp:post.create_at, isBot:post.user_id===this.botId,
      }))
  }

  async sendText(userId: string, text: string, _context: string | undefined, signal?: AbortSignal): Promise<void> {
    this.authorize?.()
    if (this.qq) return this.qq.sendText(userId, text, signal, this.authorize)
    if(!this.config.targetId)throw new Error('联系人尚未配对，不能投递')
    await this.validate(signal)
    if (requiresVerifiedPeer(this.config) && userId !== this.peerId) throw new Error('目标联系人与当前双人会话不匹配，拒绝投递')
    for (const content of formatDirectMessages(text)) {
      if (this.config.platform==='matrix') await this.request(`/_matrix/client/v3/rooms/${encodeURIComponent(this.config.targetId)}/send/m.room.message/${randomUUID()}`,signal,{msgtype:'m.text',body:content.body,format:'org.matrix.custom.html',formatted_body:content.formattedBody},'PUT')
      else await this.request('/api/v4/posts',signal,{channel_id:this.config.targetId,message:content.markdown,...(this.config.threadRootId?{root_id:this.config.threadRootId}:{})})
    }
  }
  progress(userId:string):ProgressTransport | undefined {
    if (this.qq) return undefined
    return directProgressTransport(this.config,userId,signal=>this.validate(signal),
      (path,signal,body,method)=>this.request(path,signal,body,method),
      (text,signal)=>this.sendText(userId,text,undefined,signal))
  }
  async receiveAttachments(message: DirectMessage, signal: AbortSignal, allowed: () => boolean, maxBytes?: number) {
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    if (this.qq) return this.qq.receiveAttachments(message, lifetime, allowed, maxBytes)
    const transfer = new DirectMediaTransfer(this.config, this.token, async () => {
      if (!allowed()) throw new Error('渠道或联系人授权已撤销')
      const who = await this.validate(lifetime)
      if (!allowed()) throw new Error('渠道或联系人授权已撤销')
      if (!this.config.targetId || message.targetId && message.targetId !== this.config.targetId
        || requiresVerifiedPeer(this.config) && who.peerId !== message.sender) throw new Error('附件来源与当前会话不匹配')
    })
    return transfer.receive(message.id, message.media ?? [], lifetime, maxBytes)
  }
  async sendAttachment(userId: string, file: PartnerOutboundAttachment, _context: string | undefined, signal?: AbortSignal, allowed: () => boolean = () => true): Promise<void> {
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000)
    this.authorize?.()
    if (this.qq) return this.qq.sendAttachment(userId, file, lifetime, () => { this.authorize?.(); return allowed() })
    const transfer = new DirectMediaTransfer(this.config, this.token, async () => {
      if (!allowed()) throw new Error('渠道或联系人授权已撤销')
      const who = await this.validate(lifetime)
      this.authorize?.()
      if (!allowed()) throw new Error('渠道或联系人授权已撤销')
      if (!this.config.targetId || requiresVerifiedPeer(this.config) && who.peerId !== userId) throw new Error('附件接收人与当前会话不匹配')
    })
    await transfer.send(file, lifetime)
  }
}

/** 正则安全转义：用户名匹配只能是完整 @mention token，不能按子串触发。 */
function escapeRegExp(value:string):string { return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') }

/** 仅识别 Mattermost 结构化提及或完整用户名 token，不把 @用户名的前缀相似文本算作提及。 */
function mattermostPostMentionsBot(post:any, botId:string, botUsername:string|undefined):boolean {
  const mentions = Array.isArray(post.metadata?.mentions) ? post.metadata.mentions : []
  const mentionedById = mentions.includes(botId)
  const mentionedByName = botUsername
    ? new RegExp(`(^|[^\\w.-])@${escapeRegExp(botUsername)}(?=$|[^\\w.-])`, 'i').test(post.message ?? '')
    : false
  return mentionedById || mentionedByName
}
