import { chatReplyFromEvent } from '../chat/protocol.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from '../channels/delivery-policy.js'
import { isIdleContactNotice } from '../character/idle-contact.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const conversational = new Set(['partner_tools','partner_channel_access','partner_agreement','partner_chat_say','partner_chat_progress','partner_chat_reply','partner_stickers','partner_qq_reply','partner_activity_finish','partner_identity','partner_affection','partner_sleep'])
export function needsTaskPreamble(name:string,args:unknown):boolean {
  if(conversational.has(name))return false
  const input = args && typeof args === 'object' ? args as {action?:unknown;operation?:unknown} : undefined
  const action = input?.action
  if(name === 'partner_qq' && action === 'call' && ['fetch_custom_face_detail','set_msg_emoji_like','get_msg_emoji_likes','get_emoji_likes'].includes(String(input?.operation)))return false
  return !['list','describe','load','unload','reference','inspect'].includes(String(action))
}
/** Only the active user turn can request a private-channel acknowledgement. */
function inputId(events:readonly SessionEvent[]):string|undefined {
  for(let i=events.length-1;i>=0;i--){
    const event=events[i]!
    if(event.type==='turn/start')return undefined
    if(event.type!=='user/message')continue
    if(event.data.source.kind==='user')return event.data.id
    if(isIdleContactNotice(event) || isInternalTaskNotice(event) && !isRequirementDeliveryReceipt(event))return undefined
  }
  return undefined
}
/** Only confirmed task speech bound to this exact user input releases work. */
export function hasTaskPreamble(events:readonly SessionEvent[]):boolean {
  const id=inputId(events)
  if(!id)return false
  for(const e of [...events].reverse()) {
    if(e.type==='turn/start')break
    const r=chatReplyFromEvent(e)
    if(r?.delivered&&r.taskPreamble&&r.inputMessageId===id)return true
  }
  return false
}
export class TaskPreambleGate {
  private readonly sent=new Map<string,Promise<void>>()
  constructor(private readonly events:()=>readonly SessionEvent[],private readonly send:(text:string)=>Promise<void>,private readonly active:()=>boolean=()=>true,private readonly short:()=>boolean=()=>false,private readonly unified=false){}
  async acknowledge(text:string,inlineDetails=false):Promise<void>{
    const id=inputId(this.events())
    if(!id || !this.active())throw Error('只有当前用户私聊任务可以发送前置回应，内部任务和自主活动不能使用')
    if(typeof text!=='string'||!text.trim()||text.length>1200)throw Error('请按当前人格写一句自然回应（1–1200 字），不使用固定进度套话')
    if(this.short()&&!inlineDetails&&/[\r\n]/.test(text))throw Error('短句接话：前置回应尚未发送，请按人格用半句或一句自然接话只说接下来做什么，不展开计划。用户明确要求详细计划时可用 inlineDetails。')
    let pending=this.sent.get(id)
    if(!pending){pending=this.send(text.trim());this.sent.set(id,pending)}
    await pending
    if(!this.active() || inputId(this.events())!==id)throw Error('用户消息已变化，请先处理新的输入')
  }
  async before(name:string,args:unknown):Promise<string|undefined>{
    if(!this.active() || !needsTaskPreamble(name,args))return
    const id=inputId(this.events())
    if(!id)return
    if(this.unified)return hasTaskPreamble(this.events())?undefined:'本次工作尚未执行：先用 partner_chat_say，text 按当前人格简短说明准备做什么，beforeTools:true；确认送达后再执行。普通接话不能冒充动作告知，不要另发重复的前置回应。'
    let pending=this.sent.get(id)
    if(!pending){
      const message=[...this.events()].reverse().find(e=>e.type==='assistant/message'||e.type==='user/message'||e.type==='turn/start')
      if(message?.type==='assistant/message'&&!message.data.interrupted&&message.data.message.content.some(b=>b.type==='tool-call')){
        const text=message.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n').trim()
        if(text){try{await this.acknowledge(text);pending=this.sent.get(id)}catch{return '前置回应未确认送达，本次工作尚未执行。不要宣称已开始或重试未知发送；请向用户说明当前情况。'}}
      }
    }
    if(!pending)return '本次工作尚未执行：先调用 partner_chat_progress，text 按当前人格自然接话，说明接下来准备做的具体事情；等待成功后再调用本工具。统一入口使用 partner_tools action=call、name=partner_chat_progress、argumentsJson={"text":"按当前人格说明接下来准备做什么"} 的 JSON 字符串。这个回复不会结束回合；不要用 partner_chat_reply 代替。'
    try{await pending}catch{return '前置回应发送失败或结果未知，本次工作尚未执行；不要重复发送或宣称已开始。'}
    if(!this.active() || inputId(this.events())!==id)return '用户消息已变化，旧任务未开始；先处理新输入。'
  }
}
/** Scoped to one active channel reply; no extra model or hardcoded spoken text. */
export function installTaskPreamble(agent:Agent,send:(text:string)=>Promise<void>,active:()=>boolean=()=>true,short:()=>boolean=()=>false,unified=false):()=>void {
  const tools=agent.ctx.tools as ToolRuntime
  const gate=new TaskPreambleGate(()=>agent.session.snapshotEvents(),send,active,short,unified)
  const unregister=unified?()=>{}:tools.register({
    name:'partner_chat_progress',
    description:'私聊任务开始前按当前人格自然接话，遵循当前闲聊节奏：短句接话只用半句或一句说准备做什么；自然模式简述动作，展开模式可说明必要步骤（例如核实什么或生成什么），保留角色称呼、语气与当前对话习惯；不只说俏皮话，也不写客服式进度播报。立即发送 text，确认投递后返回，不结束回合；随后继续实际调查、生图或执行，最后再正常答复。一轮只发送一次，不能用于自主活动或内部任务。计划使用将要做的语气，不把尚未调用的工具说成已执行或已完成；没有真实权限拒绝结果时不要声称账号无权限。',
    parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:1200},inlineDetails:{type:'boolean',description:'仅用户本轮明确要求完整计划时使用，允许展开前置回应。'}},required:['text'],additionalProperties:false},
    output:{schema:{type:'object'},render:()=>[{type:'text',text:'前置回应已送达；继续执行任务，完成后再给出最终回复。'}]},
    presentCall:()=>({card:'generic',title:'任务前置回应'}),
    async execute(raw,exec){exec.signal.throwIfAborted();await gate.acknowledge((raw as {text:string}).text,(raw as {inlineDetails?:boolean}).inlineDetails===true);exec.signal.throwIfAborted();return {delivered:true}},
  })
  const unguard=agent.ctx.on('tools/pre-execute',async(exec,next)=>{
    const decision=await next()
    if(exec.agent!==agent || decision.kind!=='allow')return decision
    exec.signal.throwIfAborted()
    const reason=await gate.before(exec.name,exec.arguments)
    exec.signal.throwIfAborted()
    return reason?{kind:'deny',reason}:decision
  })
  return ()=>{unguard();unregister()}
}
