import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { chatReplyFromEvent } from './protocol.js'
import { needsTaskPreamble } from '../execution/task-preamble.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from '../channels/delivery-policy.js'
import { isIdleContactNotice } from '../character/idle-contact.js'

function input(value:unknown):Record<string,any> {
  try {const v=typeof value==='string'?JSON.parse(value):value;return v&&typeof v==='object'?v:{}}catch{return {}}
}
export function actualAction(name:string,args:unknown):{name:string;args:Record<string,any>} {
  const a=input(args)
  return name==='partner_tools'&&a.action==='call'&&typeof a.name==='string'?{name:a.name,args:input(a.argumentsJson)}:{name,args:a}
}
/** A declaration is input-scoped, backed by confirmed speech, and never executes work itself. */
export function pendingActions(events:readonly SessionEvent[]):string[] {
  let start=-1
  for(let i=events.length-1;i>=0;i--){
    const e=events[i]!
    if(e.type==='turn/start')return []
    if(e.type!=='user/message')continue
    if(e.data.source.kind==='user'){start=i;break}
    if(isInternalTaskNotice(e)&&!isRequirementDeliveryReceipt(e)||isIdleContactNotice(e))return []
  }
  if(start<0)return []
  const user=events[start] as Extract<SessionEvent,{type:'user/message'}>
  const tail=events.slice(start+1)
  const declared=new Set<string>(),pending=new Set<string>()
  const finished=new Set(tail.flatMap(e=>e.type==='tool/result'?[e.data.message.toolCallId]:[]))
  for(const e of tail){
    const reply=chatReplyFromEvent(e)
    if(reply&&!reply.intermediate&&reply.taskDisposition==='blocked')return []
    if(reply?.delivered&&reply.taskPreamble&&reply.inputMessageId===user.data.id){
      for(const name of reply.expectedTools?.length?reply.expectedTools:['*'])if(!declared.has(name)){declared.add(name);pending.add(name)}
    }
    if(e.type!=='tool/call'&&e.type!=='tool/ptc-dispatch')continue
    if(e.type==='tool/call'&&!finished.has(e.data.callId))continue
    const c=actualAction(e.data.name,e.data.arguments)
    if(c.name==='partner_tools'||['partner_chat_say','partner_chat_reply','partner_chat_progress'].includes(c.name))continue
    pending.delete(c.name)
    if(needsTaskPreamble(c.name,c.args))pending.delete('*')
  }
  return [...pending]
}
export function pendingActionNotice(names:readonly string[]):string {
  return '本轮已告知的动作尚未实际调用：'+names.join('、')+'。聊天尚未结束。继续执行缺少的动作；查询目录、补一句话不算执行。已经调用过的动作不要重做。若取消、权限或条件限制导致不能继续，用 partner_chat_reply 的 taskDisposition="blocked"、taskReason 写明具体原因，并提供 taskEvidence：未执行用 kind=not_executed；真实工具失败用 kind=tool_error 引用本轮错误 callId 和 excerpt。不得编造服务拒绝或超时。在 messages 按当前人格说明未完成之处。不要把本检查原文发给用户。'
}

export interface TaskStopEvidence { kind:'not_executed'|'tool_error'; callId?:string; excerpt?:string; toolName?:string }
/** External failures need a real current-input error; a model decision is never a provider receipt. */
export function validateTaskStop(events:readonly SessionEvent[],value:unknown):TaskStopEvidence {
  const evidence=value as TaskStopEvidence|undefined
  if(!evidence||!['not_executed','tool_error'].includes(evidence.kind))throw Error('无法继续需 taskEvidence：未执行或你自己决定不执行用 kind=not_executed，并如实说明还没调用；声称工具或服务失败用 kind=tool_error，引用本轮真实错误 callId 与 excerpt。不能把推测或自己的决定说成服务拒绝。无需为了说明不执行而强行调用工具。')
  if(evidence.kind==='not_executed'){
    if(evidence.callId||evidence.excerpt)throw Error('未执行不能附带虚构工具回执；如实说明尚未调用或自己不能执行，不声称服务返回错误。')
    return {kind:'not_executed'}
  }
  if(typeof evidence.callId!=='string'||!evidence.callId||typeof evidence.excerpt!=='string'||!evidence.excerpt.trim())throw Error('外部失败必须引用本轮实际错误的 callId 和原文 excerpt，不凭助手旧话、目录说明或推测填写。')
  let boundary=events.length
  for(let i=events.length-1;i>=0;i--){const e=events[i]!;if(e.type==='turn/start')break;if(e.type==='user/message'&&e.data.source.kind==='user'){boundary=i;break}}
  const current=events.slice(boundary+1)
  const calls=new Map(current.flatMap(e=>e.type==='tool/call'?[[e.data.callId,actualAction(e.data.name,e.data.arguments).name] as const]:[]))
  for(const e of current){
    const data=e.type==='tool/result'?e.data.message:e.type==='tool/ptc-dispatch'?e.data:undefined
    if(!data)continue
    const id=e.type==='tool/result'?e.data.message.toolCallId:e.type==='tool/ptc-dispatch'?e.data.subCallId:undefined
    if(id!==evidence.callId)continue
    const name=e.type==='tool/ptc-dispatch'?e.data.name:calls.get(id!)
    if(!name||['partner_chat_say','partner_chat_reply','partner_chat_progress'].includes(name))continue
    const text=(data.content??[]).flatMap(b=>b.type==='text'?[b.text]:[]).join('\n')
    const parsed=input(text)
    const failed=data.isError||/^Error:/.test(text)||Boolean(parsed.error)||['failed','blocked'].includes(parsed.result?.status)
    if(failed&&text.includes(evidence.excerpt.trim()))return {kind:'tool_error',callId:evidence.callId,excerpt:evidence.excerpt.trim(),toolName:name}
  }
  throw Error('所引用的本轮错误回执不存在或原文不匹配，失败说明未发送。若没有实际调用，不得声称已调用、服务拦截、超时或收到回执；可用 taskEvidence.kind=not_executed 按人格说明自己尚未执行或不能执行。不强制重试或绕过任何限制。')
}
