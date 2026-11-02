import {validNativeEmoji,type NativeEmoji} from './sticker-adapter.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerOutboundAttachment, PartnerReply } from '../channel-message.js'

export type ChatPart = {type:'emoji';emoji:NativeEmoji} | { type: 'text'; text: string } | { type: 'image'; attachment: PartnerOutboundAttachment; url: string; label: string }
export interface ChatReply { kind: 'partner-chat-v1'; parts: ChatPart[]; silent?:boolean; intermediate?:boolean; taskPreamble?:boolean; expectedTools?:string[]; taskDisposition?:'blocked'; inputMessageId?:string; deliveryKind?:'text'; delivered?:boolean; spokenText?:string; originRouteId?: string | null }
export function chatReplyFromEvent(event: SessionEvent): ChatReply | undefined {
  if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return
  if (!event.data || (event.type === 'tool/result' ? event.data.message?.isError : event.data.isError)) return
  const value = event.data.meta as unknown as ChatReply | undefined
  if (value?.kind !== 'partner-chat-v1' || !Array.isArray(value.parts) || (!value.parts.length && value.silent!==true && !(value.delivered===true && typeof value.originRouteId==='string' && value.originRouteId.length>0)) || value.parts.length > 8) return
  if (!value.parts.every(p => p && typeof p === 'object' && (p.type === 'text' ? typeof p.text === 'string' && !!p.text.trim() : p.type==='emoji'?validNativeEmoji(p.emoji):p.type === 'image' && p.attachment?.kind === 'image' && typeof p.url === 'string' && p.url.startsWith('/') && !p.url.startsWith('//') && typeof p.label === 'string'))) return
  return value
}
/** Legacy records keep text at 0 and attachments at 1+. New replies preserve authored order. */
export function replyDeliveryParts(reply: PartnerReply): Array<{type:'text';text:string} | {type:'image';attachment:PartnerOutboundAttachment} | {type:'emoji';emoji:NativeEmoji}> {
  if (reply.chatParts?.length) return reply.chatParts.map(p => reply.attachmentPolicy === 'text-only' && p.type !== 'text' ? {type:'text' as const,text:''} : p)
  return [{type:'text',text:reply.text}, ...(reply.attachmentPolicy === 'text-only' ? [] : reply.attachments.map(attachment => ({type:'image' as const,attachment})))]
}
export function parseChatInput(raw: unknown): Array<{text:string} | {stickerId:string}> {
  const input = raw as {messages?:unknown}
  if (!input || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 8) throw new Error('请提交 1–8 条消息，普通文字不需要拆句')
  let total = 0, images = 0
  const parts = input.messages.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('每条消息只能是文字或一个表情 ID')
    const v = value as Record<string,unknown>
    // Providers may emit both optional fields, with an empty string for the unused one.
    // Ignore only empty known string fields; never discard unknown or malformed payloads.
    if (Object.keys(v).some(key=>key!=='text'&&key!=='stickerId')) throw new Error('每条消息只能是文字或一个表情 ID')
    const fields=Object.keys(v).filter(key=>!(typeof v[key]==='string'&&!(v[key] as string).trim()))
    if (fields.length !== 1) throw new Error('文字和表情要分成两条消息')
    if (typeof v.text === 'string' && v.text.trim() && v.text.length <= 6000) { total += v.text.length; return {text:v.text.trim()} }
    if (typeof v.stickerId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v.stickerId)) { images++; return {stickerId:v.stickerId} }
    throw new Error('文字不能为空或超过 6000 字；表情必须使用库内 ID')
  })
  if (total > 12000 || images > 2) throw new Error('一轮最多 12000 字、2 张表情；不需要每轮发表情')
  return parts
}

/** Some providers put speech beside a terminal tool call instead of inside its arguments.
 * Preserve only that exact call's public text, never reasoning, earlier steps or other tools.
 */
export function withChatCompanionText(input: Array<{text:string} | {stickerId:string}>, events: readonly SessionEvent[], callId: string | undefined): Array<{text:string} | {stickerId:string}> {
  // Authored text inside messages is authoritative; surrounding prose can be a paraphrase or preamble.
  if (!callId || input.some(part=>'text' in part)) return input
  for (let i=events.length-1;i>=0;i--) {
    const event=events[i]!
    if (event.type==='turn/start'||event.type==='user/message') break
    if (event.type!=='assistant/message') continue
    const blocks=event.data.message.content
    const calls=blocks.filter(b=>b.type==='tool-call')
    if (!calls.some(c=>c.id===callId)) continue
    if (event.data.interrupted||calls.length!==1) return input
    const call=calls[0]!
    if(call.name!=='partner_chat_reply'){
      if(call.name!=='partner_tools')return input
      try {const args=JSON.parse(call.arguments);if(args.action!=='call'||args.name!=='partner_chat_reply')return input}catch{return input}
    }
    const speech=blocks.filter(b=>b.type==='text').map(b=>b.text.trim()).filter(Boolean).join('\n')
    if (!speech) return input
    // The protocol's size limits remain authoritative; a rejected oversized call can be corrected.
    return parseChatInput({messages:[{text:speech},...input]})
  }
  return input
}

/** Only idle chat's unstructured, short paragraphs get a delivery fallback.
 * Explicit tool parts, documents and attachment replies keep authored boundaries.
 * Call before persisting the delivery so retries retain stable part indexes.
 */
export function segmentIdleChatReply(reply: PartnerReply, enabled: boolean): PartnerReply {
  if (!enabled || reply.chatParts !== undefined || reply.attachments.length || reply.text.length > 600) return reply
  const paragraphs = shortChatLines(reply.text)
  if (!paragraphs) return reply
  return {...reply, chatParts: paragraphs.map(text => ({type:'text' as const, text}))}
}

function shortChatLines(text: string): string[] | undefined {
  if (text.length > 600 || /[`~<>|]/.test(text) || /^(?: {4}|\t|\s*(?:#{1,6}\s|[-*+]\s|\d+[.)、]\s|>))/m.test(text)) return
  const lines = text.trim().split(/\r?\n/).map(p => p.trim()).filter(Boolean)
  if (lines.length < 2 || lines.length > 8 || lines.some(p => p.length > 200)) return
  return lines
}

/** Normalize only a single short text item; keep explicit multi-bubble order and the 8-part limit. */
export function segmentChatInput(input: Array<{text:string} | {stickerId:string}>, enabled: boolean): Array<{text:string} | {stickerId:string}> {
  if (!enabled || input.filter(p => 'text' in p).length !== 1) return input
  const text = input.find(p => 'text' in p) as {text:string}
  const lines = shortChatLines(text.text)
  if (!lines || input.length - 1 + lines.length > 8) return input
  return input.flatMap<{text:string} | {stickerId:string}>(p => 'text' in p ? lines.map(text => ({text})) : [p])
}
