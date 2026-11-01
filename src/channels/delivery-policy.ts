import { deliveredAttachment } from '../attachments/delivery-receipt.js'
import { chatReplyFromEvent, type ChatPart } from '../chat/protocol.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isPluginSource } from '../message-source.js'

const INTERNAL_TASK_NOTICES = new Set([
  '看板任务待验收', '看板任务已完成', '看板任务受阻', '伙伴执行看板任务', '伙伴核验看板任务', '伙伴汇总需求',
  '伙伴长任务续接',
  '需求成果交付',
])

export function isInternalTaskNotice(event: SessionEvent): boolean {
  return event.type === 'user/message' && isPluginSource(event.data.source, '@lemoncat7/dsh-partner')
    && event.data.source.form === 'notice'
    && INTERNAL_TASK_NOTICES.has(event.data.source.summary ?? '')
}

/** Appended delivery bookkeeping, not a new agent instruction or turn owner. */
export function isRequirementDeliveryReceipt(event: SessionEvent): boolean {
  return isInternalTaskNotice(event) && event.type === 'user/message' && event.data.source.kind !== 'user'
    && 'summary' in event.data.source && event.data.source.summary === '需求成果交付'
}

/** Goal completion may share a turn with review; it must not bypass silence. */
export function isAutonomousDeliveryTurn(events: readonly SessionEvent[], history: readonly SessionEvent[] = events): boolean {
  if (events.some(isInternalTaskNotice)) return false
  // Goal completion can be delivered in a separate continuation turn. Carry
  // the most recent task/user origin across goal notices, not across new input.
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!
    if (isInternalTaskNotice(event)) return false
    if (event.type === 'user/message' && event.data.source.kind === 'user') break
  }
  return events.some(event => event.type === 'user/message' && isPluginSource(event.data.source, 'tool-goal')
    && event.data.source.form === 'notice'
    && event.data.source.summary?.startsWith('complete:'))
}

export interface ChannelReplyParts {
  alreadyDelivered?: boolean
  chatParts?: ChatPart[]
  chatOriginRouteId?: string | null
  text: string
  /** Assistant-authored file references survive filtering of progress prose. */
  referenceTexts: string[]
}

/** Select the last non-tool answer per eligible turn, never tool preambles. */
export function channelReplyPartsAfter(events: readonly SessionEvent[], fromSeq: number, autonomous = false): ChannelReplyParts {
  let direct = autonomous
  let answer = ''
  let chat: ChatPart[] | undefined
  let hasChat = false
  let alreadyDelivered = false
  let chatDelivered = false
  let chatOriginRouteId: string | null | undefined
  const ordered: ChatPart[] = []
  let references: string[] = []
  const messages: string[] = [], referenceTexts: string[] = []
  const flush = (): void => {
    if (direct) {
      if(chatDelivered){alreadyDelivered=true;if(!chat&&!answer)hasChat=true}
      if (chat) { ordered.push(...chat); hasChat = true; messages.push(chat.map(p => p.type === 'text' ? p.text : `[表情：${p.type==='emoji'?p.emoji.label:p.label}]`).join('\n\n')) }
      else if (answer) { messages.push(answer); ordered.push({type:'text',text:answer}) }
      referenceTexts.push(...references)
    }
    answer = ''; references = []; chat = undefined; chatDelivered=false
  }
  for (const event of events) {
    if (event.seq <= fromSeq) continue
    if (event.type === 'turn/start') { flush(); direct = autonomous }
    else if (event.type === 'turn/end') {
      if (event.data.reason.kind !== 'completed' && !chatDelivered) { answer = ''; references = []; chat = undefined }
      flush(); direct = false
    }
    else if (event.type === 'user/message' && event.data.source.kind === 'user') direct = true
    else if (isRequirementDeliveryReceipt(event) && direct && !autonomous) { /* Preserve the current user's final answer. */ }
    else if (isInternalTaskNotice(event)) { answer = ''; references = []; chat = undefined; chatDelivered=false; direct = false }
    else if (direct && deliveredAttachment(event)) {
      chatDelivered=true
      const route=deliveredAttachment(event)!
      chatOriginRouteId=chatOriginRouteId===undefined?route:chatOriginRouteId===route?route:null
    }
    else if (direct && chatReplyFromEvent(event)) {
      const reply=chatReplyFromEvent(event)!
      chat = reply.parts; answer = ''
      chatDelivered=chatDelivered||reply.delivered===true
      chatOriginRouteId = chatOriginRouteId === undefined ? reply.originRouteId : chatOriginRouteId === reply.originRouteId ? chatOriginRouteId : null
    }
    else if (direct && event.type === 'tool/result' && !chat) answer = ''
    else if (direct && event.type === 'assistant/message' && !event.data.interrupted) {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text.trim()) references.push(text.trim())
      if (event.data.message.content.some(block => block.type === 'tool-call')) answer = ''
      else if (text.trim()) answer = text.trim()
    }
  }
  flush()
  return { text: messages.join('\n\n'), referenceTexts, ...(alreadyDelivered?{alreadyDelivered:true}:{}), ...(hasChat ? {chatParts:ordered,...(chatOriginRouteId!==undefined?{chatOriginRouteId}:{})} : {}) }
}

/** whenIdle may encompass follow-up turns: don't append internal reviews to a user reply. */
export function channelReplyTextAfter(events: readonly SessionEvent[], fromSeq: number): string {
  return channelReplyPartsAfter(events, fromSeq).text
}
