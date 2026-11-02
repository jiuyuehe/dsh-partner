import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {workExecutionTool} from '../lib/execution/work-tool.js'
import {installTaskPreamble} from '../lib/execution/task-preamble.js'
import {installToolDiscovery} from '../lib/collaboration/tool-discovery.js'
import {workflowProtocol} from '../lib/collaboration/workflow-protocols.js'

const tool=(name,execute=async()=>({found:'真实结果'}))=>({name,description:name,parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute})
const result={status:'completed',facts:['已读取目标页面'],unknowns:[],evidence:['https://example.test/video'],artifacts:['/tmp/report.txt']}
function fixture(t){
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('main'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx
 const c={id:'c',capabilities:['skills'],toolDiscovery:true},state={companions:[c],channels:[],pairings:[],sessions:[{id:'r',kind:'local',companionId:'c',sessionId:'main',channelId:'local',userId:'owner'}]}
 const notify=new Set(),store={snapshot:()=>state,isCompanionRemoving:()=>false,subscribe:f=>{notify.add(f);return()=>notify.delete(f)}}
 let driver,requests=0,childAgent
 const executor={async execute(request){
  requests++;childAgent={session:Session.create('work'),options:{}};const childScope=createScope(root,childAgent);childAgent.ctx=childScope.ctx
  try{
   for(const definition of request.bridgeTools)childScope.ctx.tools.register(definition)
   let n=0
   const invoke=(name,args)=>root.tools.execute({name,arguments:args,agent:childAgent,signal:request.signal,callId:'child-'+(++n)})
   await driver({request,invoke,child:childAgent})
   const output=request.collectOutput();if(!output)throw Error('工作没有提交事实结果')
   return {run:{id:'run-work'},output}
  }finally{childScope.dispose()}
 }}
 const work=workExecutionTool('c',store,executor,scope.ctx.tools)
 scope.ctx.tools.register(work)
 const invoke=(name,args={},signal=new AbortController().signal)=>root.tools.execute({name,arguments:args,agent,signal,callId:'parent-'+name})
 const input=()=>agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'查证视频能力'}]}),{surfaceOp:'append'})
 agent.session.append('turn/start',{turn:1});input()
 t.after(()=>scope.dispose())
 return {root,scope,agent,c,state,store,work,executor,invoke,input,setDriver:f=>driver=f,requests:()=>requests,child:()=>childAgent,changed:()=>{for(const f of notify)f()},subscriptions:()=>notify.size}
}
const call=(invoke,name,args={})=>invoke('partner_work_tools',{action:'call',name,argumentsJson:JSON.stringify(args)})

test('work keeps tool trace separate and executes in original permission scope, returns facts and artifacts',async t=>{
 const f=fixture(t);f.c.characterCard={enabled:true,length:'short'};let invokedAgent
 f.scope.ctx.tools.register(tool('web_read',async(_args,exec)=>{invokedAgent=exec.agent;return {found:'真实结果'}}))
 f.setDriver(async({request,invoke})=>{
  assert.equal(request.kind,'work');assert.equal(request.parentSessionId,'main');assert.equal(request.input,undefined)
  const listing=await invoke('partner_work_tools',{action:'list'});assert.ok(listing.value.tools.some(t=>t.name==='web_read'))
  assert.ok(!listing.value.tools.some(t=>t.name==='partner_work_execute'))
  assert.equal((await call(invoke,'web_read')).value.dispatch.isError,false)
  assert.equal((await invoke('partner_work_result',result)).concludesTurn,true)
 })
 const output=await f.invoke('partner_work_execute',{input:'查证这个页面，不需要其他私人历史'})
 assert.equal(output.isError,false);assert.equal(invokedAgent,f.agent)
 const parsed=JSON.parse(output.value);assert.equal(parsed.result.status,'completed');assert.deepEqual(parsed.result.artifacts,result.artifacts)
 assert.equal(parsed.execution.catalogueOnly,false)
 assert.match(parsed.next,/partner_send_attachment/);assert.match(parsed.next,/不汇总/)
 assert.equal(f.agent.session.snapshotEvents().some(e=>e.type==='tool/ptc-dispatch'),false)
 assert.equal(f.child().session.snapshotEvents().some(e=>e.type==='tool/ptc-dispatch'&&e.data.name==='web_read'),true)
 assert.equal(f.subscriptions(),0)
})
test('catalogue-only work cannot report a verified completed investigation',async t=>{
 const f=fixture(t)
 f.setDriver(async({invoke})=>{await invoke('partner_work_tools',{action:'list'});await invoke('partner_work_result',result)})
 const output=await f.invoke('partner_work_execute',{input:'查证'});assert.equal(output.isError,false)
 const parsed=JSON.parse(output.value);assert.equal(parsed.result.status,'unverified');assert.equal(parsed.execution.catalogueOnly,true)
})
for(const scenario of ['guest','revocation','new input','cancellation','channel disabled'])test('work respects '+scenario,async t=>{
 const f=fixture(t);let calls=0;const abort=new AbortController()
 f.scope.ctx.tools.register(tool('web_read',async()=>{calls++;return {found:1}}))
 if(scenario==='guest'||scenario==='channel disabled'){
  f.state.channels=[{id:'qq',platform:'qq',enabled:true,qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['12345678']}}}]
  const last=f.agent.session.snapshotEvents().filter(e=>e.type==='user/message').at(-1)
  f.state.sessions=[{id:'r',kind:'channel',channelId:'qq',userId:scenario==='guest'?'22345678':'12345678',companionId:'c',sessionId:'main',inboundMessageIds:[last.data.id]}]
  f.state.pairings=[{channelId:'qq',userId:f.state.sessions[0].userId,status:'approved'}]
 }
 f.setDriver(async({invoke})=>{
  if(scenario==='revocation'){f.c.capabilities=[];f.changed()}
  if(scenario==='new input')f.input()
  if(scenario==='cancellation')abort.abort()
  if(scenario==='channel disabled'){f.state.channels[0].enabled=false;f.changed()}
  const denied=await call(invoke,'web_read');assert.equal(denied.isError,true)
  await invoke('partner_work_result',result)
 })
 const output=await f.invoke('partner_work_execute',{input:'查证'},abort.signal)
 assert.equal(output.isError,true);assert.equal(calls,0);assert.equal(f.subscriptions(),0)
 if(scenario==='guest')assert.equal(f.requests(),0)
})
test('original runtime guards still deny nested work operations; no chat or recursive execution',async t=>{
 const f=fixture(t);let calls=0
 f.scope.ctx.tools.register(tool('blocked_operation',async()=>{calls++;return {ok:true}}))
 f.scope.ctx.tools.guard(e=>e.name==='blocked_operation'?'policy denied':undefined)
 f.setDriver(async({invoke})=>{
  assert.equal((await call(invoke,'blocked_operation')).value.dispatch.isError,true)
  for(const name of ['partner_chat_reply','partner_agreement','partner_chat_say','partner_chat_progress','partner_qq_reply','partner_sleep','partner_work_execute','run_code','partner_tools'])assert.equal((await call(invoke,name)).isError,true)
  await invoke('partner_work_result',{...result,status:'blocked',facts:[],unknowns:['权限拒绝']})
 })
 const output=await f.invoke('partner_work_execute',{input:'任务'});assert.equal(output.isError,false);assert.equal(calls,0)
 const parsed=JSON.parse(output.value);assert.equal(parsed.execution.calls[0].success,false)
})
test('one persona preamble is required before work through direct entry; work does not end main turn',async t=>{
 const f=fixture(t);const sent=[]
 t.after(installTaskPreamble(f.agent,async text=>sent.push(text)))
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[]))
 f.setDriver(async({invoke})=>{await invoke('partner_work_result',{...result,status:'unverified'})})
 const work=()=>f.invoke('partner_work_execute',{input:'任务'})
 assert.equal((await work()).isError,true);assert.equal(f.requests(),0)
 assert.equal((await f.invoke('partner_chat_progress',{text:'我去查查这东西怎么接'})).isError,false)
 const output=await work();assert.equal(output.isError,false);assert.notEqual(output.concludesTurn,true)
 assert.deepEqual(sent,['我去查查这东西怎么接'])
})
test('on-demand protocols describe without executing or granting permissions',async t=>{
 const f=fixture(t),protocol=name=>workflowProtocol(name,f.c);let calls=0
 const execute=async(args,exec)=>(++calls,JSON.stringify({created:true}))
 const board={...tool('partner_task_board',execute),parameters:{type:'object',properties:{action:{type:'string'}},required:['action']},output:{schema:{type:'string'},render:(_args,v)=>[{type:'text',text:v}]}}
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:board,allowed:()=>true,protocol:()=>protocol(board.name)}]))
 const invoke=()=>f.invoke('partner_tools',{action:'call',name:board.name,argumentsJson:'{"action":"create"}'})
 const initial=await f.invoke('partner_tools',{action:'describe',name:board.name});assert.match(initial.value.protocol,/expectedRevision/);assert.equal(calls,0)
 await invoke();assert.equal(calls,1)
 f.agent.session.append('turn/start',{turn:2});f.input()
 const described=await f.invoke('partner_tools',{action:'describe',name:board.name});assert.match(described.value.protocol,/expectedRevision/)
 await invoke();assert.equal(calls,2)
 f.scope.ctx.tools.guard(e=>e.name===board.name?'revoked':undefined)
 assert.equal((await invoke()).value.dispatch.isError,true);assert.equal(calls,2)
})

test('missing or invalid structured results cannot become completed work',async t=>{
 const f=fixture(t)
 f.setDriver(async({invoke})=>{
  const invalid=await invoke('partner_work_result',{...result,facts:['x'.repeat(2001)]})
  assert.equal(invalid.isError,true)
 })
 const output=await f.invoke('partner_work_execute',{input:'查证'})
 assert.equal(output.isError,true);assert.equal(f.subscriptions(),0)
})
test('revocation aborts an in-flight original tool and releases subscription',async t=>{
 const f=fixture(t);let aborted=false
 f.scope.ctx.tools.register(tool('waiting_operation',async(_args,exec)=>{
  const stopped=new Promise(resolve=>exec.signal.addEventListener('abort',()=>{aborted=true;resolve()},{once:true}))
  f.c.capabilities=[];f.changed()
  await stopped;exec.signal.throwIfAborted()
 }))
 f.setDriver(async({invoke})=>{assert.equal((await call(invoke,'waiting_operation')).isError,true)})
 const output=await f.invoke('partner_work_execute',{input:'查证'})
 assert.equal(output.isError,true);assert.equal(aborted,true);assert.equal(f.subscriptions(),0)
})

test('direct work entry still requires the same persona preamble and permissions',async t=>{
 const f=fixture(t);let sent=0
 t.after(installTaskPreamble(f.agent,async()=>{sent++}))
 f.setDriver(async({invoke})=>{await invoke('partner_work_result',{...result,status:'unverified'})})
 assert.equal((await f.invoke('partner_work_execute',{input:'查证'})).isError,true)
 assert.equal(f.requests(),0)
 await f.invoke('partner_chat_progress',{text:'我再查下有没有能接的办法'})
 const output=await f.invoke('partner_work_execute',{input:'查证'})
 assert.equal(output.isError,false);assert.equal(sent,1);assert.equal(f.requests(),1)
})
