import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type { ChannelSession, Companion, PartnerState } from '../domain.js'
import { affectionEnabled, affectionProgress } from './affection.js'
import { affectionAudienceAllowed } from './affection-adapter.js'
import { idleContactRouteAllowed, idleActivityPrompt, ACTIVITY_PROTOCOL_PROMPT } from './idle-contact.js'
import { isSleeping } from './sleep.js'

/** Persist misses too: one opportunity per delivered user turn, including after restart. */
export interface PostReplyOpportunity {
  userMessageId: string
  sessionId: string
  policyRevision: number
  deliveredAt: number
  dueAt: number
  expiresAt: number
  probability: number
  depth?: number
  status: 'pending' | 'missed' | 'claimed' | 'cancelled'
}
export const MAX_ACTIVITY_CHAIN = 5
export function postReplyProbability(companion: Companion, depth = 0): number {
  if(depth >= MAX_ACTIVITY_CHAIN)return 0
  const base = affectionEnabled(companion) ? 0.45 + 0.35 * affectionProgress(companion.affection).score / 100 : 0.45
  return base * 0.5 ** Math.max(0,depth)
}
/** Silence without any actual activity stops the chain; discovery alone isn't activity. */
export function completedActivityDidWork(events:readonly SessionEvent[]):boolean {
 const silent=events.some(e=>(e.type==='tool/call'||e.type==='tool/ptc-dispatch-start'||e.type==='tool/ptc-dispatch')&&e.data.name==='partner_activity_finish')
 return events.some(e=>{
  if(e.type==='assistant/message')return !silent && !e.data.interrupted && !e.data.message.content.some(b=>b.type==='tool-call') && e.data.message.content.some(b=>b.type==='text'&&b.text.trim())
  if(e.type!=='tool/result'&&e.type!=='tool/ptc-dispatch')return false
  if(e.type==='tool/result'?e.data.message.isError:e.data.isError)return false
  const meta=e.data.meta as {kind?:string;parts?:unknown[];delivered?:boolean}|undefined
  if(meta?.kind==='partner-chat-v1')return meta.delivered===true||!!meta.parts?.length
  const call=e.type==='tool/ptc-dispatch'?e:events.find(c=>c.type==='tool/call'&&c.data.callId===e.data.message.toolCallId)
  if(!call||(call.type!=='tool/call'&&call.type!=='tool/ptc-dispatch'))return false
  let name=call.data.name,args=call.data.arguments
  try{
   let input=typeof args==='string'?JSON.parse(args):args as Record<string,unknown>
   if(name==='partner_tools'){
    if(input?.action!=='call')return false
    name=String(input.name);input=JSON.parse(String(input.argumentsJson))
   }
   if(['partner_activity_finish','partner_chat_reply','partner_stickers','partner_sleep'].includes(name))return false
   return name==='partner_qq'?input?.action==='call':true
  }catch{return false}
 })
}
export function postReplyAllowed(state: PartnerState, companion: Companion, route: ChannelSession, now = Date.now(), allowSleeping = false): boolean {
  if (!companion.idleContact?.enabled || route.companionId !== companion.id || (!allowSleeping && isSleeping(companion, now)) || !idleContactRouteAllowed(state, companion, route.id)) return false
  const channel = state.channels.find(c => c.id === route.channelId && c.companionId === companion.id)
  return (route.kind === 'local' || !!channel) && affectionAudienceAllowed({route, ...(channel ? {channel} : {})})
}
export function postReplyCurrent(state: PartnerState, companion: Companion, route: ChannelSession, now = Date.now(), allowSleeping = false): boolean {
  const pending = route.postReplyOpportunity
  return !!pending && pending.sessionId === route.sessionId && pending.policyRevision === companion.updatedAt
    && postReplyAllowed(state, companion, route, now, allowSleeping)
}
/** Shared by generation, delivery and tool dispatch; revocation takes effect immediately. */
export function activityPolicyCurrent(state: PartnerState, companion: Companion, route: ChannelSession, now = Date.now(), allowSleeping = false): boolean {
  if (!companion.idleContact?.enabled) return false
  return route.idleContactState?.kind === 'post-reply'
    ? postReplyCurrent(state, companion, route, now, allowSleeping) && route.postReplyOpportunity?.status === 'claimed'
      && route.postReplyOpportunity.userMessageId === route.idleContactState.userMessageId
    : companion.idleContact.routeId === route.id
}
export const POST_REPLY_PROMPT = [
  '这是回复或自主活动完成后的「主动延续」机会，不是一次闲时巡检。先看最近用户说了什么、自己刚刚实际说了什么或做了什么，再判断有没有自然还想接下去的一点。继续的机会逐轮递减，无需自己安排下一轮。',
  '可以接着自己的半句补一个念头、延续刚才的话题或玩笑、表达此刻真实的反应，也可以用相关表情、语音或已授权的小行动接下去。延续不需要用户先发新消息，也不需要先找到外部新资讯；自己刚才的话就是可承接的上下文。不要重新回答整道问题、复述已发内容或故意把必要答案留到概率活动里。',
  '按当前人格和篇幅偏好表达，只说此刻想补的一点，说完就停。不用提问结尾来索取下一句；没有必要就不追问。先承接眼前交流，不默认转去翻空间或整理收藏；工具是表达和行动的手段，不是每轮必做清单。',
  '先看用户是否表示告别、想安静或不想继续，遵守其意愿。确实没什么想补的就用 partner_activity_finish 安静结束，不输出休息或不打扰的宣告。不要凑第二条消息，不催回复，不编造经历；好感度影响机会概率，不要求必须发消息。',
  '这不是失败任务的恢复入口；此前未完成、失败或状态不明的用户任务不能在这里自动补跑。需要用户补充必要信息的任务继续等待，不猜测答案擅自执行。',
  ACTIVITY_PROTOCOL_PROMPT,
].join('\n')

export function postReplyActivityPrompt(state:PartnerState,companion:Companion,events:readonly SessionEvent[]):string {
  return idleActivityPrompt(state,companion,events,POST_REPLY_PROMPT)
}
