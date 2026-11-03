import { isIdleContactNotice } from '../character/idle-contact.js'
import { AGREEMENT_GUIDANCE } from '../chat/agreements.js'
import type {ToolDefinition,ToolRuntime,ToolRunContext,ToolExecutionResult} from '@deepseek-ai/dsh-tools'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {scopeTarget} from '@deepseek-ai/dsh-scope'
import type {PartnerStore} from '../store.js'
import {resolveToolAccess} from '../execution/tool-access-adapter.js'
import {discoveredToolProtocol} from '../character/prompt-projection.js'

export interface DiscoverableTool {tool:ToolDefinition;allowed:()=>boolean;protocol?:(exec:ToolRunContext)=>string}
export const PARTNER_TOOL_ENTRIES=['partner_tools','partner_channel_access','partner_memory_recall','partner_work_execute','partner_chat_reply','partner_agreement','partner_chat_say','partner_stickers'] as const
// Track actual registrations, not a name prefix: other plugins keep ownership.
const ownedTools=new WeakMap<PartnerStore,Map<string,Map<object,Set<string>>>>()
export function isPartnerDiscoveryTool(store:PartnerStore,owner:string,name:string):boolean {
 return [...(ownedTools.get(store)?.get(owner)?.values()??[])].some(names=>names.has(name))
}
const GROUPS=[
 {id:'chat',title:'聊天回复',description:'文字、表情与语音'},
 {id:'memory',title:'回忆',description:'长期记忆与历史对话检索'},
 {id:'media',title:'图片创作',description:'生图、画图、图生图与图片编辑'},
 {id:'identity',title:'身份与生活',description:'人格参考模板、角色与关系设定、好感度、自主念头、睡眠和头像'},
 {id:'work',title:'任务与协作',description:'需求、任务看板和伙伴协作'},
 {id:'automation',title:'定时与续接',description:'定时计划、长任务等待与恢复'},
 {id:'skills',title:'技能',description:'查询、加载和运行已启用 Skill'},
 {id:'management',title:'伙伴管理',description:'创建伙伴、单向授权和管理配置'},
 {id:'channels',title:'渠道与附件',description:'QQ 空间、资料修改和文件交付'},
 {id:'mcp',title:'外部 MCP',description:'已授权的外部服务工具'},
 {id:'other',title:'其他能力',description:'宿主和其他已授权扩展工具'},
]
const IMAGE_ALIASES=['生图','画图','绘图','生成图片','图片生成','图生图','改图','编辑图片','图片编辑','画一张','画张','绘制','图片','image generation','image editing']
function toolSearchMatches(tool:ToolDefinition,query:string):boolean {
 if(tool.name==='partner_qq_reply'&&/(?:@|提及|艾特|戳一戳|拍一拍|poke|mention|语音)/iu.test(query))return true
 return `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(query) || ['generate_image','image_gen.imagegen'].includes(tool.name) && IMAGE_ALIASES.some(alias=>alias.includes(query)||query.includes(alias))
}
function category(name:string):string {
 if(name==='partner_memory_recall')return 'memory'
 if(['generate_image','image_gen.imagegen'].includes(name))return 'media'
 if(['partner_chat_reply','partner_agreement','partner_chat_say','partner_chat_progress','partner_stickers','partner_qq_reply'].includes(name))return 'chat'
 if(/identity|affection|thoughts|sleep|avatar|activity/.test(name))return 'identity'
 if(/task_board|requirements|collaborate|work_execute|workflow/.test(name))return 'work'
 if(/schedule/.test(name))return 'automation'
 if(/skill/.test(name))return 'skills'
 if(/companions|management|access_grants|companion_manage/.test(name))return 'management'
 if(/qq|attachment/.test(name))return 'channels'
 if(/mcp/.test(name))return 'mcp'
 return 'other'
}
const PERSONA_REFERENCE_CALL = JSON.stringify({action:'call',name:'partner_identity',argumentsJson:JSON.stringify({action:'reference'})})
export const TOOL_DISCOVERY_PROMPT=AGREEMENT_GUIDANCE+'\n'+'partner_channel_access 查询真实渠道权限摘要，partner_tools 分页查询和调用能力。partner_work_execute 是直接可调用的调查与多步执行入口，无需先查询目录或 describe。partner_memory_recall 是直接公开的基础回忆工具，也可通过统一入口调用，无需先加载；所有聊天账号可用，按真实会话检索。默认渠道沿用既有授权，QQ 由渠道适配器核验账号；不接受模型自报账号或权限。先用 list 查询（可按 category/query 缩小），describe 或 load 查看参数，再用 partner_tools action=call、name=真实工具名、argumentsJson=原工具参数的 JSON 字符串执行；不会另行向顶层工具表添加工具。伙伴入口只管理本插件注册的能力；其他插件和宿主工具保留自己的顶层入口，直接按其说明调用，不经 partner_tools 转调。生图优先用顶层 image_gen.imagegen，兼容 generate_image；一次请求只调用其中一个，动作登记使用实际工具名。图片生成后用 partner_send_attachment 交付返回文件，确认渠道回执后再回复；不要把本地文件链接当作已发送。回应和结果说明保持当前人格。私聊任务与普通接话统一使用 partner_chat_say。执行工具前 call partner_chat_say，argumentsJson 为 {"text":"按当前人格简短说准备做什么","beforeTools":true,"expectedTools":["本轮准备调用的真实工具名"]} 的 JSON 字符串；成功后再工作，此工具不结束回合。partner_chat_say、partner_chat_reply 和 partner_stickers 提供在顶层时直接调用，不必先查目录。当前用户聊天可以用 partner_chat_say 先说一句并继续本轮，确认送达后再自然补话；不必等自主活动。说完使用 partner_chat_reply；当前输入后已有接话送达且没有新话时可 messages:[] 安静结束。最终文字回复使用 partner_chat_reply，参数为 {"messages":[{"text":"要说的话"}]}，表情独立使用 {"stickerId":"库内ID"}；先完成工作再提交最终回复。需分条时在 messages 中提交多个 text 条目，普通正文换行不会分条；未提供聊天工具时用普通最终回答。人格参考模板在 partner_identity 内置，包含基本身份、角色设定、关系设定和 qq-bridge 大肥鱼原卡；用户要参考时直接向 partner_tools 传入 '+PERSONA_REFERENCE_CALL+'，无需搜索 cosplay 配置或文件。普通修改和自主优化不要求读模板。每次调用都会再次检查实时权限，原工具审批、超时、取消与终结行为保留。'

/** Stable model-facing entries; original definitions remain registered in scope
 * so the normal DSH execution pipeline owns validation, policy and cancellation. */
export function installToolDiscovery(runtime:ToolRuntime,owner:string,store:PartnerStore,entries:DiscoverableTool[]):()=>void {
 const disposers:Array<()=>void>=[]
 const registrations=ownedTools.get(store)??new Map<string,Map<object,Set<string>>>()
 ownedTools.set(store,registrations)
 const scopes=registrations.get(owner)??new Map<object,Set<string>>()
 registrations.set(owner,scopes)
 const token={}
 scopes.set(token,new Set(entries.map(entry=>entry.tool.name)))
 disposers.push(()=>{scopes.delete(token);if(!scopes.size&&registrations.get(owner)===scopes)registrations.delete(owner)})
 let closed=false
 const guard=(exec:ToolRunContext)=>{
  const sessionId=exec.agent?.session.id,state=store.snapshot()
  if(closed||store.isCompanionRemoving(owner)||!state.companions.some(c=>c.id===owner&&c.toolDiscovery)||!sessionId||!state.sessions.some(r=>r.companionId===owner&&r.sessionId===sessionId))throw Error('当前会话不能使用此伙伴的工具入口')
  exec.signal.throwIfAborted()
 }
 const available=(exec:ToolRunContext)=>{
  const access=resolveToolAccess({agent:exec.agent!,state:store.snapshot()})
  const tools=new Map<string,ToolDefinition>()
  for(const entry of entries){const tool=runtime.get(entry.tool.name,exec.agent);if(entry.allowed()&&tool)tools.set(tool.name,tool)}
  return [...tools.values()].filter(tool=>!['partner_tools','partner_channel_access','run_code'].includes(tool.name)&&access.sendTools&&(!access.allowedTools||access.allowedTools.includes(tool.name)))
 }
 const visible=(tool:ToolDefinition)=>({name:tool.name,category:category(tool.name),summary:(['generate_image','image_gen.imagegen'].includes(tool.name)?'生图、画图、图生图、图片编辑。'+tool.description:tool.description).slice(0,160)})
 const render=(_args:unknown,value:unknown)=>{
  const result=value as {dispatch?:ToolExecutionResult;failureReceipt?:{kind:'tool_error';callId:string;excerpt:string;toolName:string}}
  return result.dispatch?[...result.dispatch.content,...(result.failureReceipt?[{type:'text' as const,text:JSON.stringify({taskEvidence:{kind:result.failureReceipt.kind,callId:result.failureReceipt.callId,excerpt:result.failureReceipt.excerpt},toolName:result.failureReceipt.toolName,notice:'这是本次实际失败的工具回执，可用于结束失败任务。callId 是工具调用编号，不是服务报错中的 request ID；不要重试来获取证据。'})}]:[])]:[{type:'text' as const,text:JSON.stringify(value)}]
 }
 const unavailable=(name:string|undefined,exec:ToolRunContext)=>new Error(name&&!entries.some(entry=>entry.tool.name===name)&&runtime.get(name,exec.agent)
  ? '此工具不属于伙伴插件，请使用其自身提供的入口，不经 partner_tools 转调；权限仍以当前渠道为准。'
  : !name||!runtime.get(name,exec.agent)
  ? '工具在当前执行上下文中未注册或已结束，请重新查询目录。这不表示账号没有权限，不要据此要求用户更换账号或授权。'
  : '当前渠道未授权此能力或能力已撤回，请查询 partner_channel_access 核实当前能力。')
 const invoke=async(name:string,args:unknown,exec:ToolRunContext)=>{
  guard(exec)
  if(!available(exec).some(tool=>tool.name===name))throw unavailable(name,exec)
  const subCallId=ToolCallId(`${exec.callId}:capability`),rootCallId=exec.rootCallId??exec.callId
  const log={rootCallId,parentCallId:exec.callId,subCallId,name,arguments:JSON.stringify(args)}
  exec.agent!.session.append('tool/ptc-dispatch-start',log)
  const result=await runtime.execute({name,arguments:args,agent:exec.agent!,signal:exec.signal,callId:subCallId,rootCallId,parent:exec.token})
  let content=result.content
  // Honor the host's durable-log projection (large output locators/redaction).
  try {content=await exec.agent!.ctx.waterfall(scopeTarget(runtime,exec.agent!), 'tools/ptc-dispatch-log',{exec,agent:exec.agent!,subCallId,name,isError:result.isError,content},()=>Promise.resolve(content))}catch { /* the settled result must still be recorded */ }
  exec.agent!.session.append('tool/ptc-dispatch',{...log,isError:result.isError,content,...(result.meta===undefined?{}:{meta:result.meta}),...(result.error?.info===undefined?{}:{error:result.error.info})})
  for(const context of result.additionalContexts??[])exec.deferContext(context)
  if(result.concludesTurn)exec.concludeTurn()
  const errorText=content.flatMap(b=>b.type==='text'?[b.text]:[]).join('\n')
  return {dispatch:result,...(result.isError&&errorText.trim()?{failureReceipt:{kind:'tool_error' as const,callId:subCallId,excerpt:errorText.trim().slice(0,500),toolName:name}}:{})}
 }
 try {
  for(const entry of entries)disposers.push(runtime.register({...entry.tool,execute:async(args,exec)=>{if(!entry.allowed())throw Error('能力已撤回');return entry.tool.execute(args,exec)}}))
  disposers.push(runtime.register({name:'partner_channel_access',description:'查询真实渠道与当前发言账号的能力权限。默认适配器沿用已有授权；QQ 普通成员提供回复、表情发送与收藏整理、语音、真正群 @ 提及、已开启的戳一戳、本会话回忆、已开启的当前会话消息表情回应与群信息查询，归属账号与可信自主任务可使用已授权能力。不接受自报账号，不改变权限。返回的能力通过 partner_tools 调用。',
   parameters:{type:'object',properties:{category:{type:'string'},query:{type:'string',maxLength:80},offset:{type:'integer',minimum:0}},additionalProperties:false},output:{schema:{type:'object'},render},presentCall:()=>({card:'generic',title:'当前渠道能力'}),
   async execute(raw,exec){
    guard(exec)
    const access=resolveToolAccess({agent:exec.agent!,state:store.snapshot()}),all=available(exec)
    const args=raw as {category?:string;query?:string;offset?:number}
    const query=(args.query??'').trim().toLocaleLowerCase(),offset=args.offset??0
    if(args.category&&!GROUPS.some(g=>g.id===args.category))throw Error('分类不存在')
    if(!Number.isSafeInteger(offset)||offset<0||query.length>80)throw Error('查询参数无效')
    const currentInput=[...exec.agent!.session.snapshotEvents()].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)))
    const autonomous=!!currentInput&&isIdleContactNotice(currentInput)
    const filtered=args.category||query||args.offset!==undefined
    const found=all.filter(t=>(!args.category||category(t.name)===args.category)&&(!query||toolSearchMatches(t,query)))
    return {scope:access.allowedTools?'chat-only':'authorized',
     scopeMeaning:'这是当前入口的权限快照，不是可行性调查；缺少专用工具不证明无法通过现有工具实现，也不改变历史权限。',
     categories:GROUPS.map(g=>({id:g.id,title:g.title,count:all.filter(t=>category(t.name)===g.id).length})).filter(g=>g.count),
     total:filtered?found.length:all.length,
     ...(filtered?{tools:found.slice(offset,offset+12).map(visible),nextOffset:offset+12<found.length?offset+12:null}:{}),
     next:autonomous?'这些分类来自当前实时授权的伙伴工具。按自己的兴趣选择 category/query 看具体能力，再 describe 核实参数；可探索、尝试或继续自己的事情，不必为了联系归属账号找话题。其他插件通过其自身入口发现，新能力仍按实时权限使用。':all.some(t=>t.name==='partner_work_execute')?'核实实现方案或排查问题直接调用 partner_work_execute；只需工具目录时按 category/query/offset 分页查询。':'按 category/query/offset 分页查询能力；具体参数用 partner_tools describe。',
     ...(access.denialReason?{notice:access.denialReason}:{})}
   }
  }))
  disposers.push(runtime.register({name:'partner_tools',description:'仅查询、调用伙伴插件自身已授权工具；其他插件直接使用自己的入口。list 按 category/query 返回概要，describe（或兼容 load）返回完整参数；call 使用 name 和 argumentsJson（原工具参数的 JSON 字符串）执行，仍走原权限、审批和取消流程。切换账号不增删顶层工具。人格参考模板直接调用：'+PERSONA_REFERENCE_CALL+'。聊天调用 partner_chat_reply，原工具参数为 {"messages":[{"text":"回复内容"}]}，须序列化到 argumentsJson；表情先查询 partner_stickers。分条聊天用多个 text 条目；仅需一条或聊天工具不可用时可直接最终回答。',
   parameters:{type:'object',properties:{action:{type:'string',enum:['list','describe','load','unload','call']},category:{type:'string'},query:{type:'string',maxLength:80},name:{type:'string'},offset:{type:'integer',minimum:0},argumentsJson:{type:'string',maxLength:200000}},required:['action'],additionalProperties:false},
   output:{schema:{type:'object'},render},presentCall:()=>({card:'generic',title:'伙伴能力'}),
   async execute(raw,exec){
    guard(exec)
    const args=raw as {action:string;category?:string;query?:string;name?:string;offset?:number;argumentsJson?:string}
    const all=available(exec)
    if(args.action==='list'){
     const query=(args.query??'').trim().toLocaleLowerCase(),offset=args.offset??0
     if(args.category&&!GROUPS.some(g=>g.id===args.category))throw Error('分类不存在，请先查询分类')
     if(!Number.isSafeInteger(offset)||offset<0||query.length>80)throw Error('查询参数无效')
     if(!args.category&&!query)return {categories:GROUPS.map(g=>({...g,count:all.filter(t=>category(t.name)===g.id).length})).filter(g=>g.count),next:'按 category 或 query 查询；call 通过本入口执行'}
     const found=all.filter(t=>(!args.category||category(t.name)===args.category)&&(!query||toolSearchMatches(t,query)))
     return {tools:found.slice(offset,offset+12).map(visible),total:found.length,nextOffset:offset+12<found.length?offset+12:null,...(!found.length?{scopeMeaning:'仅表示当前工具名称和说明未匹配，不是功能可行性结论。',...(all.some(t=>t.name==='partner_work_execute')?{next:'用户要求查证、寻找实现方案或排障时，调用 partner_work_execute 继续调查；不要把空目录当作调查结果。'}:{})}:{})}
    }
    const tool=all.find(t=>t.name===args.name)
    if(!tool)throw unavailable(args.name,exec)
    if(args.action==='call'){
     if(typeof args.argumentsJson!=='string'||args.argumentsJson.length>200000)throw Error('请用 argumentsJson 提交工具参数 JSON')
     let parameters:unknown
     try {parameters=JSON.parse(args.argumentsJson)}catch {throw Error('argumentsJson 必须是有效 JSON')}
     return invoke(tool.name,parameters,exec)
    }
    if(args.action==='unload')return {name:tool.name,notice:'能力由统一入口调用，无需卸载；未修改权限'}
    if(!['describe','load'].includes(args.action))throw Error('操作无效')
    const protocol=[entries.find(e=>e.tool.name===tool.name)?.protocol?.(exec),discoveredToolProtocol(exec.agent,tool.name)].filter(Boolean).join('\n\n')
    return {name:tool.name,description:tool.description,parameters:tool.parameters,...(protocol?{protocol}:{}),next:PARTNER_TOOL_ENTRIES.some(name=>name===tool.name)?'此基础入口已提供时可直接调用；也兼容 partner_tools action=call 转调。':'用 partner_tools action=call，name 为此名称，argumentsJson 为参数 JSON 字符串；不要直接调用原工具名。'}
   }
  }))
 }catch(error){for(const dispose of disposers.reverse())dispose();throw error}
 return ()=>{closed=true;for(const dispose of disposers.reverse())dispose()}
}
