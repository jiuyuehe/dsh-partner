import { hasTaskPreamble } from '../execution/task-preamble.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isIdleContactNotice } from '../character/idle-contact.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from '../channels/delivery-policy.js'
import { assertChatImageDelivery } from './attachment-reference.js'
import { chatReplyFromEvent } from './protocol.js'

function currentInput(events:readonly SessionEvent[]):string|undefined {
  for(const e of [...events].reverse()) {
    if(e.type==='turn/start')return
    if(e.type!=='user/message')continue
    if(e.data.source.kind==='user')return e.data.id
    if(isIdleContactNotice(e)||isInternalTaskNotice(e)&&!isRequirementDeliveryReceipt(e))return
  }
}
/** Successful speech after the latest input permits an explicit, silent end. */
export function hasCurrentSpeech(events:readonly SessionEvent[]):boolean {
  for(const e of [...events].reverse()) {
    if(e.type==='turn/start'||e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)||isInternalTaskNotice(e)&&!isRequirementDeliveryReceipt(e)))return false
    if(e.type==='tool/call'&&e.data.name==='partner_work_execute')return false
    const reply=chatReplyFromEvent(e)
    if(reply?.intermediate&&reply.delivered&&reply.inputMessageId===currentInput(events))return !reply.taskPreamble
  }
  return false
}

function validateSpeechText(raw:string,expanded:boolean):void {
  if(typeof raw!=='string'||!raw.trim()||raw.length>(expanded?1200:180)||!expanded&&/[\r\n]/.test(raw))throw Error('这里只发送一条简短的聊天消息（最多 180 字，不换行）；详细内容使用最终回复或附件')
  assertChatImageDelivery(raw.trim())
}

/** Per active channel turn. Serial sends, sticky unknown failures, no background continuation. */
export class LiveSpeech {
  private pending:Promise<void>=Promise.resolve()
  private failed=false
  private count=0
  private sent=new Map<string,Promise<void>>()
  constructor(private events:()=>readonly SessionEvent[],private send:(text:string)=>Promise<void>,private active:()=>boolean){}
  say(raw:string,signal:AbortSignal,expanded=false,task=false):Promise<void> {
    const input=currentInput(this.events())
    if(!input||!this.active())return Promise.reject(Error('只能在当前用户聊天中接话；不能用于闲时活动或内部任务'))
    try {validateSpeechText(raw,expanded)}catch(error){return Promise.reject(error)}
    const text=raw.trim()
    const key=input+'\0'+text,previous=this.sent.get(key)
    if(previous)return previous
    if(this.count>=(task?7:6))return Promise.reject(Error('本轮中途接话已达上限，请用 partner_chat_reply 结束，不继续自说自话'))
    this.count++
    const job=this.pending.then(async()=>{
      signal.throwIfAborted()
      if(this.failed||!this.active()||currentInput(this.events())!==input)throw Error('输入或发送状态已变化，旧接话未发送；先处理新消息，不重试未知发送')
      await this.send(text)
    })
    this.sent.set(key,job)
    this.pending=job.catch(()=>{this.failed=true})
    return job
  }
}
export function installLiveSpeech(agent:Agent,send:(text:string)=>Promise<void>,route:()=>string|undefined,chatEnabled:()=>boolean=()=>true,short:()=>boolean=()=>true):()=>void {
  const speech=new LiveSpeech(()=>agent.session.snapshotEvents(),send,()=>!!route())
  const taskSends=new Map<string,{names:Set<string>;job:Promise<void>}>()
  return agent.ctx.tools.register({
    name:'partner_chat_say',
    description:'当前私聊统一说话入口：立即发送 text，确认送达后继续本轮。每一句都直接按当前角色、关系和聊天节奏写，不展示思考过程，不切换成客服、主持人或任务播报。普通接话省略 beforeTools；实际执行工具或长任务前，用同一入口、beforeTools:true，按人格简短说准备做什么，并用 expectedTools 列出本轮承诺实际调用的具体工具名（必须是当前已注册的真实名称，未知时先查目录，不能猜别名或填目录入口 partner_tools）；生图并发送应列实际选择的生图入口（image_gen.imagegen 或 generate_image）及 partner_send_attachment。角色扮演中的叙事动作不需要伪造工具任务；只登记真实外部操作，不为叙事动作额外委派工作。成功后再工作；这句话就是前置回应，不再另外重复。同轮后续新增真实动作时，再用 beforeTools:true 与 expectedTools 登记；程序保留新增动作而不重复发前置回应，普通补话仍可单独发送。尚未执行用将要做的语气，不虚构完成或无权限。自然想补一句、改口或工作后有新话时可再次调用，不强制连发，不把长解释分批倾倒。收到新消息先接新消息。说完用 partner_chat_reply 结束，最终文字也保持同一人物声音；当前输入后已有普通接话送达且没有新话可 messages:[]，仅有任务前告知不能代替完成答复。',
    parameters:{type:'object',properties:{expectedTools:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{type:'string',maxLength:100,pattern:'^[a-zA-Z0-9_.:-]+$'},description:'beforeTools=true 时必填。承诺本轮实际执行的具体工具名，含必要交付；目录查询不算执行。普通接话不填。'},text:{type:'string',minLength:1,maxLength:1200},beforeTools:{type:'boolean',description:'这句话是在告知即将实际执行的动作时设为 true；普通闲聊不设置。必须等本次发送成功再执行任务。'},inlineDetails:{type:'boolean',description:'仅用户明确要求详细内容、原文或完整任务计划时使用；普通接话不借此展开长文。'}},required:['text'],additionalProperties:false},
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:(value as {actionsAdded?:boolean}).actionsAdded?'新增动作已登记，没有重复发送前置回应；继续执行新增动作，已经完成的操作不要重做。':(value as {alreadyAnnounced?:boolean}).alreadyAnnounced?'动作已告知，本次没有重复发送；继续执行任务。':'这句话已发送。继续按同一人物口吻接话或执行已告知的操作；完成后用 partner_chat_reply 结束，不重复已说内容。仅任务前告知不能代替任务最终答复。'}],presentationMeta:(_args,value)=>value},
    presentCall:()=>({card:'generic',title:'接话'}),
    async execute(raw,exec){
      const originRouteId=route();if(!originRouteId)throw Error('当前聊天目标已失效')
      const inputMessageId=currentInput(agent.session.snapshotEvents())
      const {text,beforeTools,inlineDetails,expectedTools}=raw as {text:string;beforeTools?:boolean;inlineDetails?:boolean;expectedTools?:string[]}
      exec.signal.throwIfAborted()
      if(!beforeTools&&!chatEnabled())throw Error('连续接话未开启；任务动作告知使用 beforeTools:true，普通内容用最终回复')
      if(beforeTools&&(!Array.isArray(expectedTools)||!expectedTools.length||expectedTools.length>8||expectedTools.some(n=>typeof n!=='string'||n.length>100||! /^[a-zA-Z0-9_.:-]+$/.test(n)||['partner_tools','partner_chat_say','partner_chat_reply','partner_chat_progress'].includes(n))))throw Error('动作告知尚未发送：beforeTools=true 时用 expectedTools 列出准备实际调用的具体工具名；生图并发送填实际生图工具名和 partner_send_attachment，不填 partner_tools。')
      if(beforeTools&&inputMessageId){
        // Validate exact registered names before speaking or recording obligations. No guessed aliases.
        const unknown=expectedTools!.filter(name=>!agent.ctx.tools.get(name,agent))
        if(unknown.length)throw Error('动作告知尚未发送或登记：工具名未在当前上下文注册：'+unknown.join('、')+'。先通过 partner_tools list/describe 核实具体名称，再重新告知；不要猜测别名，也不要把本检查发给用户。')
        const previous=taskSends.get(inputMessageId)
        if(previous)await previous.job
        exec.signal.throwIfAborted()
        if(currentInput(agent.session.snapshotEvents())!==inputMessageId||route()!==originRouteId)throw Error('当前输入或渠道已变化，旧动作未登记')
        const known=new Set(taskSends.get(inputMessageId)?.names??[])
        for(const event of agent.session.snapshotEvents()){
          const receipt=chatReplyFromEvent(event)
          if(receipt?.delivered&&receipt.taskPreamble&&receipt.inputMessageId===inputMessageId)for(const name of receipt.expectedTools??[])known.add(name)
        }
        const added=[...new Set(expectedTools!)].filter(name=>!known.has(name))
        if(!added.length)return {alreadyAnnounced:true}
        if(previous||hasTaskPreamble(agent.session.snapshotEvents())){
          taskSends.set(inputMessageId,{names:new Set([...known,...added]),job:Promise.resolve()})
          return {kind:'partner-chat-v1',parts:[],delivered:true,deliveryKind:'text',intermediate:true,taskPreamble:true,expectedTools:added,inputMessageId,originRouteId,alreadyAnnounced:true,actionsAdded:true}
        }
        // Local validation has no delivery side effect; do not cache its rejection as a send.
        validateSpeechText(text,!short()||inlineDetails===true)
        const job=speech.say(text,exec.signal,!short()||inlineDetails===true,true)
        taskSends.set(inputMessageId,{names:new Set(added),job});await job
      }else {
        await speech.say(text,exec.signal,inlineDetails===true)
      }
      return {kind:'partner-chat-v1',parts:[],delivered:true,deliveryKind:'text',intermediate:true,...(beforeTools?{taskPreamble:true,expectedTools:[...expectedTools!]}:{}),inputMessageId,spokenText:text.trim(),originRouteId}
    },
  })
}
