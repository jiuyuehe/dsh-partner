import { activityPolicyCurrent } from './post-reply.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerStore } from '../store.js'
import type { PartnerState } from '../domain.js'
import { isIdleContactNotice, lastIdleContactUser, idleContactRouteAllowed } from './idle-contact.js'

/** A terminal receipt, never a magic text token that could accidentally be sent to QQ. */
export function isSilentActivityResult(event: SessionEvent): boolean {
  if(event.type!=='tool/result'&&event.type!=='tool/ptc-dispatch')return false
  if(event.type==='tool/result'?event.data.message?.isError:event.data.isError)return false
  return (event.data.meta as {kind?:string}|undefined)?.kind==='partner-activity-silent-v1'
}
/** A model's explicit silence choice remains silent even if finishing fails.
 * Read execution events only; quoted text and failed unrelated tools do not count. */
export function isActivitySilenceRequested(event:SessionEvent):boolean {
  if(isSilentActivityResult(event))return true
  return (event.type==='tool/call'||event.type==='tool/ptc-dispatch-start'||event.type==='tool/ptc-dispatch') && event.data.name==='partner_activity_finish'
}
/** Ending a valid claimed activity is allowed after sleep, but never after new input or revocation. */
export function canFinishIdleActivity(owner:string,state:PartnerState,sessionId:string,events:readonly SessionEvent[]):boolean {
 const start=[...events].reverse().find(e=>e.type==='turn/start')?.seq??-1
 const inputs=events.filter(e=>e.seq>start&&e.type==='user/message'&&String(e.data.source.kind)!=='compact-checkpoint'&&(e.data.source.kind==='user'||!('form' in e.data.source)||!['snapshot','catalog','instructions','recall'].includes(e.data.source.form??'')))
 const notice=inputs.find(isIdleContactNotice),companion=state.companions?.find(c=>c.id===owner)
 const route=state.sessions.find(r=>r.companionId===owner&&r.sessionId===sessionId&&notice?.type==='user/message'&&r.idleContactState?.messageId===notice.data.id)
 return !!companion&&!!route&&notice?.type==='user/message'&&activityPolicyCurrent(state,companion,route,Date.now(),true)&&idleContactRouteAllowed(state,companion,route.id)&&!inputs.some(e=>!isIdleContactNotice(e))&&lastIdleContactUser(events)?.id===route.idleContactState?.userMessageId
}
export function idleActivityFinishTool(owner:string,store:PartnerStore):ToolDefinition {
  return {
    name:'partner_activity_finish',
    description:'安静结束系统唤起的自主活动。已做完探索、创作、整理、互动等活动，或此刻决定休息时调用；不发送聊天正文。仅限当前自主活动，不可用来跳过用户消息或工作任务。需要聊天则遵循当前人格与分段设置使用 partner_chat_reply；无需分段或聊天工具不可用时可用正常最终回复。',
    parameters:{type:'object',properties:{reason:{type:'string',maxLength:300}},required:['reason'],additionalProperties:false},
    output:{schema:{type:'object'},render:()=>[{type:'text',text:'本次自主活动已结束，不发送聊天正文。'}],presentationMeta:(_args,value)=>value},
    presentCall:()=>({card:'generic',title:'自主活动结束'}),
    async execute(raw,exec){
      exec.signal.throwIfAborted()
      const agent=exec.agent,events=agent?.session.snapshotEvents()??[]
      const state=store.snapshot()
      if(!agent||store.isCompanionRemoving(owner)||!canFinishIdleActivity(owner,state,agent.session.id,events))throw Error('只能结束当前系统发起的自主活动，不能忽略用户消息或其他任务')
      const notice=[...events].reverse().find(isIdleContactNotice)!
      const {reason}=raw as {reason:string}
      if(typeof reason!=='string'||!reason.trim()||reason.length>300)throw Error('请简要记录实际活动结果或此刻休息的依据')
      if(typeof exec.concludeTurn!=='function')throw Error('当前宿主不支持安静结束活动')
      exec.concludeTurn()
      return {kind:'partner-activity-silent-v1',reason:reason.trim(),messageId:notice.type==='user/message'?notice.data.id:''}
    },
  }
}
