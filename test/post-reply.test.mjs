import test from 'node:test'
import assert from 'node:assert/strict'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { postReplyProbability, postReplyAllowed, activityPolicyCurrent } from '../lib/character/post-reply.js'
import { qqChatOnly } from '../lib/channels/qq/authority.js'
import { currentQqIdentityRelation } from '../lib/channels/qq/identity-binding.js'
import { IDLE_CONTACT_NOTICE } from '../lib/character/idle-contact.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'

function fixture() {
  const companion={id:'c',updatedAt:1,characterCard:{enabled:true},affection:{score:100},idleContact:{enabled:true,routeId:'other',idleMinutes:120}}
  const route={id:'r',companionId:'c',kind:'channel',channelId:'ch',userId:'834426963',sessionId:'s',lastMessageAt:Date.now(),qqSessionMode:'separate'}
  const channel={id:'ch',companionId:'c',enabled:true,platform:'qq',qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['834426963','12345678']}}}
  const state={companions:[companion],sessions:[route],channels:[channel],pairings:[{channelId:'ch',userId:route.userId,status:'approved'}]}
  const events=[{type:'user/message',seq:1,time:Date.now(),data:{id:'u1',source:{kind:'user'}}}]
  const followed=[]
  const agent={status:'idle',session:{id:'s',seq:1,snapshotEvents:()=>events},followup:message=>followed.push(message)}
  const store={snapshot:()=>state,update:async fn=>fn(state),subscribe:()=>()=>{},isCompanionRemoving:()=>false}
  const runtime=new PartnerAgentRuntime({agents:{get:()=>undefined}},store,'/tmp');runtime.ensureAgent=async()=>agent;runtime.isArchived=()=>false
  return {companion,route,channel,state,events,followed,agent,store,runtime,source:{routeId:'r',sessionId:'s',userMessageId:'u1'}}
}
async function hit(f) {
  const random=Math.random;Math.random=()=>0
  try{await f.runtime.replyDelivered(f.source)}finally{Math.random=random}
}
function ready(f){f.route.postReplyOpportunity.dueAt=Date.now()-1}

test('probability increases with affection, capped at 80%; disabling affection retains a baseline',()=>{
  const {companion}=fixture()
  for(const [score,expected] of [[-100,.10],[-50,.275],[0,.45],[20,.52],[60,.66],[100,.8],[1000,.8]]){companion.affection.score=score;assert.ok(Math.abs(postReplyProbability(companion)-expected)<1e-9)}
  companion.characterCard.affectionEnabled=false;assert.equal(postReplyProbability(companion),.45)
})
test('one durable draw after delivered reply; duplicate receipts cannot reroll a miss',async()=>{
  const f=fixture(), random=Math.random;Math.random=()=>.99
  try{await f.runtime.replyDelivered(f.source)}finally{Math.random=random}
  assert.equal(f.route.postReplyOpportunity.status,'missed');await hit(f);assert.equal(f.route.postReplyOpportunity.status,'missed')
  await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('delayed continuation uses original route instead of configured idle destination, once only',async()=>{
  const f=fixture();await hit(f)
  assert.equal(f.route.postReplyOpportunity.status,'pending');await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
  ready(f);await Promise.all([f.runtime.idleContact('c'),f.runtime.idleContact('c')]);assert.equal(f.followed.length,1)
  assert.equal(f.route.idleContactState.kind,'post-reply');assert.match(f.followed[0].content[0].text,/不要凑第二条消息/)
  assert.equal(f.route.postReplyOpportunity.status,'claimed');await f.runtime.idleContact('c');assert.equal(f.followed.length,1)
  assert.equal(activityPolicyCurrent(f.state,f.companion,f.route),true)
})
for(const scenario of ['new input','sleep','unbound','disabled','expired','settings changed','session changed','revoked'])test(`pending continuation cancels for ${scenario}`,async()=>{
  const f=fixture();await hit(f);ready(f)
  if(scenario==='new input')f.events.push({type:'user/message',seq:2,time:Date.now(),data:{id:'u2',source:{kind:'user'}}})
  if(scenario==='sleep')f.companion.sleepState={episode:{wakeAt:Date.now()+60000}}
  if(scenario==='unbound')f.channel.qq.identityBinding.qqIds=[]
  if(scenario==='disabled')f.companion.idleContact.enabled=false
  if(scenario==='affection off')f.companion.characterCard.affectionEnabled=false
  if(scenario==='expired')f.route.postReplyOpportunity.expiresAt=Date.now()-1
  if(scenario==='settings changed')f.companion.updatedAt++
  if(scenario==='session changed')f.route.sessionId='new-session'
  if(scenario==='revoked')f.state.pairings[0].status='blocked'
  await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('busy turn defers within expiry; another message during claim prevents followup',async()=>{
  const f=fixture();await hit(f);ready(f);f.agent.status='running';await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
  f.agent.status='idle';f.store.update=async fn=>{fn(f.state);f.agent.session.seq++}
  await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('stale delivered reply and foreign routes cannot arm a continuation',async()=>{
  const f=fixture();f.source.userMessageId='older';await hit(f);assert.equal(f.route.postReplyOpportunity,undefined)
  f.source.userMessageId='u1';f.route.companionId='foreign';await hit(f);assert.equal(f.route.postReplyOpportunity,undefined)
})
test('owner-only QQ adapter and per-companion cancellation; multiple owners do not create parallel opportunities',async()=>{
  const f=fixture();f.route.userId='99999999';assert.equal(postReplyAllowed(f.state,f.companion,f.route),false)
  f.route.userId='834426963';await hit(f)
  const other={...f.route,id:'other',userId:'12345678',postReplyOpportunity:undefined};f.state.sessions.push(other)
  f.state.pairings.push({channelId:'ch',userId:'12345678',status:'approved'})
  f.source.routeId='other';await hit(f);assert.equal(f.route.postReplyOpportunity.status,'cancelled');assert.equal(other.postReplyOpportunity.status,'pending')
  f.state.sessions.push({...f.route,id:'foreign',companionId:'different',postReplyOpportunity:{...other.postReplyOpportunity}})
  await f.runtime.cancelPostReply('c');assert.equal(other.postReplyOpportunity.status,'cancelled');assert.equal(f.state.sessions.at(-1).postReplyOpportunity.status,'pending')
})
test('claimed continuation loses private capabilities immediately after owner revocation or new input',async()=>{
  const f=fixture();await hit(f);ready(f);await f.runtime.idleContact('c')
  f.events.push({type:'user/message',seq:2,data:f.followed[0]})
  assert.equal(qqChatOnly(f.agent,f.state),false)
  f.channel.qq.identityBinding.qqIds=[];assert.equal(qqChatOnly(f.agent,f.state),true)
  f.channel.qq.identityBinding.qqIds=['834426963'];await f.runtime.cancelPostReply('c');assert.equal(qqChatOnly(f.agent,f.state),true)
})
test('owner-addressed group continuation retains correct relation; idle group work stays unbound',()=>{
  const f=fixture();f.route.userId='group:493531768:834426963'
  f.route.idleContactState={kind:'post-reply',messageId:'notice'}
  const events=[{type:'user/message',data:{id:'notice',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}]
  assert.equal(currentQqIdentityRelation('s',events,[f.route],[f.channel]).matched,true)
  delete f.route.idleContactState.kind
  assert.equal(currentQqIdentityRelation('s',events,[f.route],[f.channel]).matched,false)
})
test('opportunity and consumed state survive store reopen',async t=>{
  const root=await mkdtemp(join(tmpdir(),'post-reply-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=await PartnerStore.open(join(root,'state.json'));const f=fixture();await hit(f)
  await store.update(s=>{s.sessions=[f.route]})
  const reopened=await PartnerStore.open(join(root,'state.json'));assert.deepEqual(reopened.snapshot().sessions[0].postReplyOpportunity,f.route.postReplyOpportunity)
})
test('a newer input on another session does not suppress this session opportunity',async()=>{
  const f=fixture();f.state.sessions.push({...f.route,id:'r2',sessionId:'s2'})
  await f.runtime.observeSessionEvent({id:'s2'},{type:'user/message',data:{id:'newer',source:{kind:'user'}}})
  await hit(f);assert.equal(f.route.postReplyOpportunity.status,'pending')
})
test('browser input leaves claimed work on an independent session intact',async()=>{
  const f=fixture();await hit(f);ready(f);await f.runtime.idleContact('c')
  f.state.sessions.push({...f.route,id:'local',kind:'local',sessionId:'local-s',postReplyOpportunity:undefined})
  await f.runtime.observeSessionEvent({id:'local-s'},{type:'user/message',data:{id:'browser',source:{kind:'user'}}})
  assert.equal(f.route.postReplyOpportunity.status,'claimed')
})

test('affection disabled still permits a continuation',async()=>{const f=fixture();f.companion.characterCard.affectionEnabled=false;await hit(f);assert.equal(f.route.postReplyOpportunity.probability,.45);ready(f);await f.runtime.idleContact('c');assert.equal(f.followed.length,1)})

test('new input on the same session cancels a claimed opportunity',async()=>{
 const f=fixture();await hit(f);ready(f);await f.runtime.idleContact('c')
 await f.runtime.observeSessionEvent({id:'s'},{type:'user/message',data:{id:'new',source:{kind:'user'}}})
 assert.equal(f.route.postReplyOpportunity.status,'cancelled')
})

async function completed(f,work=true){
 await hit(f);ready(f);await f.runtime.idleContact('c')
 f.events.push({type:'turn/start',seq:2,time:Date.now()-30000,data:{turn:1}},{type:'user/message',seq:3,time:Date.now()-30000,data:f.followed[0]})
 if(work)f.events.push({type:'tool/ptc-dispatch',seq:4,time:Date.now()-20000,data:{name:'partner_qq',arguments:JSON.stringify({action:'call',operation:'fetch_custom_face_detail'}),isError:false}})
 f.events.push({type:'tool/ptc-dispatch',seq:5,time:Date.now()-20000,data:{name:'partner_activity_finish',isError:false,meta:{kind:'partner-activity-silent-v1'}}},{type:'turn/end',seq:6,time:Date.now()-20000,data:{turn:1,reason:{kind:'completed'}}})
 f.agent.session.seq=6
}
async function chain(f){const random=Math.random;Math.random=()=>0;try{await f.runtime.continueCompletedActivity('c')}finally{Math.random=random}}
test('completed silent activity with actual work gets one persisted decayed draw',async()=>{
 const f=fixture();await completed(f);await chain(f)
 assert.equal(f.route.postReplyOpportunity.depth,1);assert.equal(f.route.postReplyOpportunity.probability,.4)
 assert.equal(f.route.postReplyOpportunity.status,'pending');const saved=structuredClone(f.route.postReplyOpportunity)
 await chain(f);assert.deepEqual(f.route.postReplyOpportunity,saved)
 ready(f);await f.runtime.idleContact('c');assert.equal(f.followed.length,2);assert.equal(f.route.idleContactState.depth,1)
})
test('rest-only activity stops; continued chains decay and misses never reroll',async()=>{
 const f=fixture();await completed(f,false);await chain(f);assert.equal(f.route.postReplyOpportunity.status,'claimed');assert.equal(f.route.idleContactState.continuationChecked,true)
 const g=fixture();await completed(g);g.route.idleContactState.depth=4;await chain(g);assert.equal(g.route.postReplyOpportunity.probability,.8*0.5**5);assert.equal(g.route.postReplyOpportunity.status,'pending')
 const h=fixture();await completed(h);const random=Math.random;Math.random=()=>.99;try{await h.runtime.continueCompletedActivity('c')}finally{Math.random=random}
 assert.equal(h.route.postReplyOpportunity.status,'missed');await chain(h);assert.equal(h.route.postReplyOpportunity.status,'missed')
})
test('new input, unsettled delivery and interrupted turns cannot start another action',async()=>{
 for(const scenario of ['new','delivery','interrupted','sleep','revoked']){
  const f=fixture();await completed(f)
  if(scenario==='new')f.events.push({type:'user/message',seq:7,data:{id:'u2',source:{kind:'user'}}})
  if(scenario==='delivery')f.state.notificationDeliveries=[{reply:{idleContactOrigin:{messageId:f.followed[0].id}}}]
  if(scenario==='interrupted')f.events.at(-1).data.reason.kind='interrupted'
  if(scenario==='sleep')f.companion.sleepState={episode:{wakeAt:Date.now()+60000}}
  if(scenario==='revoked')f.channel.qq.identityBinding.qqIds=[]
  await chain(f);assert.notEqual(f.route.postReplyOpportunity.status,'pending',scenario)
 }
})

test('sleep permits only claimed activity cleanup; new input and revocation still deny it',async()=>{
 const {qqToolAccessAdapter}=await import('../lib/channels/qq/authority.js')
 const {idleActivityFinishTool}=await import('../lib/character/activity-tool.js')
 const f=fixture();await hit(f);ready(f);await f.runtime.idleContact('c')
 f.events.push({type:'turn/start',seq:2},{type:'user/message',seq:3,data:f.followed[0]})
 f.companion.sleepState={episode:{wakeAt:Date.now()+60000}}
 const access=()=>qqToolAccessAdapter.resolve({agent:f.agent,state:f.state,events:f.events})
 assert.equal(qqChatOnly(f.agent,f.state),true)
 assert.ok(access().allowedTools.includes('partner_activity_finish'))
 assert.ok(!access().allowedTools.includes('partner_sleep'))
 let ended=false
 const tool=idleActivityFinishTool('c',f.store)
 const exec={agent:f.agent,signal:new AbortController().signal,concludeTurn:()=>ended=true}
 await tool.execute({reason:'安静休息'},exec);assert.equal(ended,true)
 f.channel.qq.identityBinding.qqIds=[]
 assert.ok(!access().allowedTools.includes('partner_activity_finish'))
 await assert.rejects(tool.execute({reason:'休息'},exec),/不能忽略/)
 f.channel.qq.identityBinding.qqIds=['834426963']
 f.events.push({type:'user/message',seq:4,data:{id:'new',source:{kind:'user'}}})
 await assert.rejects(tool.execute({reason:'休息'},exec),/不能忽略/)
})

test('post-reply uses recent user and own reply without idle exploration or silence-history priming',async()=>{
  const f=fixture()
  f.events[0].data.content=[{type:'text',text:'那个双人关卡挺有意思'}]
  f.events.push({type:'tool/result',seq:2,time:Date.now(),data:{message:{isError:false},meta:{kind:'partner-chat-v1',parts:[{type:'text',text:'我看怪物，你认路'}]}}})
  f.events.push({type:'tool/ptc-dispatch',seq:3,time:Date.now(),data:{isError:false,meta:{kind:'partner-activity-silent-v1',reason:'旧活动只整理收藏'}}})
  await hit(f);ready(f);await f.runtime.idleContact('c')
  const text=f.followed[0].content[0].text
  assert.ok(text.startsWith('这是回复或自主活动完成后的「主动延续」机会'))
  for(const part of ['那个双人关卡挺有意思','我看怪物，你认路','partner_chat_reply','partner_activity_finish','此前未完成、失败或状态不明','执行时仍检查实时权限'])assert.ok(text.includes(part),part)
  assert.ok(!text.includes('闲下来时优先找一件'));assert.ok(!text.includes('旧活动只整理收藏'))
})
