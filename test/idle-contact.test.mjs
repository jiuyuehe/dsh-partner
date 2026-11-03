import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DEFAULT_IDLE_CONTACT,IDLE_CONTACT_NOTICE,normalizeIdleContact,idleActivityProbability,idleContactDue,idleContactDay,idleContactQuiet,lastIdleContactUser,idleActivityPrompt} from '../lib/character/idle-contact.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {PartnerStore} from '../lib/store.js'
import {HeartbeatScheduler} from '../lib/heartbeat.js'

const now=Date.parse('2026-10-28T06:00:00Z'),tz='Asia/Shanghai'
const user={id:'user-1',at:now-3*3600_000}
function fixture(){
  const companion={id:'c',updatedAt:1,idleContact:{...DEFAULT_IDLE_CONTACT,enabled:true,routeId:'r'},automation:{heartbeat:{enabled:false}}}
  const route={id:'r',kind:'channel',channelId:'ch',userId:'peer',companionId:'c',sessionId:'s',lastMessageAt:user.at}
  const state={companions:[companion],sessions:[route],channels:[{id:'ch',companionId:'c',enabled:true}],pairings:[{channelId:'ch',userId:'peer',status:'approved'}],heartbeatStates:[],recentReceipts:[]}
  return {companion,route,state}
}
test('defaults opt out, strict input and legacy quiet hours no longer apply',()=>{
  assert.equal(DEFAULT_IDLE_CONTACT.enabled,false)
  for(const bad of [{...DEFAULT_IDLE_CONTACT,enabled:true},{...DEFAULT_IDLE_CONTACT,idleMinutes:0}])assert.throws(()=>normalizeIdleContact(bad))
  assert.equal(idleContactQuiet(DEFAULT_IDLE_CONTACT,Date.parse('2026-10-28T16:00:00Z'),tz),false)
  assert.equal(idleContactQuiet(DEFAULT_IDLE_CONTACT,Date.parse('2026-10-28T01:00:00Z'),tz),false)
  assert.equal(idleContactQuiet({...DEFAULT_IDLE_CONTACT,quietStartHour:9,quietEndHour:17},now,tz),false)
  assert.equal(idleContactQuiet({...DEFAULT_IDLE_CONTACT,quietStartHour:9,quietEndHour:9},now,tz),false)
})
test('only real user inactivity qualifies; deny recent activity, unauthorized targets and foreign owners',()=>{
  const {state,companion,route}=fixture()
  assert.equal(idleContactDue(state,companion,user,now,tz),true)
  assert.equal(idleContactDue(state,companion,undefined,now,tz),false)
  route.lastMessageAt=now;assert.equal(idleContactDue(state,companion,user,now,tz),false);route.lastMessageAt=user.at
  state.pairings[0].status='blocked';assert.equal(idleContactDue(state,companion,user,now,tz),false);state.pairings[0].status='approved'
  state.channels[0].companionId='other';assert.equal(idleContactDue(state,companion,user,now,tz),false)
  assert.deepEqual(lastIdleContactUser([{type:'user/message',time:123,data:{id:'real',source:{kind:'user'}}},{type:'user/message',time:456,data:{id:'internal',source:{kind:'plugin:task'}}}]),{id:'real',at:123})
})
test('autonomous decisions can resume without a new reply; no daily cap and cooldown spans routes',()=>{
  const {state,companion,route}=fixture()
  route.idleContactState={userMessageId:user.id,attemptedAt:now-3*3600_000,day:idleContactDay(now,tz),count:1}
  assert.equal(idleContactDue(state,companion,user,now+86400_000,tz),true)
  assert.equal(idleContactDue(state,companion,{...user,id:'new'},now,tz),true)
  state.sessions.push({...route,id:'r2',idleContactState:{...route.idleContactState,count:999}})
  companion.idleContact.dailyLimit=1 // Legacy stored limits no longer restrict sending.
  assert.equal(idleContactDue(state,companion,{...user,id:'new'},now,tz),true)
  state.sessions.pop();route.idleContactState.attemptedAt=now-59_000
  assert.equal(idleContactDue(state,companion,{...user,id:'new'},now,tz),false)
})
function runtimeFixture(){
  const {state,companion,route}=fixture();companion.idleContact.quietStartHour=0;companion.idleContact.quietEndHour=0
  const events=[{type:'user/message',seq:1,time:Date.now()-4*3600_000,data:{id:user.id,source:{kind:'user'}}}]
  const followed=[]
  const agent={status:'idle',session:{seq:1,snapshotEvents:()=>events},followup:m=>followed.push(m)}
  const store={subscribe:()=>()=>{},snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)}
  const runtime=new PartnerAgentRuntime({agents:{get:()=>undefined}},store,'/tmp')
  runtime.ensureAgent=async()=>agent;runtime.isArchived=()=>false
  return {runtime,store,agent,events,followed,state,companion,route}
}
test('idle capability hints include only enabled operations on this companion enabled QQ channels',()=>{
  const {state,companion}=fixture()
  const qq={autonomousActions:true,enabledActions:['get_qzone_feeds','send_qzone_msg','unknown_action'],privateReplies:true,groupReplies:false}
  const channel={id:'qq',companionId:'c',platform:'qq',enabled:true,qq}
  state.channels.push(channel,{...channel,id:'foreign',companionId:'other'},{...channel,id:'disabled',enabled:false},{...channel,id:'off',qq:{...qq,autonomousActions:false}})
  const before=structuredClone(state)
  const hints=JSON.parse(idleActivityPrompt(state,companion).split('：').at(-1))
  assert.deepEqual(hints,[{channelId:'qq',categories:[{id:'space',title:'QQ 空间'}],operations:['get_qzone_feeds','send_qzone_msg']}])
  assert.deepEqual(state,before)
  channel.qq={...qq,enabledActions:[]}
  assert.deepEqual(JSON.parse(idleActivityPrompt(state,companion).split('：').at(-1)),[])
})
test('autonomous followup carries current capability hints and reflects revocation next time',async()=>{
  const f=runtimeFixture()
  const channel={id:'qq',companionId:'c',platform:'qq',enabled:true,qq:{autonomousActions:true,enabledActions:['send_qzone_msg'],privateReplies:true,groupReplies:false}}
  f.state.channels.push(channel)
  await f.runtime.idleContact('c')
  assert.equal(f.followed.length,1)
  assert.match(f.followed[0].content[0].text,/"operations":\["send_qzone_msg"\]/)
  channel.qq.autonomousActions=false
  delete f.route.idleActivityCheck;delete f.route.idleContactState
  await f.runtime.idleContact('c')
  assert.equal(f.followed.length,2)
  assert.ok(f.followed[1].content[0].text.endsWith('[]'))
})
test('claims before followup; concurrent checks and restart cannot repeat an uncertain attempt',async()=>{
  const f=runtimeFixture()
  await Promise.all([f.runtime.idleContact('c'),f.runtime.idleContact('c')])
  assert.equal(f.followed.length,1);assert.equal(f.followed[0].source.summary,IDLE_CONTACT_NOTICE)
  assert.notEqual(f.followed[0].source.kind,'user')
  assert.equal(f.route.idleContactState.messageId,f.followed[0].id)
  const restarted=new PartnerAgentRuntime({agents:{get:()=>undefined}},f.store,'/tmp');restarted.ensureAgent=async()=>f.agent;restarted.isArchived=()=>false
  await restarted.idleContact('c');assert.equal(f.followed.length,1)
})
test('busy conversation and input arriving during durable claim do not start a greeting',async()=>{
  const f=runtimeFixture();f.agent.status='running';await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
  f.agent.status='idle';f.store.update=async fn=>{fn(f.state);f.agent.session.seq++}
  await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('claim survives disk reopening',async t=>{
  const root=await mkdtemp(join(tmpdir(),'partner-idle-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=await PartnerStore.open(join(root,'state.json')),f=fixture()
  await store.update(s=>{s.sessions=[{...f.route,idleActivityCheck:{at:now,probability:0.5},idleContactState:{userMessageId:'u',messageId:'m',attemptedAt:now,day:idleContactDay(now,tz),count:1,timeZone:tz,policyRevision:1}}]})
  const reopened=await PartnerStore.open(join(root,'state.json'))
  assert.equal(reopened.snapshot().sessions[0].idleContactState.messageId,'m')
  assert.deepEqual(reopened.snapshot().sessions[0].idleActivityCheck,{at:now,probability:0.5})
})
test('existing heartbeat timer checks idle contact even when concerns heartbeat is disabled',async()=>{
  const f=fixture();let calls=0
  const scheduler=new HeartbeatScheduler({logger:{warn:()=>{}}},{snapshot:()=>f.state},{idleContact:async()=>calls++},{},{})
  await scheduler.tick();await new Promise(r=>setImmediate(r));assert.equal(calls,1);await scheduler.close()
})
function deliveryFixture(){
  const f=fixture(),messageId='idle-1';f.companion.idleContact.quietStartHour=0;f.companion.idleContact.quietEndHour=0
  f.route.idleContactState={userMessageId:user.id,messageId,attemptedAt:now,day:idleContactDay(now,tz),count:1,timeZone:tz,policyRevision:1}
  const events=[{type:'user/message',seq:0,time:user.at,data:{id:user.id,source:{kind:'user'}}},{type:'turn/start',seq:1,data:{turn:1}},{type:'user/message',seq:2,data:{id:messageId,source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}},{type:'assistant/message',seq:3,data:{message:{content:[{type:'text',text:'刚想起你说的那个事。'}]}}},{type:'turn/end',seq:4,data:{turn:1,reason:{kind:'completed'}}}]
  const manager=new ChannelManager({}, {snapshot:()=>f.state,isCompanionRemoving:()=>false}, {},{isArchived:()=>false},'/tmp'), sent=[]
  manager.queueProactive=async(route,receipt,reply,valid,exact)=>{if(valid())sent.push({route,receipt,reply,exact})}
  return {...f,events,manager,sent,session:{id:'s',snapshotEvents:()=>events},end:events.at(-1)}
}
test('native completed reply delivers once to explicit origin, not notification broadcasts',async()=>{
  const f=deliveryFixture();await f.manager.observeAutonomousResult(f.session,f.end)
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].exact,true);assert.equal(f.sent[0].route.id,'r');assert.equal(f.sent[0].receipt,'idle:idle-1');assert.match(f.sent[0].reply.text,/刚想起/)
})
for(const scenario of ['disabled','revoked','new input','changed setting','local'])test(`idle delivery is suppressed for ${scenario}`,async()=>{
  const f=deliveryFixture()
  if(scenario==='disabled')f.companion.idleContact.enabled=false
  if(scenario==='revoked')f.state.pairings[0].status='blocked'
  if(scenario==='changed setting')f.companion.updatedAt++
  if(scenario==='local')f.route.kind='local'
  if(scenario==='new input')f.events.push({type:'user/message',seq:5,time:now,data:{id:'new',source:{kind:'user'}}})
  await f.manager.observeAutonomousResult(f.session,f.end);assert.equal(f.sent.length,0)
})

test('idle contact never starves concern continuations when both features are enabled',async()=>{
  const f=fixture();f.companion.automation.heartbeat.enabled=true
  f.state.heartbeatStates=[{companionId:'c',nextCheckAt:Date.now()+3600_000}]
  const calls=[]
  const scheduler=new HeartbeatScheduler({logger:{warn:()=>{}}},{snapshot:()=>f.state},{idleContact:async()=>calls.push('idle')},{},{pendingRecording:async()=>undefined})
  scheduler.setExecutionDispatcher(async()=>calls.push('work'))
  await scheduler.tick();await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['work','idle']);await scheduler.close()
})


test('legacy quiet hours are discarded; sleep controls actual channel delivery without daily caps',async()=>{
  assert.equal(normalizeIdleContact({...DEFAULT_IDLE_CONTACT,quietEnabled:true,quietStartHour:23,quietEndHour:9}).quietEnabled,undefined)
  const f=deliveryFixture()
  f.companion.sleepPolicy={enabled:true,dreamsEnabled:true}
  f.companion.sleepState={episode:{id:'sleep',startedAt:Date.now(),wakeAt:Date.now()+60000,routeId:'r',dream:'skipped'}}
  f.route.idleContactState.count=999
  await f.manager.observeAutonomousResult(f.session,f.end);assert.equal(f.sent.length,0)
  f.companion.sleepState.episode.wokeAt=Date.now()
  await f.manager.observeAutonomousResult(f.session,f.end);assert.equal(f.sent.length,1)
})

test('idle generation reconciles QQ main-session selection before reading conversation history',async()=>{
 const f=runtimeFixture();f.state.channels[0].platform='qq';f.state.channels[0].qq={mainSessionPeers:['private:12345678']}
 f.route.userId='12345678';f.state.pairings[0].userId='12345678';f.route.qqSessionMode='separate'
 const calls=[]
 f.runtime.ensureSession=async(c,ch,peer)=>{calls.push('reconcile');assert.equal(peer,'12345678');f.route.sessionId='main';f.route.qqSessionMode='main';return f.route}
 f.runtime.ensureAgent=async(c,r)=>{calls.push(r.sessionId);return f.agent}
 await f.runtime.idleContact('c');assert.deepEqual(calls,['reconcile','main']);assert.equal(f.followed.length,1)
})

function recoveryFixture(){
 const f=deliveryFixture(),origin={routeId:'r',sessionId:'s',messageId:'idle-1',userMessageId:user.id,policyRevision:1}
 const record={id:JSON.stringify(['c','idle:idle-1']),companionId:'c',createdAt:Date.now()-60000,reply:{text:'刚想起你说的那个事。',attachments:[],idleContactOrigin:origin},targets:[{channelId:'ch',userId:'peer',sentParts:[],lastAttemptAt:Date.now()-60000,retrySafe:true}]}
 f.state.notificationDeliveries=[record];f.manager.runtime.set('ch',{status:'running'})
 f.manager.agents.idleContactDeliveryCurrent=async()=>true
 f.manager.queueProactive=async(route,receipt,reply,valid,exact)=>{assert.equal(exact,true);assert.equal(reply.text,record.reply.text);f.sent.push(receipt)}
 return {...f,record}
}
test('idle recovery resends a known-unsent frozen reply to the original recipient only',async()=>{
 const f=recoveryFixture();await f.manager.recoverIdleReplies();assert.deepEqual(f.sent,['idle:idle-1'])
})
for(const mode of ['legacy','uncertain','expired','offline','new input','rerouted','completed'])test(`idle recovery never replays ${mode} notifications`,async()=>{
 const f=recoveryFixture()
 if(mode==='legacy')delete f.record.reply.idleContactOrigin
 if(mode==='uncertain')delete f.record.targets[0].retrySafe
 if(mode==='expired')f.record.createdAt=Date.now()-3600001
 if(mode==='offline')f.manager.runtime.set('ch',{status:'starting'})
 if(mode==='new input')f.manager.agents.idleContactDeliveryCurrent=async()=>false
 if(mode==='rerouted')f.route.userId='someone-else'
 if(mode==='completed')f.record.completedAt=Date.now()
 await f.manager.recoverIdleReplies();assert.equal(f.sent.length,0)
})
test('idle recovery validity requires unchanged settings and the same last real user message',async()=>{
 const f=runtimeFixture(),origin={routeId:'r',sessionId:'s',messageId:'idle-1',userMessageId:user.id,policyRevision:1}
 f.route.idleContactState={messageId:'idle-1'}
 assert.equal(await f.runtime.idleContactDeliveryCurrent(origin),true)
 f.events.push({type:'user/message',seq:2,time:Date.now(),data:{id:'new-input',source:{kind:'user'}}})
 assert.equal(await f.runtime.idleContactDeliveryCurrent(origin),false)
 f.events.pop();f.companion.updatedAt++
 assert.equal(await f.runtime.idleContactDeliveryCurrent(origin),false)
})

test('offline QQ proactive delivery is persisted as unsent before attempting to obtain a sender',async()=>{
 const f=recoveryFixture();delete f.state.notificationDeliveries
 f.state.channels[0].platform='qq';f.manager.runtime.set('ch',{status:'starting'})
 f.manager.store.update=async fn=>{fn(f.state);return f.state}
 f.manager.credentials.read=async()=>({baseUrl:'ws://localhost:3001',botToken:'test'})
 f.manager.sender=()=>assert.fail('Offline QQ must not start a send')
 await assert.rejects(f.manager.sendProactiveReply('ch','peer',f.record.reply,'idle:idle-1','c',true))
 const saved=f.state.notificationDeliveries[0]
 assert.equal(saved.targets[0].retrySafe,true);assert.deepEqual(saved.targets[0].sentParts,[])
 assert.equal(saved.reply.text,f.record.reply.text)
})


test('idle wake uses the configured interval, with no minute lottery',()=>{
 const {state,companion,route}=fixture();companion.idleContact.idleMinutes=60
 route.lastMessageAt=now;const fresh={id:'fresh',at:now}
 for(const [minute,chance] of [[0,0],[0.9,0],[1,0],[30,0],[60,1],[120,1]])assert.equal(idleActivityProbability(state,companion,fresh,now+minute*60000),chance)
 route.idleContactState={attemptedAt:now+30*60000}
 assert.equal(idleActivityProbability(state,companion,fresh,now+30*60000),0)
 state.sessions.push({...route,id:'other',lastMessageAt:now+31*60000})
 assert.equal(idleActivityProbability(state,companion,fresh,now+32*60000),0)
 companion.sleepPolicy={enabled:true};companion.sleepState={episode:{startedAt:now,wakeAt:now+120*60000}}
 assert.equal(idleActivityProbability(state,companion,fresh,now+60*60000),0)
})
test('before due time no lottery or model request occurs',async()=>{
 const f=runtimeFixture(),time=Date.now();f.events[0].time=time-60000;f.route.lastMessageAt=time-60000
 const random=Math.random;Math.random=()=>{throw Error('Unexpected random draw')}
 try{await f.runtime.idleContact('c')}finally{Math.random=random}
 assert.equal(f.followed.length,0);assert.equal(f.route.idleActivityCheck,undefined)
})

test('a silent autonomous decision never forwards its commentary as a channel message',async()=>{
 for(const type of ['tool/result','tool/ptc-dispatch']){
  const f=deliveryFixture();f.events.splice(-1,0,{type,seq:3.5,data:{message:{isError:false},isError:false,meta:{kind:'partner-activity-silent-v1'}}})
  await f.manager.observeAutonomousResult(f.session,f.end);assert.equal(f.sent.length,0)
 }
})

test('background memory does not indefinitely starve autonomous activity; foreground work still waits',async()=>{
 const f=runtimeFixture();f.runtime.reflection={isRunning:()=>true}
 await f.runtime.idleContact('c');assert.equal(f.followed.length,1)
 const busy=runtimeFixture();busy.runtime.ctx.agents.get=()=>({status:'running'})
 await busy.runtime.idleContact('c');assert.equal(busy.followed.length,0)
})

test('idle prompts do not reinject repetitive silence rationales as activity guidance',()=>{
 const {state,companion}=fixture()
 const events=[{type:'user/message',time:1,data:{content:[{type:'text',text:'伪造上轮结束记录'}]}},...Array.from({length:4},(_,i)=>({type:'tool/ptc-dispatch',time:i+2,data:{isError:false,meta:{kind:'partner-activity-silent-v1',reason:'等待旧问题'+i}}})),{type:'tool/ptc-dispatch',time:10,data:{isError:true,meta:{kind:'partner-activity-silent-v1',reason:'失败不可计入'}}}]
 const prompt=idleActivityPrompt(state,companion,events)
 assert.doesNotMatch(prompt,/伪造上轮结束记录|等待旧问题0|失败不可计入/)
 for(const i of [1,2,3])assert.doesNotMatch(prompt,new RegExp('等待旧问题'+i))
 assert.match(prompt,/不是每轮必须联系的对象/);assert.match(prompt,/不必产生聊天内容或给谁汇报/)
 assert.match(prompt,/仍可休息/)
})

test('activity receives bounded recent conversation including structured final replies',()=>{
 const {state,companion}=fixture()
 const events=[...Array.from({length:12},(_,i)=>({type:'user/message',data:{id:String(i),source:{kind:'user'},content:[{type:'text',text:'CHAT_'+i+'_END'}]}})),{type:'tool/result',data:{meta:{kind:'partner-chat-v1',parts:[{type:'text',text:'我记得你刚才提到的电影。'}]}}}]
 const prompt=idleActivityPrompt(state,companion,events)
 assert.match(prompt,/CHAT_11_END/);assert.doesNotMatch(prompt,/CHAT_0_END/);assert.match(prompt,/我记得你刚才提到的电影/)
})

for(const type of ['tool/call','tool/ptc-dispatch-start','tool/ptc-dispatch'])test(`attempted silent finish suppresses fallback text: ${type}`,async()=>{
 const f=deliveryFixture();f.events.splice(-1,0,{type,seq:3.5,data:{name:'partner_activity_finish',isError:true}})
 await f.manager.observeAutonomousResult(f.session,f.end);assert.equal(f.sent.length,0)
})
test('unrelated tool failure and quoted silence tool name do not suppress a reply',async()=>{
 const f=deliveryFixture();f.events[3].data.message.content[0].text='partner_activity_finish';f.events.splice(-1,0,{type:'tool/ptc-dispatch',seq:3.5,data:{name:'other_tool',isError:true}})
 await f.manager.observeAutonomousResult(f.session,f.end);assert.equal(f.sent.length,1)
})
test('restart recovery respects silence in the exact autonomous turn',async()=>{
 const f=runtimeFixture(),origin={routeId:'r',sessionId:'s',messageId:'idle-1',userMessageId:user.id,policyRevision:1}
 f.route.idleContactState={messageId:'idle-1'}
 f.events.push({type:'turn/start',seq:2},{type:'user/message',seq:3,data:{id:'idle-1',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}},{type:'tool/ptc-dispatch',seq:4,data:{name:'partner_activity_finish',isError:true}},{type:'turn/end',seq:5})
 assert.equal(await f.runtime.idleContactDeliveryCurrent(origin),false)
 f.events[2].data.id='other-idle'
 assert.equal(await f.runtime.idleContactDeliveryCurrent(origin),true)
})

test('idle plain final paragraphs become bubbles only with segmentation enabled',async()=>{
 const text='忽然想了个双人关卡 一个人只能看见路 另一个只能看见怪物\n\n感觉还没走两步 就要喊“不是那边啊！”了 😂'
 for(const enabled of [true,false]){
  const f=deliveryFixture();f.companion.characterCard={enabled:true,segmentedReplies:enabled}
  f.events[3].data.message.content=[{type:'text',text}]
  await f.manager.observeAutonomousResult(f.session,f.end)
  assert.equal(f.sent.length,1)
  assert.equal(f.sent[0].reply.text,text)
  assert.deepEqual(f.sent[0].reply.chatParts,enabled?text.split('\n\n').map(text=>({type:'text',text})):undefined)
 }
})

test('idle continuation keeps user and own reply anchors when autonomous chatter fills the tail',async()=>{
 const {activityConversation}=await import('../lib/character/idle-contact.js')
 const user=text=>({type:'user/message',time:10,data:{source:{kind:'user'},content:[{type:'text',text}]}})
 const answer=text=>({type:'tool/result',time:20,data:{meta:{kind:'partner-chat-v1',parts:[{type:'text',text}]}}})
 const events=[user('我只能看见路，你只能看见怪物'),answer('那我给你报怪物的位置'),...Array.from({length:20},(_,i)=>answer('自主消息'+i))]
 const before=structuredClone(events),context=activityConversation(events)
 assert.ok(context.length<=14)
 assert.ok(context.some(x=>x.role==='user'&&x.text==='我只能看见路，你只能看见怪物'))
 assert.ok(context.some(x=>x.role==='assistant'&&x.text==='那我给你报怪物的位置'))
 assert.equal(context.at(-1).text,'自主消息19')
 assert.equal(context[0].at,10);assert.deepEqual(events,before)
 const {state,companion}=fixture(),prompt=idleActivityPrompt(state,companion,events)
 assert.match(prompt,/决定想探索什么/)
 assert.match(prompt,/partner_memory_recall/)
 assert.doesNotMatch(prompt,/闲下来时优先找一件|只有没有合适行动/)
})

test('activity context retains media-only replies and compact sticker identities without transport data',async()=>{
 const {activityConversation,activityRecentMedia}=await import('../lib/character/idle-contact.js')
 const emoji={provider:'qq-custom',id:'detective-pika',channelId:'ch',accountId:'account',label:'侦探皮卡丘 疑惑',previewUrl:'https://p.qpic.cn/private-preview'}
 const events=[{type:'tool/result',time:1,data:{message:{isError:false},meta:{kind:'partner-chat-v1',parts:[{type:'emoji',emoji}]}}},
 {type:'tool/result',time:2,data:{message:{isError:false},meta:{kind:'partner-chat-v1',parts:[{type:'image',attachment:{kind:'image',path:'/private/file.png'},url:'/private/url',label:'趴着的猫'}]}}}]
 const before=structuredClone(events),context=activityConversation(events)
 assert.equal(context.length,2)
 assert.deepEqual(context[0].media,[{kind:'emoji',provider:'qq-custom',id:'detective-pika',label:'侦探皮卡丘 疑惑'}])
 assert.deepEqual(context[1].media,[{kind:'image',label:'趴着的猫'}])
 const recent=activityRecentMedia(events)
 assert.deepEqual(recent,context)
 assert.doesNotMatch(JSON.stringify(recent),/private-preview|private\/file|private\/url|accountId|channelId/)
 assert.deepEqual(events,before)
})
test('idle and post-reply reminders preserve bounded older media outside the text window, excluding failures',async()=>{
 const {activityRecentMedia}=await import('../lib/character/idle-contact.js')
 const {postReplyActivityPrompt}=await import('../lib/character/post-reply.js')
 const event=(id,isError=false)=>({type:'tool/ptc-dispatch',time:1,data:{isError,meta:{kind:'partner-chat-v1',parts:[{type:'text',text:'旧配文'+id},{type:'emoji',emoji:{provider:'qq-custom',id,channelId:'ch',accountId:'a',label:'表情'+id}}]}}})
 const events=[...Array.from({length:8},(_,i)=>event(String(i))),event('failed',true),...Array.from({length:20},()=>({type:'assistant/message',data:{message:{content:[{type:'text',text:'后来聊了别的话'}]}}}))]
 assert.deepEqual(activityRecentMedia(events).map(x=>x.media[0].id),['2','3','4','5','6','7'])
 const {state,companion}=fixture()
 for(const render of [idleActivityPrompt,postReplyActivityPrompt]){
  const prompt=render(state,companion,events)
  assert.match(prompt,/旧配文2/);assert.match(prompt,/旧配文7/);assert.doesNotMatch(prompt,/旧配文0|旧配文failed/)
  assert.match(prompt,/提交记录不等于送达证明/)
 }
})

test('autonomy discovers expandable abilities without a compulsory social output or operation list',()=>{
 const {state,companion}=fixture(),events=[]
 const before=JSON.stringify(state),prompt=idleActivityPrompt(state,companion,events)
 assert.match(prompt,/只挂起对应事项/);assert.match(prompt,/明确要求停止全部活动时遵守/);
 assert.match(prompt,/自由活动时间/);assert.match(prompt,/先看看当前可用能力/)
 assert.match(prompt,/partner_channel_access/);assert.match(prompt,/partner_tools list\/describe/)
 assert.match(prompt,/其他插件使用各自已提供的入口/)
 assert.match(prompt,/新增加的公开或私有能力/)
 assert.match(prompt,/目录和配置摘要不代表扩大权限/)
 assert.match(prompt,/分享、发动态、发消息是活动中自然产生的选择/)
 assert.match(prompt,/用户的新消息优先/)
 assert.equal(JSON.stringify(state),before)
})
