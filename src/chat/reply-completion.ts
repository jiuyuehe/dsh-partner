import { pendingActions, pendingActionNotice } from './action-obligation.js'
import { deliveredAttachment } from '../attachments/delivery-receipt.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { chatReplyFromEvent } from './protocol.js'
import { isInternalTaskNotice } from '../channels/delivery-policy.js'
import { isIdleContactNotice } from '../character/idle-contact.js'

function object(value: unknown): Record<string,any> | undefined {
  try { const v=typeof value==='string'?JSON.parse(value):value; return v&&typeof v==='object'&&!Array.isArray(v)?v:undefined } catch { return undefined }
}
function call(name:string,args:unknown):{name:string;args:Record<string,any>} {
  const input=object(args)??{}
  if(name==='partner_tools'&&input.action==='call'&&typeof input.name==='string')return {name:input.name,args:object(input.argumentsJson)??{}}
  return {name,args:input}
}
function discovery(name:string,args:Record<string,any>):boolean {
  return name==='partner_tools'&&['list','describe','load','unload'].includes(args.action)
}
const replyControl=new Set(['partner_chat_progress','partner_chat_say','partner_chat_reply','partner_agreement','partner_channel_access','partner_stickers'])
export interface ReplyCompletionState { userId:string; phase:'complete'|'execute'|'settle'; files:string[]; deliveries:string[] }
/** Evidence for the latest user input in this turn, never a semantic guess from prose. */
export function replyCompletionState(events:readonly SessionEvent[], inspectOnly=false):ReplyCompletionState|undefined {
  const boundary=[...events].reverse().find(e=>e.type==='turn/start')
  if(!boundary)return
  const turn=events.slice(events.indexOf(boundary)+1)
  const origin=[...turn].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isInternalTaskNotice(e)||isIdleContactNotice(e)))
  if(origin?.type!=='user/message'||origin.data.source.kind!=='user')return
  const tail=turn.slice(turn.indexOf(origin)+1)
  const state:ReplyCompletionState={userId:origin.data.id,phase:'execute',files:[],deliveries:[]}
  const last=[...tail].reverse().find(e=>e.type==='assistant/message')
  const pending=pendingActions(events)
  if(!pending.length&&(tail.some(e=>(chatReplyFromEvent(e)&&!chatReplyFromEvent(e)!.intermediate)||deliveredAttachment(e)) || last?.type==='assistant/message'&&!last.data.interrupted&&!last.data.message.content.some(b=>b.type==='tool-call')&&last.data.message.content.some(b=>b.type==='text'&&b.text.trim())))return {...state,phase:'complete'}
  // Reasoning blocks are not user-visible answers. Interrupted/tool/media content is not an empty text stop.
  if(!inspectOnly&&(last?.type!=='assistant/message'||last.data.interrupted||last.data.message.content.some(b=>b.type!=='text'&&b.type!=='reasoning')))return
  const calls=new Map<string,{name:string;args:Record<string,any>}>()
  for(const e of tail)if(e.type==='tool/call') {
    const c=call(e.data.name,e.data.arguments);calls.set(e.data.callId,c)
    if(!replyControl.has(c.name)&&!discovery(c.name,c.args))state.phase='settle'
  }
  for(const e of tail) {
    const result=e.type==='tool/result'?e.data.message:e.type==='tool/ptc-dispatch'?e.data:undefined
    const c=e.type==='tool/result'?calls.get(e.data.message.toolCallId):e.type==='tool/ptc-dispatch'?call(e.data.name,e.data.arguments):undefined
    if(!result||result.isError||!c)continue
    for(const block of result.content??[])if(block.type==='text') {
      const value=object(block.text)
      if(c.name==='generate_image'&&Array.isArray(value?.files))for(const f of value.files)if(typeof f?.path==='string')state.files.push(f.path)
      if(c.name==='partner_send_attachment'&&typeof value?.deliveryId==='string')state.deliveries.push(value.deliveryId)
    }
  }
  return state
}
export const INCOMPLETE_REPLY='本次请求未完成：模型连续未完成答复或已告知的动作。已执行的操作不会自动重做，请查看本次执行记录后再决定是否重试。'
/** Same-turn recovery with a bounded request budget and a settlement-only tool gate. */
export class ReplyCompletionGuard {
  private userId=''
  private attempts=0
  private settling:ReplyCompletionState|undefined
  failed=false
  constructor(private readonly agent:Agent,private readonly active:()=>boolean){}
  stop=({agent,signal}:{agent:Agent;signal:AbortSignal}):void=>{
    if(agent!==this.agent||signal.aborted||!this.active())return
    const state=replyCompletionState(agent.session.snapshotEvents())
    if(!state||state.phase==='complete')return
    if(state.userId!==this.userId){this.userId=state.userId;this.attempts=0;this.settling=undefined}
    if(this.attempts>=2){this.failed=true;throw Error(INCOMPLETE_REPLY)}
    this.attempts++
    const pending=pendingActions(agent.session.snapshotEvents())
    this.settling=state.phase==='settle'?state:undefined
    const action=pending.length?'仅继续尚未调用的承诺动作，已调用的操作不得重做；若已有失败或无法继续，按事实结束。':state.phase==='execute'?'还没有实际工作提交。继续处理当前用户请求，工具目录与参数说明不等于执行；需要工作就实际调用，不能执行就按事实答复。':'已提交过实际工作。只根据现有工具回执交付或答复，不重新执行或猜测成功。成功生成的文件可通过附件工具交付；发送失败只能按原 deliveryId 重试。其他失败或状态不明请按事实简短说明。'
    agent.steer(createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'当前请求答复完整性检查'},content:[{type:'text',text:`${pending.length?pendingActionNotice(pending):''} 当前请求尚无最终答复或已确认交付，不能以空正文结束。${action} 已送达的前置回应不要重复。以上仅是内部执行检查，不是对用户的回复稿；不要向用户复述回执、空答复、恢复或工具目录等内部流程。需要答复时沿用当前人格，只说实际结果或具体阻碍，不用空泛道歉代替尚可执行的工作。此恢复留在当前用户回合，不交给自主活动。`}]}))
  }
  deny(name:string,args:unknown):string|undefined {
    if(!this.settling||!this.active())return
    const current=replyCompletionState(this.agent.session.snapshotEvents(),true)
    // While a tool call is live, use the latest actual user id, not the final-answer projection.
    const user=[...this.agent.session.snapshotEvents()].reverse().find(e=>e.type==='user/message'&&e.data.source.kind==='user')
    if(user?.type!=='user/message'||user.data.id!==this.userId)return
    const c=call(name,args)
    const missing=pendingActions(this.agent.session.snapshotEvents())
    if(missing.includes(c.name)&&c.name!=='partner_tools')return
    if(discovery(c.name,c.args)||c.name==='partner_chat_reply'||c.name==='partner_chat_say'&&c.args.beforeTools!==true)return
    if(c.name==='partner_send_attachment'&&((typeof c.args.path==='string'&&[...this.settling.files,...(current?.files??[])].includes(c.args.path))||(typeof c.args.deliveryId==='string'&&[...this.settling.deliveries,...(current?.deliveries??[])].includes(c.args.deliveryId))))return
    return '本次只在恢复最终答复，原工作已有提交记录，不能重复或新增执行。请根据已有回执答复；已生成图片可交付原文件，附件重试使用原 deliveryId。'
  }
}
