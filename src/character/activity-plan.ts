import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Companion, PartnerState } from '../domain.js'
import { affectionForInput, currentAffectionAudience } from './affection-context.js'
import { canFinishIdleActivity } from './activity-tool.js'
import { isIdleContactNotice, idleContactRouteAllowed } from './idle-contact.js'
import { thoughtTargetAllowed } from './thoughts.js'

/** A single durable intention, not a recurring job or an instruction from another user. */
export interface ActivityPlan {
  id:string; sourceRouteId:string; sourceSessionId:string; sourceInputId:string
  autonomous:boolean; targetRouteId:string; targetSessionId:string; intention:string
  dueAt:number; createdAt:number; policyRevision:number
  status:'waiting'|'pending'|'claimed'|'cancelled'; thoughtId?:string; result?:string
}
export function activityPlanCurrent(state:PartnerState,c:Companion,plan:ActivityPlan):boolean {
  const source=state.sessions.find(r=>r.id===plan.sourceRouteId),target=state.sessions.find(r=>r.id===plan.targetRouteId)
  if(!c.idleContact?.enabled||plan.policyRevision!==c.updatedAt||!source||!target||source.sessionId!==plan.sourceSessionId||target.sessionId!==plan.targetSessionId||!thoughtTargetAllowed(state,c,[source.id],target))return false
  if(!plan.autonomous){
    const channel=state.channels.find(ch=>ch.id===source.channelId)
    if(channel?.platform==='qq'){
      const input={type:'user/message',data:{id:plan.sourceInputId,source:{kind:'user'}}} as SessionEvent
      if(!affectionForInput(state,c.id,source.sessionId,input))return false
    }
  }
  if(plan.thoughtId){const t=c.thoughts?.find(t=>t.id===plan.thoughtId);if(!t||t.status!=='open'||!thoughtTargetAllowed(state,c,t.sourceRouteIds,target))return false}
  return idleContactRouteAllowed(state,c,target.id)
}
export function planActivity(state:PartnerState,c:Companion,sessionId:string,events:readonly SessionEvent[],input:{routeId?:string|undefined;reason:string;delayMinutes?:number|undefined;thoughtId?:string}):ActivityPlan {
  const latest=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)))
  if(latest?.type!=='user/message'||!c.idleContact?.enabled)throw Error('自主活动未开启或当前没有可信会话来源')
  const autonomous=isIdleContactNotice(latest)
  if(autonomous?!canFinishIdleActivity(c.id,state,sessionId,events):!currentAffectionAudience(state,c.id,sessionId,events))throw Error('当前账号不能安排自主活动')
  const routes=state.sessions.filter(r=>r.companionId===c.id&&r.sessionId===sessionId)
  const source=autonomous?routes.find(r=>r.idleContactState?.messageId===latest.data.id):routes.find(r=>r.kind==='channel'&&r.inboundMessageIds?.includes(latest.data.id))??routes.find(r=>r.kind==='local')
  const target=state.sessions.find(r=>r.id===(input.routeId??source?.id))
  const delay=input.delayMinutes??c.idleContact.idleMinutes
  if(!Number.isFinite(delay)||delay<0||!Number.isSafeInteger(Math.round(delay*60_000)+Date.now()))throw Error('等待时间须为有效的非负分钟数')
  if(!source||!target||!thoughtTargetAllowed(state,c,[source.id],target)||!input.reason.trim()||input.reason.length>300)throw Error('请填写具体意图并选择当前来源允许的会话')
  const now=Date.now()
  const plan:ActivityPlan={id:randomUUID(),sourceRouteId:source.id,sourceSessionId:sessionId,sourceInputId:latest.data.id,autonomous,targetRouteId:target.id,targetSessionId:target.sessionId,intention:input.reason.trim(),dueAt:now+delay*60_000,createdAt:now,policyRevision:c.updatedAt,status:'waiting',...(input.thoughtId?{thoughtId:input.thoughtId}:{})}
  if(!activityPlanCurrent(state,c,plan))throw Error('意图来源或目标已不可用')
  c.activityPlan=plan
  return plan
}
