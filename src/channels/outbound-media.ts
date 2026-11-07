import { realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PartnerOutboundAttachment, PartnerReply } from '../channel-message.js'
import { PARTNER_MEDIA_MAX_BYTES } from '../channel-message.js'
import type { ChannelReplyParts } from './delivery-policy.js'

const MAX_ATTACHMENTS = 8
const MAX_CANDIDATES = 64
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
}

// Supports angle-bracket destinations, encoded names and ordinary Markdown links.
const LINK = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/g
const SANDBOX = /sandbox:[^\s<>`"\])]+/gi

function localPath(value: string): string | undefined {
  try {
    if (/^file:/i.test(value)) return fileURLToPath(value)
    const path = decodeURIComponent(value.replace(/^sandbox:/i, ''))
    // Windows 盘符后的冒号不是 URL 协议；保留 DSH 在 Windows 工作区生成的绝对附件路径。
    const windowsDrivePath = /^[a-z]:[\\/]/i.test(path)
    if (!path || path.includes('\0') || (!windowsDrivePath && /^[a-z][a-z0-9+.-]*:/i.test(path)) || path.startsWith('//')) return undefined
    return path
  } catch { return undefined }
}

function references(text: string): string[] {
  const result = new Set<string>()
  const add = (value: string): void => { if (result.size < MAX_CANDIDATES && value.length <= 4096) result.add(value) }
  for (const match of text.matchAll(LINK)) add(match[1] ?? match[2] ?? '')
  for (const match of text.matchAll(/`([^`\n]+)`/g)) add(match[1]!.trim())
  for (const match of text.matchAll(SANDBOX)) add(match[0])
  for (const line of text.split('\n')) {
    const value = line.trim()
    if (value.startsWith('/') && !value.includes(' ')) add(value)
  }
  return [...result]
}

async function resolveReferences(texts: readonly string[], cwd: string): Promise<Map<string, PartnerOutboundAttachment>> {
  const candidates = new Set<string>()
  for (const text of texts) {
    for (const candidate of references(text)) {
      if (candidates.size >= MAX_CANDIDATES) break
      candidates.add(candidate)
    }
    if (candidates.size >= MAX_CANDIDATES) break
  }
  const root = await realpath(cwd).catch(() => undefined)
  const result = new Map<string, PartnerOutboundAttachment>()
  if (!root) return result
  const included = new Map<string, PartnerOutboundAttachment>()
  for (const candidate of candidates) {
    const path = localPath(candidate)
    if (!path || !MEDIA_TYPES[extname(path).toLowerCase()]) continue
    try {
      const actual = await realpath(resolve(root, path))
      const rel = relative(root, actual)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
      const existing = included.get(actual)
      if (existing) { result.set(candidate, existing); continue }
      if (included.size >= MAX_ATTACHMENTS) continue
      const info = await stat(actual)
      const mediaType = MEDIA_TYPES[extname(actual).toLowerCase()]
      if (!info.isFile() || info.size > PARTNER_MEDIA_MAX_BYTES || !mediaType) continue
      const attachment: PartnerOutboundAttachment = { path: actual, name: basename(actual), mediaType, kind: mediaType.startsWith('image/') ? 'image' : 'file' }
      included.set(actual, attachment); result.set(candidate, attachment)
    } catch { /* Missing, removed or unreadable files are not deliverable. */ }
  }
  return result
}

export async function extractOutboundAttachments(text: string, cwd: string): Promise<PartnerOutboundAttachment[]> {
  return [...new Set((await resolveReferences([text], cwd)).values())]
}

/** Channel projection only; never rewrites the conversation or guesses virtual paths. */
export async function prepareChannelReply(parts: ChannelReplyParts, _cwd: string): Promise<PartnerReply> {
  if(parts.chatParts?.length===0&&!parts.text.trim())return {text:'',attachments:[],chatParts:[],...(parts.alreadyDelivered?{alreadyDelivered:true}:{}),...(parts.chatOriginRouteId!==undefined?{chatOriginRouteId:parts.chatOriginRouteId}:{})}
  // A Markdown mention is not delivery intent. Only the explicit tool sends
  // conversational attachments; backend requirement reports have their own flow.
  let missingSandbox = false
  const label = (raw: string, original: string): string => {
    if (/^sandbox:/i.test(raw)) { missingSandbox = true; return '附件不可用' }
    return original
  }
  let text = parts.text.replace(LINK, (all, angle: string | undefined, plain: string | undefined) => label(angle ?? plain ?? '', all))
  text = text.replace(SANDBOX, raw => label(raw, raw))
  if (missingSandbox) text += '\n\n这里只提供了沙箱引用，未发送该附件。请让伙伴使用 partner_send_attachment 交付真实文件；sandbox 地址不能直接在渠道打开。'
  if (!text.trim()) text = '本轮未生成可发送的最终答复，请重试或在会话中查看执行状态。'
  return { text: text.trim(), attachments: [], ...(parts.chatParts ? {chatParts:parts.chatParts,...(parts.chatOriginRouteId!==undefined?{chatOriginRouteId:parts.chatOriginRouteId}:{})} : {}) }
}
