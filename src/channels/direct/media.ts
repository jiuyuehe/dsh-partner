import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { PARTNER_MEDIA_MAX_BYTES, safeMediaName, type PartnerInboundAttachment, type PartnerOutboundAttachment } from '../../channel-message.js'
import type { DirectConfig } from './transport.js'

export interface DirectMedia { source: string; name?: string; mediaType?: string; size?: number; encrypted?: boolean }
export const DIRECT_MEDIA_MAX_COUNT = 8
type Guard = () => Promise<void>

/** Only server-relative, authenticated media APIs. Never fetch a message-provided HTTP URL. */
export class DirectMediaTransfer {
  constructor(private config: DirectConfig, private token: string, private guard: Guard) {}

  private async bytes(path: string, signal: AbortSignal, limit: number, body?: BodyInit, mediaType?: string, method = body === undefined ? 'GET' : 'POST'): Promise<Buffer> {
    await this.guard()
    const response = await fetch(this.config.baseUrl + path, {
      method, ...(body === undefined ? {} : { body }), redirect: 'error', signal,
      headers: { Authorization: `Bearer ${this.token}`, ...(mediaType ? { 'Content-Type': mediaType } : {}) },
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw Object.assign(new Error(`渠道附件请求失败（HTTP ${response.status}）`), { status: response.status })
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel(); throw new Error('渠道附件响应超过大小限制')
    }
    if (!response.body) throw new Error('渠道附件响应为空')
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > limit) throw new Error('渠道附件响应超过大小限制')
      chunks.push(chunk)
    }
    await this.guard()
    return Buffer.concat(chunks)
  }

  private async json(path: string, signal: AbortSignal, body?: BodyInit, mediaType?: string, method?: string): Promise<any> {
    return JSON.parse((await this.bytes(path, signal, 1024 * 1024, body, mediaType, method)).toString('utf8'))
  }

  async receive(postId: string, refs: DirectMedia[], signal: AbortSignal, maxBytes = PARTNER_MEDIA_MAX_BYTES): Promise<PartnerInboundAttachment[]> {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>PARTNER_MEDIA_MAX_BYTES)throw new Error('附件大小限制无效')
    if (refs.length > DIRECT_MEDIA_MAX_COUNT) throw new Error('单条消息最多接收 8 个附件')
    const attachments: PartnerInboundAttachment[] = []; let total = 0
    for (const ref of refs) {
      signal.throwIfAborted()
      if (ref.encrypted) throw new Error('暂不支持 Matrix 加密附件')
      let name = ref.name, mediaType = ref.mediaType, size = ref.size, path: string
      if (this.config.platform === 'matrix') {
        const match = /^mxc:\/\/([^/?#]+)\/([A-Za-z0-9_-]+)$/.exec(ref.source)
        if (!match || match[1]!.includes('@') || match[1]!.includes('\\')) throw new Error('Matrix 附件必须使用合法 mxc 地址')
        path = `/_matrix/client/v1/media/download/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}`
      } else {
        if (!/^[a-z0-9]{26}$/.test(ref.source)) throw new Error('Mattermost 附件 ID 无效')
        const info = await this.json(`/api/v4/files/${ref.source}/info`, signal)
        if (info.id !== ref.source || info.post_id !== postId || info.channel_id !== this.config.targetId) throw new Error('Mattermost 附件不属于当前消息或频道')
        name = info.name; mediaType = info.mime_type; size = info.size
        path = `/api/v4/files/${ref.source}`
      }
      if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > maxBytes - total)) throw new Error('单条消息附件总大小不能超过 64 MB')
      const data = await this.bytes(path, signal, maxBytes - total)
      total += data.length
      const image = imageType(data)
      attachments.push({ data, name: safeMediaName(typeof name === 'string' ? name : '', '附件.bin'), kind: image ? 'image' : 'file', mediaType: image ?? safeType(mediaType) })
    }
    return attachments
  }

  async send(file: PartnerOutboundAttachment, signal: AbortSignal): Promise<void> {
    await this.guard()
    const data = await readOutboundMedia(file, signal)
    const name = safeMediaName(file.name, '附件.bin'), mediaType = imageType(data) ?? safeType(file.mediaType)
    if (this.config.platform === 'matrix') {
      const uploaded = await this.json('/_matrix/media/v3/upload?filename=' + encodeURIComponent(name), signal, new Uint8Array(data), mediaType)
      if (typeof uploaded.content_uri !== 'string' || !/^mxc:\/\/[^/?#]+\/[A-Za-z0-9_-]+$/.test(uploaded.content_uri)) throw new Error('Matrix 未返回有效的媒体地址')
      const msgtype = imageType(data) ? 'm.image' : mediaType.startsWith('audio/') ? 'm.audio' : mediaType.startsWith('video/') ? 'm.video' : 'm.file'
      // Sending is a separate acknowledged operation; upload success alone is not delivery.
      const sent = await this.json(`/_matrix/client/v3/rooms/${encodeURIComponent(this.config.targetId)}/send/m.room.message/${randomUUID()}`, signal,
        JSON.stringify({ msgtype, body: name, filename: name, url: uploaded.content_uri, info: { mimetype: mediaType, size: data.length } }), 'application/json', 'PUT')
      if (typeof sent.event_id !== 'string' || !sent.event_id) throw new Error('Matrix 未确认附件消息')
    } else {
      const body = new FormData()
      body.append('channel_id', this.config.targetId)
      body.append('files', new Blob([new Uint8Array(data)], { type: mediaType }), name)
      const uploaded = await this.json('/api/v4/files', signal, body)
      const id = uploaded.file_infos?.[0]?.id
      if (typeof id !== 'string' || !/^[a-z0-9]{26}$/.test(id)) throw new Error('Mattermost 未返回有效的附件 ID')
      const sent = await this.json('/api/v4/posts', signal, JSON.stringify({ channel_id: this.config.targetId, message: '', file_ids: [id], ...(this.config.threadRootId?{root_id:this.config.threadRootId}:{}) }), 'application/json')
      if (typeof sent.id !== 'string' || !sent.id) throw new Error('Mattermost 未确认附件消息')
    }
  }
}

function safeType(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value) ? value : 'application/octet-stream'
}
export function imageType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

export async function readOutboundMedia(file: PartnerOutboundAttachment, signal: AbortSignal): Promise<Buffer> {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let data: Buffer
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > PARTNER_MEDIA_MAX_BYTES) throw new Error('待发送附件必须是 64 MB 以内的普通文件')
      data = Buffer.alloc(before.size); let offset = 0
      while (offset < data.length) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      const after = await handle.stat()
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('文件正在变化，请生成完成后发送')
    } finally { await handle.close() }
  return data
}
