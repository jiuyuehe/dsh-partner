import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {installToolDiscovery} from '../lib/collaboration/tool-discovery.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
const tick=()=>new Promise(r=>setImmediate(r))
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}

test('QQ input during silent autonomous work starts an owned reply and delivers preamble, image, and final text',async t=>{
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const session=Session.create('handoff'),sent=[],autonomy=deferred(),started=deferred(),finish=deferred()
 const channel={id:'qq',platform:'qq',accountId:'bot',companionId:'c',enabled:true,direct:{baseUrl:'http://local',targetId:'room'},qq:{identityBinding:{enabled:true,qqIds:['12345678']}}}
 const companion={id:'c',toolDiscovery:true},route={id:'r',kind:'channel',channelId:'qq',userId:'12345678',companionId:'c',sessionId:session.id,qqSessionMode:'separate',inboundMessageIds:['old'],cwd:'/tmp'}
 const state={companions:[companion],channels:[channel],sessions:[route],pairings:[{channelId:'qq',userId:route.userId,status:'approved',directTargetId:'room'}],recentReceipts:[]}
 const store={snapshot:()=>state,subscribe:()=>()=>{},update:async fn=>fn(state),isCompanionRemoving:()=>false}
 const agent={session,status:'running',options:{},steer:()=>assert.fail('autonomous execution must not absorb user input')},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 let work=autonomy.promise.then(()=>{agent.status='idle';session.append('turn/end',{turn:1,reason:{kind:'completed'}})})
 agent.whenIdle=()=>work
 session.append('turn/start',{turn:1})
 session.append('user/message',{...createUserMessage({source:{kind:'user'},content:[{type:'text',text:'old'}]}),id:'old'},{surfaceOp:'append'})
 session.append('user/message',createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE},content:[{type:'text',text:'自主活动'}]}),{surfaceOp:'append'})
 session.append('tool/ptc-dispatch',{name:'partner_activity_finish',isError:false,meta:{kind:'partner-activity-silent-v1'}})
 const ctx={tools:root.tools,on:()=>()=>{},agents:{get:()=>agent},logger:{info:()=>{},warn:()=>{}}}
 const runtime=new PartnerAgentRuntime(ctx,store,'/tmp')
 runtime.ensureSession=async()=>route;runtime.ensureAgent=async()=>agent;runtime.cancelPostReply=async()=>{}
 runtime.persistInbound=async(_route,message)=>({query:message.text,content:[{type:'text',text:message.text}]})
 runtime.replyDelivered=async()=>{}
 t.after(installToolDiscovery(scope.ctx.tools,'c',store,[]))
 const def=(name,execute)=>({name,description:name,parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},execute})
 t.after(scope.ctx.tools.register(def('generate_image',async()=>{sent.push('image generated');return {ok:true}})))
 t.after(scope.ctx.tools.register(def('partner_send_attachment',async()=>{sent.push('image sent');return {ok:true}})))
 let calls=0
 const call=async(name,args={})=>{const request={name,arguments:args,agent,callId:'call-'+calls++,signal:new AbortController().signal};agent.session.append('tool/call',{name,arguments:JSON.stringify(args),callId:request.callId});const result=await root.tools.execute(request);agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{id:request.callId,role:'tool',source:{kind:'tool',callId:request.callId},toolCallId:request.callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'});return result}
 agent.followup=message=>{
  agent.status='running';session.append('turn/start',{turn:2});session.append('user/message',message,{surfaceOp:'append'})
  work=(async()=>{
   assert.equal(runtime.channelReplyOwners.get(session.id),route.id)
   const blocked=await call('generate_image');assert.equal(blocked.isError,true);assert.deepEqual(sent,[])
   const ack=await call('partner_chat_say',{beforeTools:true,expectedTools:['generate_image'],text:'这回我照着原来的样子画张近照，等着看吧。'})
   assert.equal(ack.isError,false);assert.equal(ack.isError,false)
   assert.equal((await call('generate_image')).isError,false)
   assert.equal((await call('partner_send_attachment')).isError,false)
   started.resolve();await finish.promise
   session.append('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'画好啦，看这次的表情。'}]}},{surfaceOp:'append'})
   session.append('turn/end',{turn:2,reason:{kind:'completed'}});agent.status='idle'
  })()
 }
 const manager=new ChannelManager({logger:ctx.logger},store,{},runtime,'/tmp')
 const api={config:channel.direct,sendText:async(_peer,text)=>sent.push(text),progress:()=>undefined}
 const event={id:'request',sender:route.userId,text:'再画一张近照',targetId:'room'}
 const pending=manager.handleDirect(channel,api,event,new AbortController().signal,[event],()=>{},'steer')
 await tick();assert.deepEqual(sent,[])
 autonomy.resolve();await started.promise
 assert.deepEqual(sent,['这回我照着原来的样子画张近照，等着看吧。','image generated','image sent'])
 assert.ok(manager.channelDiagnostics().some(item=>item.phase==='agent-followup-starting'))
 assert.ok(manager.channelDiagnostics().some(item=>item.phase==='agent-followup-submitted'))
 const steered=[]
 agent.steer=message=>{steered.push(message)}
 // 同一个活跃 Agent 可以连续接收多条 Mattermost 风格的插入输入，不等待前一轮结束。
 assert.equal(await runtime.steer(companion,channel.id,route.userId,{text:'背景也保持原样',attachments:[]}),true)
 assert.equal(await runtime.steer(companion,channel.id,route.userId,{text:'最后保留原来的构图',attachments:[]}),true)
 assert.deepEqual(steered.map(message=>message.content[0].text),['背景也保持原样','最后保留原来的构图'])
 finish.resolve();await pending
 assert.ok(manager.channelDiagnostics().some(item=>item.phase==='agent-followup-completed'))
 assert.equal(sent.at(-1),'画好啦，看这次的表情。')
 assert.equal(runtime.channelReplyOwners.size,0)
 assert.equal(scope.ctx.tools.get('partner_chat_progress',agent),undefined)
 assert.equal(scope.ctx.tools.get('partner_chat_say',agent),undefined)
})
