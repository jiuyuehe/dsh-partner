import { activityPlanCurrent } from './activity-plan.js'
import { thoughtTargetAllowed } from './thoughts.js'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type { ChannelSession, Companion, PartnerState } from '../domain.js'
import { affectionAudienceAllowed } from './affection-adapter.js'
import { idleContactRouteAllowed, idleActivityPrompt } from './idle-contact.js'
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
  if(route.idleContactState?.kind==='autonomous'){
    const claim=route.idleContactState
    if(claim.cancelled||!idleContactRouteAllowed(state,companion,route.id)||(!allowSleeping&&isSleeping(companion,now)))return false
    return claim.planId ? !!claim.planSnapshot&&claim.planSnapshot.id===claim.planId&&activityPlanCurrent(state,companion,claim.planSnapshot) : companion.idleContact.routeId===route.id
  }
  if(route.idleContactState?.kind==='thought'){
    const thought=companion.thoughts?.find(t=>t.id===route.idleContactState?.thoughtId)
    return !!thought&&thought.status==='open'&&thought.targetRouteId===route.id&&thoughtTargetAllowed(state,companion,thought.sourceRouteIds,route)
  }
  return route.idleContactState?.kind === 'post-reply'
    ? postReplyCurrent(state, companion, route, now, allowSleeping) && route.postReplyOpportunity?.status === 'claimed'
      && route.postReplyOpportunity.userMessageId === route.idleContactState.userMessageId
    : companion.idleContact.routeId === route.id
}
/** Legacy renderer now uses the same autonomous context, not a second behavior script. */
export function postReplyActivityPrompt(state:PartnerState,companion:Companion,events:readonly SessionEvent[]):string {
  return idleActivityPrompt(state,companion,events)
}
