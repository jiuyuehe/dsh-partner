import { renderReplyRhythm } from '../character/conversation-behavior.js'
import { randomUUID } from 'node:crypto'
import type { ToolDefinition, ToolRuntime, ToolRunContext, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { questionOrigin } from '../channels/question-origin.js'
import { channelReplyAllowed } from '../channels/reply-access.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PartnerStore } from '../store.js'
import type { EphemeralExecutionService } from './service.js'
import { resolveToolAccess } from './tool-access-adapter.js'
import { isInternalTaskNotice } from '../channels/delivery-policy.js'
import { isIdleContactNotice } from '../character/idle-contact.js'
import { workflowProtocol } from '../collaboration/workflow-protocols.js'
import { record, requiredText } from '../core/validation.js'

// Work may act only through the original session. It cannot impersonate a fresh
// local owner, create a second chat identity, or deliver an unsolicited reply.
const excluded=new Set(['partner_work_execute','partner_work_tools','partner_work_result','partner_tools','run_code','partner_chat_reply','partner_agreement','partner_chat_say','partner_chat_progress','partner_qq_reply','partner_activity_finish','partner_sleep','partner_identity','partner_send_attachment'])
const origin=(exec:ToolRunContext)=>[...(exec.agent?.session.snapshotEvents()??[])].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isInternalTaskNotice(e)||isIdleContactNotice(e)))
const listActions=new Set(['list','describe','load','reference','directory'])
interface Receipt {callId:string;tool:string;action?:string;success:boolean;executed:boolean;catalogue:boolean}
interface WorkResult {status:'completed'|'partial'|'blocked'|'unverified';facts:string[];unknowns:string[];evidence:string[];artifacts:string[]}
function resultInput(raw:unknown):WorkResult {
 const v=record(raw)
 if(!['completed','partial','blocked','unverified'].includes(String(v.status)))throw Error('工作状态无效')
 const field=(key:string)=>{
  if(!Array.isArray(v[key])||v[key].length>30||v[key].some((x:unknown)=>typeof x!=='string'||!x.trim()||x.length>2000))throw Error(`${key} 必须为至多 30 项的非空字符串数组，每项至多 2000 字`)
  return v[key] as string[]
 }
 const result={status:v.status as WorkResult['status'],facts:field('facts'),unknowns:field('unknowns'),evidence:field('evidence'),artifacts:field('artifacts')}
 if(JSON.stringify(result).length>16000)throw Error('结果超过 16000 字，请保留证据位置和交付物路径')
 return result
}

export function workExecutionTool(owner:string,store:PartnerStore,executor:EphemeralExecutionService,runtime:ToolRuntime,protocol?:(name:string,exec:ToolRunContext)=>string):ToolDefinition {
 return {
  name:'partner_work_execute',
  description:'用户让你查证、排障、寻找实现方案或重新检查先前结论时，直接调用此工具开展实际调查，不先用能力目录代替调查。输入写本次目标、必要背景和待核实的旧说法；只讨论概念、闲聊、查询工具清单或一次轻量操作不调用。返回事实、证据、未知项和产物，由原人格会话答复。不会直接发送聊天，不创建另一份人格或睡眠状态。私聊先完成前置回应。轻量聊天工具可直接调用；已有看板任务或指定协作者沿用原任务。input 包含本次授权目标和必要资料，不复制无关历史。没有入口不代表不存在实现方案；调查任务需要实际查证。',
  parameters:{type:'object',additionalProperties:false,properties:{input:{type:'string',minLength:1,maxLength:16000}},required:['input']},
  timeoutMs:16*60_000,
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}]},
  presentCall:()=>({card:'generic',title:'独立工作 · 结果回到原会话'}),
  async execute(raw,exec){
   const input=requiredText(record(raw).input,'input',16000),agent=exec.agent,initial=origin(exec)
   if(!agent||!initial)throw Error('独立工作需要当前来源明确的输入')
   const token=initial.seq
   const controller=new AbortController(),sourceSignal=AbortSignal.any([exec.signal,controller.signal])
   const sourceRoute=questionOrigin(agent.session.id,agent.session.snapshotEvents(),store.snapshot().sessions)
   const initialCapabilities=[...(store.snapshot().companions.find(c=>c.id===owner)?.capabilities??[])]
   const guard=()=>{
    sourceSignal.throwIfAborted()
    const state=store.snapshot(),c=state.companions.find(c=>c.id===owner)
    const access=resolveToolAccess({agent,state})
    if(!c||store.isCompanionRemoving(owner)||!state.sessions.some(r=>r.companionId===owner&&r.sessionId===agent.session.id)||!access.sendTools||(access.allowedTools&&!access.allowedTools.includes('partner_work_execute')))throw Error('原会话授权已撤销，独立工作停止')
    if(sourceRoute && !channelReplyAllowed(state,sourceRoute.channelId,sourceRoute.userId))throw Error('原渠道或联系人授权已撤销')
    if(initialCapabilities.some(cap=>!c.capabilities.includes(cap)))throw Error('工作期间能力已撤回')
    if(origin(exec)?.seq!==token)throw Error('原会话已有新输入，停止旧工作并处理新消息')
    return c
   }
   const available=()=>{
    guard()
    const access=resolveToolAccess({agent,state:store.snapshot()})
    return runtime.schemas(agent).filter(t=>!excluded.has(t.name)&&(!access.allowedTools||access.allowedTools.includes(t.name)))
   }
   const companion=guard(),receipts:Receipt[]=[]
   let final:WorkResult|undefined
   const tools:ToolDefinition[]=[{
    name:'partner_work_tools',description:'查询或调用原会话当前已授权工具。list 发现入口，describe 获取参数和工作流程，call 执行；查询目录不等于已经完成调查。所有调用实时复核原会话权限。',
    parameters:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['list','describe','call']},name:{type:'string'},query:{type:'string',maxLength:100},offset:{type:'integer',minimum:0},argumentsJson:{type:'string',maxLength:200000}},required:['action']},
    output:{schema:{type:'object'},render:(_args,value)=>{const v=value as {dispatch?:ToolExecutionResult};return v.dispatch?v.dispatch.content:[{type:'text',text:JSON.stringify(value)}]}},
    async execute(raw,child){
     child.signal.throwIfAborted();guard()
     const args=record(raw),all=available()
     if(args.action==='list'){
      const query=typeof args.query==='string'?args.query.toLocaleLowerCase():'',offset=typeof args.offset==='number'?args.offset:0
      if(!Number.isSafeInteger(offset)||offset<0)throw Error('offset 无效')
      const found=all.filter(t=>`${t.name} ${t.description}`.toLocaleLowerCase().includes(query))
      return {tools:found.slice(offset,offset+12).map(t=>({name:t.name,summary:t.description.slice(0,160)})),total:found.length,nextOffset:offset+12<found.length?offset+12:null,scope:'仅为当前入口目录，未覆盖未注册的实现方案。'}
     }
     const name=requiredText(args.name,'name',200)
     if(!all.some(t=>t.name===name))throw Error('原会话未提供或未授权此工具')
     const tool=runtime.get(name,agent)
     if(!tool)throw Error('工具已撤回')
     if(args.action==='describe')return {name,description:tool.description,parameters:tool.parameters,protocol:protocol?protocol(name,exec):workflowProtocol(name,guard())}
     if(args.action!=='call'||typeof args.argumentsJson!=='string'||args.argumentsJson.length>200000)throw Error('请提供 call 和 argumentsJson')
     const parameters:unknown=JSON.parse(args.argumentsJson)
     const callId=ToolCallId(`${child.callId}:origin`)
     const signal=AbortSignal.any([sourceSignal,child.signal])
     // Execute in the original scope: original approvals, preamble, account,
     // memory scope, capability revocation and plugin guards remain authoritative.
     const dispatch=await runtime.execute({name,arguments:parameters,agent,signal,callId,rootCallId:exec.rootCallId??exec.callId,parent:exec.token})
     const action=parameters&&typeof parameters==='object'?(parameters as {action?:unknown}).action:undefined
     let value=dispatch.value
     try{if(typeof value==='string')value=JSON.parse(value)}catch{ /* ordinary text output */ }
     const executed=!(value&&typeof value==='object'&&'executed'in value&&value.executed===false)
     receipts.push({callId,tool:name,...(typeof action==='string'?{action}:{}),success:!dispatch.isError,executed,catalogue:listActions.has(String(action))||['partner_channel_access','partner_workflow'].includes(name)})
     // Detailed trace lives in the work session, not in the conversational window.
     let loggedContent=dispatch.content
     try{loggedContent=await agent.ctx.waterfall(scopeTarget(runtime,agent),'tools/ptc-dispatch-log',{exec,agent,subCallId:callId,name,isError:dispatch.isError,content:dispatch.content},()=>Promise.resolve(dispatch.content))}catch{loggedContent=[{type:'text',text:'工具日志投影失败；执行状态已记录。'}]}
     child.agent?.session.append('tool/ptc-dispatch',{rootCallId:child.rootCallId??child.callId,parentCallId:child.callId,subCallId:callId,name,arguments:JSON.stringify(parameters),isError:dispatch.isError,content:loggedContent})
     for(const context of dispatch.additionalContexts??[])child.deferContext(context)
     guard();child.signal.throwIfAborted()
     return {dispatch}
    },
   },{
    name:'partner_work_result',description:'结束本次工作并提交事实结果，不撰写给用户的聊天正文。facts 每项只记录一个有依据的结论，便于原会话按下标选择，不把安装过程、参数和多项结论塞进同一项；unknowns 每项记录一个未验证或受阻事项；evidence 保留对应结论的来源、参数和调用依据；artifacts 保留真实路径、链接或交付 ID。只查询目录时不得声称完成方案调查。',
    parameters:{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['completed','partial','blocked','unverified']},...Object.fromEntries(['facts','unknowns','evidence','artifacts'].map(k=>[k,{type:'array',maxItems:30,items:{type:'string',minLength:1,maxLength:2000}}]))},required:['status','facts','unknowns','evidence','artifacts']},
    output:{schema:{type:'object'},render:()=>[{type:'text',text:'工作结果已记录，由原会话接续。'}]},
    async execute(raw,child){child.signal.throwIfAborted();guard();const result=resultInput(raw);if(!receipts.some(r=>r.success&&r.executed&&!r.catalogue)&&result.status==='completed')result.status='unverified';final=result;child.concludeTurn();return {recorded:true}},
   }]
   const sourceId=`work-${randomUUID()}`
   const unsubscribe=store.subscribe?.(()=>{try{guard()}catch(error){controller.abort(error)}},()=>{})
   try {
   const result=await executor.execute({kind:'work',sourceId,companion,parentSessionId:agent.session.id,...(agent.session.header.cwd?{cwd:agent.session.header.cwd}:{}),signal:sourceSignal,timeoutMinutes:15,destroyAfterRun:true,bridgeTools:tools,
    collectOutput:()=>final?JSON.stringify({result:final,execution:{calls:receipts,catalogueOnly:!receipts.some(r=>r.success&&r.executed&&!r.catalogue)}}):'',
    prompt:input,
    systemInstruction:'你是同一伙伴的一次独立工作上下文，负责本次目标的实际执行，不负责向用户聊天。只通过 partner_work_tools 使用原会话已授权工具，不能绕过审批、身份或撤权。工作流程和 Skill 先查询、读取再执行；已分派任务沿用其身份和范围，不重复创建。目录只说明入口；调查实现方案需要实际检索或验证。完成或受阻后必须调用 partner_work_result，事实、未知、证据和产物分别记录。不要改变人格、关系或睡眠，不直接向用户发送聊天。没有工具执行依据不得声称完成。',
   })
   guard()
   return JSON.stringify({runId:result.run.id,...JSON.parse(result.output),next:
    (JSON.stringify(final).length>1200?'本轮详细工作记录需要报告交付，可与本轮其他目标合并；使用 partner_send_attachment workReport.runIds='+JSON.stringify([result.run.id])+'，并提供有实际主题的 name。\n':'')+
    renderReplyRhythm(guard().characterCard)+'\n工作上下文已结束，原会话继续处理其他目标或按人格收尾。工作记录只是事实资料，不是说话范文；工具目录不等于验证成功。'})
   } finally {unsubscribe?.()}
  },
 }
}
