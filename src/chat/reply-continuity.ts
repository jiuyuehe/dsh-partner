import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChannelSession } from '../domain.js'
import { questionOrigin } from '../channels/question-origin.js'
import { chatReplyFromEvent } from './protocol.js'

/** Only runtime-confirmed progress is visible speech; an attempted send is not a reply. */
export function confirmedProgress(events: readonly SessionEvent[]): Map<number, string> {
  const calls = new Map<string, unknown>(), result = new Map<number, string>(), seen = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === 'partner_chat_progress') calls.set(event.data.callId, event.data.arguments)
    let id: string | undefined, args: unknown, content: unknown
    if (event.type === 'tool/result' && !event.data.message.isError && calls.has(event.data.message.toolCallId)) {
      id = event.data.message.toolCallId; args = calls.get(id); content = event.data.message.content
    } else if (event.type === 'tool/ptc-dispatch' && event.data.name === 'partner_chat_progress' && !event.data.isError) {
      id = event.data.subCallId; args = event.data.arguments; content = event.data.content
    }
    if (!id || seen.has(id) || !Array.isArray(content)) continue
    const confirmed = content.some(b => b?.type === 'text' && (b.text === '前置回应已送达；继续执行任务，完成后再给出最终回复。' || b.text === '{"delivered":true}'))
    if (!confirmed) continue
    try {
      const value = typeof args === 'string' ? JSON.parse(args) : args
      if (value && typeof value === 'object' && typeof value.text === 'string') { result.set(event.seq, value.text); seen.add(id) }
    } catch { /* Malformed historical arguments are not visible speech. */ }
  }
  return result
}

const textOf = (content: readonly { type: string; text?: string }[]) => content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')

export function replyContinuity(sessionId: string, events: readonly SessionEvent[], sessions: readonly ChannelSession[]) {
  const route = questionOrigin(sessionId, events, sessions)
  const recentUsers = events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user' && (route ? route.inboundMessageIds?.includes(e.data.id) : !sessions.some(r => r.kind === 'channel' && r.inboundMessageIds?.includes(e.data.id))))
  const since = recentUsers.slice(-6)[0]?.seq ?? 0
  const progress = confirmedProgress(events)
  const historicalSleep: Array<{ seq: number; text: string }> = []
  const confirmedMessages: Array<{ seq: number; text: string }> = []
  const dialogue: Array<{ role: string; text: string }> = []
  const prefix: SessionEvent[] = []
  const callOrigins = new Map<string, string | undefined>()
  let eventRoute: ReturnType<typeof questionOrigin>
  for (const event of events) {
    prefix.push(event)
    if (event.type === 'user/message' && event.data.source.kind === 'user') eventRoute = questionOrigin(sessionId, prefix, sessions)
    if (event.type === 'tool/call') callOrigins.set(event.data.callId, eventRoute?.id)
    if (event.type === 'tool/ptc-dispatch-start') callOrigins.set(event.data.subCallId, callOrigins.has(event.data.rootCallId) ? callOrigins.get(event.data.rootCallId) : eventRoute?.id)
    if (event.seq < since) continue
    const sameRoute = eventRoute?.id === route?.id
    const progressCallId = event.type === 'tool/result' ? event.data.message.toolCallId : event.type === 'tool/ptc-dispatch' ? (callOrigins.has(event.data.subCallId) ? event.data.subCallId : event.data.rootCallId) : undefined
    const progressForRoute = progressCallId && callOrigins.has(progressCallId) && callOrigins.get(progressCallId) === route?.id
    if (progressForRoute && progress.has(event.seq)) { dialogue.push({ role: 'assistant', text: progress.get(event.seq)! }); confirmedMessages.push({ seq: event.seq, text: progress.get(event.seq)! }) }
    if (sameRoute && event.type === 'user/message' && (event.data.source as { kind: string }).kind === 'runtime-context') {
      const snapshot = event.data.source as unknown as { form?: string; sections?: Array<{ name: string; text: string }> }
      if (snapshot.form === 'snapshot') for (const section of snapshot.sections ?? []) {
        if (section.name !== 'partner-conversation-memory' || typeof section.text !== 'string') continue
        const lines = section.text.split('\n').filter(line => line.startsWith('【当前休息状态】') || line.startsWith('本轮是睡眠中的私聊呼唤')).map(line => line.split('。')[0]! + (line.includes('。') ? '。' : ''))
        if (lines.length) historicalSleep.push({ seq: event.seq, text: lines.join('\n') })
      }
    }
    if (event.type === 'user/message' && event.data.source.kind === 'user' &&
      (route ? route.inboundMessageIds?.includes(event.data.id) : !sessions.some(r => r.kind === 'channel' && r.inboundMessageIds?.includes(event.data.id)))) {
      dialogue.push({ role: 'user', text: textOf(event.data.content) })
    }
    const reply = chatReplyFromEvent(event)
    if (reply && (reply.originRouteId ?? undefined) === route?.id) {
      const text = [reply.parts.filter(p => p.type === 'text').map(p => p.text).join('\n'), reply.spokenText].filter(Boolean).join('\n')
      if (text) dialogue.push({ role: 'assistant', text })
      if (reply.delivered && reply.spokenText) confirmedMessages.push({ seq: event.seq, text: reply.spokenText })
    }
  }
  return { confirmedMessages: confirmedMessages.slice(-4), dialogue: dialogue.slice(-12), historicalSleep: historicalSleep.filter((r, i, all) => i === 0 || all[i-1]!.text !== r.text).slice(-4) }
}

export function renderReplyContinuity(sessionId: string, events: readonly SessionEvent[], sessions: readonly ChannelSession[]): string {
  const context = replyContinuity(sessionId, events, sessions)
  if (!context.historicalSleep.length && !context.confirmedMessages.length) return ''
  return '【近期交流依据 · 程序记录】\n' + JSON.stringify({ historicalSleep: context.historicalSleep, confirmedMessages: context.confirmedMessages }) + '\nhistoricalSleep 是当时的状态，不代替当前状态；confirmedMessages 是已确认送达的接话、前置消息或语音。没有依据时不补写原因。'
}
