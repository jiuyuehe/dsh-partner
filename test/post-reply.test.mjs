import {planActivity,activityPlanCurrent} from '../lib/character/activity-plan.js'
import {thoughtTool} from '../lib/character/thought-tool.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { postReplyAllowed, activityPolicyCurrent } from '../lib/character/post-reply.js'
import { qqChatOnly } from '../lib/channels/qq/authority.js'
import { currentQqIdentityRelation } from '../lib/channels/qq/identity-binding.js'
import { IDLE_CONTACT_NOTICE } from '../lib/character/idle-contact.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'

function fixture() {
  const companion={id:'c',updatedAt:1,characterCard:{enabled:true},affection:{score:100},idleContact:{enabled:true,routeId:'other',idleMinutes:120}}
  const route={id:'r',companionId:'c',kind:'channel',channelId:'ch',userId:'834426963',sessionId:'s',lastMessageAt:Date.now(),inboundMessageIds:['u1'],qqSessionMode:'separate'}
  const channel={id:'ch',companionId:'c',enabled:true,platform:'qq',qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['834426963','12345678']}}}
  const state={companions:[companion],sessions:[route],channels:[channel],pairings:[{channelId:'ch',userId:route.userId,status:'approved'}]}
  const events=[{type:'user/message',seq:1,time:Date.now(),data:{id:'u1',source:{kind:'user'}}}]
  const followed=[]
  const agent={status:'idle',session:{id:'s',seq:1,snapshotEvents:()=>events},followup:message=>followed.push(message)}
  const store={snapshot:()=>state,update:async fn=>fn(state),subscribe:()=>()=>{},isCompanionRemoving:()=>false}
  const runtime=new PartnerAgentRuntime({agents:{get:()=>undefined}},store,'/tmp');runtime.ensureAgent=async()=>agent;runtime.isArchived=()=>false
  return {companion,route,channel,state,events,followed,agent,store,runtime,source:{routeId:'r',sessionId:'s',userMessageId:'u1'}}
}

function plan(f,delayMinutes=0){return planActivity(f.state,f.companion,'s',f.events,{reason:'想继续刚才的话题',routeId:'r',delayMinutes})}
test('ordinary delivered replies never create an automatic second turn',async()=>{
 const f=fixture();await f.runtime.replyDelivered(f.source)
 assert.equal(f.companion.activityPlan,undefined);assert.equal(f.route.postReplyOpportunity,undefined)
 await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('agent-authored plan waits for delivery, then claims once without randomness',async()=>{
 const f=fixture();plan(f);await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
 await f.runtime.replyDelivered(f.source);assert.equal(f.companion.activityPlan.status,'pending')
 const random=Math.random;Math.random=()=>{throw Error('No probability draw allowed')}
 try{await Promise.all([f.runtime.idleContact('c'),f.runtime.idleContact('c')])}finally{Math.random=random}
 assert.equal(f.followed.length,1);assert.equal(f.companion.activityPlan.status,'claimed');assert.equal(f.route.idleContactState.kind,'autonomous')
 assert.match(f.followed[0].content[0].text,/想继续刚才的话题/)
 await f.runtime.idleContact('c');assert.equal(f.followed.length,1)
})
test('agent chooses a later wake without idle timer bypassing it',async()=>{
 const f=fixture();plan(f,240);await f.runtime.replyDelivered(f.source);await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
for(const change of ['new input','sleep','unbound','disabled','settings changed','session changed','revoked'])test('planned activity obeys '+change,async()=>{
 const f=fixture();plan(f);await f.runtime.replyDelivered(f.source)
 if(change==='new input')await f.runtime.cancelPostReply('c',undefined,'s')
 if(change==='sleep')f.companion.sleepState={episode:{wakeAt:Date.now()+60000}}
 if(change==='unbound')f.channel.qq.identityBinding.qqIds=[]
 if(change==='disabled')f.companion.idleContact.enabled=false
 if(change==='settings changed')f.companion.updatedAt++
 if(change==='session changed')f.route.sessionId='new'
 if(change==='revoked')f.state.pairings[0].status='blocked'
 await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('guest and private-to-other-owner plans cannot be created',()=>{
 const f=fixture();f.route.userId='99999999';assert.throws(()=>plan(f),/账号/)
 f.route.userId='834426963';f.state.sessions.push({...f.route,id:'other',sessionId:'other-s',userId:'12345678'})
 f.state.pairings.push({channelId:'ch',userId:'12345678',status:'approved'})
 assert.throws(()=>planActivity(f.state,f.companion,'s',f.events,{reason:'转发私聊',routeId:'other'}),/允许的会话/)
})
test('busy turns defer, and fresh input during claim prevents followup',async()=>{
 const f=fixture();plan(f);await f.runtime.replyDelivered(f.source);f.agent.status='running';await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
 f.agent.status='idle';f.store.update=async fn=>{fn(f.state);f.agent.session.seq++};await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('next plan does not revoke current autonomous turn; new input does',async()=>{
 const f=fixture();plan(f);await f.runtime.replyDelivered(f.source);await f.runtime.idleContact('c')
 f.events.push({type:'turn/start',seq:2,data:{turn:1}},{type:'user/message',seq:3,time:Date.now(),data:f.followed[0]})
 const next=plan(f,60);assert.equal(next.status,'waiting');assert.equal(activityPolicyCurrent(f.state,f.companion,f.route),true)
 assert.equal(qqChatOnly(f.agent,f.state),false)
 await f.runtime.cancelPostReply('c',undefined,'s');assert.equal(activityPolicyCurrent(f.state,f.companion,f.route),false);assert.equal(qqChatOnly(f.agent,f.state),true)
})
test('tool plans without concluding the current user reply',async()=>{
 const f=fixture();let ended=false
 const result=await thoughtTool('c',f.store).execute({action:'plan',reason:'过会再聊',delayMinutes:10},{agent:f.agent,signal:new AbortController().signal,concludeTurn(){ended=true}})
 assert.equal(result.saved,true);assert.equal(ended,false);assert.equal(f.companion.activityPlan.status,'waiting')
})
test('completed silent activity activates its chosen next step, never an automatic chain',async()=>{
 const f=fixture();plan(f);await f.runtime.replyDelivered(f.source);await f.runtime.idleContact('c')
 f.events.push({type:'turn/start',seq:2,data:{turn:1}},{type:'user/message',seq:3,time:Date.now(),data:f.followed[0]})
 plan(f,20)
 f.events.push({type:'tool/ptc-dispatch',seq:4,data:{name:'partner_activity_finish',meta:{kind:'partner-activity-silent-v1'},isError:false}},{type:'turn/end',seq:5,time:Date.now(),data:{turn:1,reason:{kind:'completed'}}})
 await f.runtime.continueCompletedActivity('c');assert.equal(f.companion.activityPlan.status,'pending')
 await f.runtime.continueCompletedActivity('c');assert.equal(f.companion.activityPlan.status,'pending')
})
test('failed source run cancels instead of continuing or blocking future idle activity',async()=>{
 const f=fixture();plan(f);f.events.unshift({type:'turn/start',seq:0,data:{turn:1}})
 f.events.push({type:'turn/end',seq:2,time:Date.now(),data:{turn:1,reason:{kind:'failed'}}})
 await f.runtime.continueCompletedActivity('c');assert.equal(f.companion.activityPlan.status,'cancelled')
})
test('saved intention survives store reopening with its exact destination and due time',async t=>{
 const root=await mkdtemp(join(tmpdir(),'autonomy-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(root,'state.json')),f=fixture();const p=plan(f,30)
 await store.update(s=>{s.companions[0].activityPlan=p})
 const reopened=await PartnerStore.open(join(root,'state.json'));assert.deepEqual(reopened.snapshot().companions[0].activityPlan,p)
})

function autonomousSource(f){
 f.companion.idleContact.routeId='r'
 f.route.idleContactState={kind:'autonomous',messageId:'notice',userMessageId:'u1',policyRevision:1}
 f.events.push({type:'turn/start',seq:2,data:{turn:1}},{type:'user/message',seq:3,time:Date.now(),data:{id:'notice',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}})
 plan(f,0)
 f.events.push({type:'assistant/message',seq:4,data:{message:{content:[{type:'text',text:'刚才那个话题我还想接着聊'}]}}},{type:'turn/end',seq:5,time:Date.now(),data:{turn:1,reason:{kind:'completed'}}})
}
test('channel output must be acknowledged before the next intended action',async()=>{
 const f=fixture();autonomousSource(f)
 await f.runtime.continueCompletedActivity('c');assert.equal(f.companion.activityPlan.status,'waiting')
 f.state.notificationDeliveries=[{reply:{idleContactOrigin:{messageId:'notice'}},targets:[]}]
 await f.runtime.continueCompletedActivity('c');assert.equal(f.companion.activityPlan.status,'waiting')
 f.state.notificationDeliveries[0].completedAt=Date.now()
 await f.runtime.continueCompletedActivity('c');assert.equal(f.companion.activityPlan.status,'pending')
})
test('unknown channel outcome cancels the next action instead of replaying it',async()=>{
 const f=fixture();autonomousSource(f)
 f.state.notificationDeliveries=[{reply:{idleContactOrigin:{messageId:'notice'}},targets:[{lastError:'timeout',retrySafe:false}]}]
 await f.runtime.continueCompletedActivity('c');assert.equal(f.companion.activityPlan.status,'cancelled')
})
test('silent independent work needs no synthetic chat delivery to continue',async()=>{
 const f=fixture();autonomousSource(f);f.events.splice(-2,1)
 await f.runtime.continueCompletedActivity('c');assert.equal(f.companion.activityPlan.status,'pending')
})
