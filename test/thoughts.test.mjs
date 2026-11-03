import test from 'node:test'
import assert from 'node:assert/strict'
import {ThoughtService,thoughtTargetAllowed,renderThoughts,thoughtPriority} from '../lib/character/thoughts.js'
import {thoughtTool} from '../lib/character/thought-tool.js'
import {activityPolicyCurrent} from '../lib/character/post-reply.js'
import {qqChatOnly} from '../lib/channels/qq/authority.js'
import {idleContactDue,IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
const now=Date.now()
function fixture(){
 const c={id:'c',name:'伙伴',role:'坦率',updatedAt:1,characterCard:{enabled:true},automation:{memory:{enabled:true}},idleContact:{enabled:true,routeId:'local',idleMinutes:30}}
 const local={id:'local',kind:'local',companionId:'c',sessionId:'main',channelId:'@local',userId:'owner',lastMessageAt:now-7200000}
 const group={id:'group',kind:'channel',companionId:'c',sessionId:'group-session',channelId:'qq',userId:'group:99887766:22334455',lastMessageAt:now-7200000,qqSessionMode:'separate'}
 const owner={...group,id:'owner',sessionId:'owner-session',userId:'12345678'},stranger={...owner,id:'stranger',sessionId:'stranger-session',userId:'22334455'}
 const state={companions:[c],sessions:[local,group,owner,stranger],channels:[{id:'qq',companionId:'c',name:'QQ',enabled:true,platform:'qq',qq:{privateReplies:true,groupReplies:true,groupIds:['99887766'],autonomousGroupIds:['99887766'],identityBinding:{enabled:true,qqIds:['12345678']}}}],pairings:[{channelId:'qq',userId:'12345678',status:'approved'},{channelId:'qq',userId:'22334455',status:'approved'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false,subscribe:()=>()=>{},update:async fn=>{fn(state);return state}}
 const turn={id:'t',companionId:'c',sessionId:group.sessionId,scopeId:'scope',at:now-1000,user:'这几个表情包好有意思',assistant:'我也想找点好用的',sourceRouteIds:['group'],characterEnabled:true}
 const service=new ThoughtService(store)
 const proposal={sourceRouteIds:['group'],value:{text:'想找归属账号要几个好用的表情',why:'群里聊起表情，我也想试试',evidence:'我也想找点好用的',targetRouteId:'owner'}}
 return {c,local,group,owner,stranger,state,store,turn,service,proposal}
}
test('a real group exchange can form a cross-session thought without granting the guest tools',async()=>{
 const f=fixture(),p=f.service.prepare(f.turn);assert.ok(p);assert.match(p.prompt,/归属账号/)
 await f.service.apply(f.turn,f.proposal)
 assert.equal(f.c.thoughts.length,1);assert.equal(f.c.thoughts[0].targetRouteId,'owner')
 const events=[{type:'user/message',data:{id:'guest',source:{kind:'user'}}}];f.group.inboundMessageIds=['guest']
 assert.equal(qqChatOnly({session:{id:f.group.sessionId,snapshotEvents:()=>events}},f.state),true)
 assert.match(renderThoughts(f.state,f.c,f.owner),/想找归属账号/)
})
test('private source never leaks through shared memory to another person or group',async()=>{
 const f=fixture();f.turn.sourceRouteIds=['owner'];f.proposal.sourceRouteIds=['owner'];f.proposal.value.targetRouteId='owner'
 await f.service.apply(f.turn,f.proposal)
 assert.equal(thoughtTargetAllowed(f.state,f.c,['owner'],f.group),false)
 assert.equal(thoughtTargetAllowed(f.state,f.c,['owner'],f.stranger),false)
 assert.equal(renderThoughts(f.state,f.c,f.group),'')
 assert.equal(renderThoughts(f.state,f.c,f.stranger),'')
 f.state.channels[0].qq.identityBinding.qqIds.push('22334455')
 assert.equal(thoughtTargetAllowed(f.state,f.c,['owner'],f.stranger),false,'multiple owners are different people')
})
test('source/target revocation, missing evidence and disabled activity prevent new thoughts',async()=>{
 for(const mutate of [f=>f.proposal.value.evidence='编造的事实',f=>f.state.channels[0].qq.identityBinding.qqIds=[],f=>f.c.idleContact.enabled=false,f=>f.state.channels[0].qq.autonomousGroupIds=[],f=>f.proposal.value.targetRouteId='stranger']){
  const f=fixture();mutate(f);await f.service.apply(f.turn,f.proposal);assert.equal(f.c.thoughts,undefined)
 }
})
test('repeated extraction is idempotent; new evidence refreshes the same thought',async()=>{
 const f=fixture();await f.service.apply(f.turn,f.proposal);await f.service.apply(f.turn,f.proposal);assert.equal(f.c.thoughts.length,1)
 f.c.thoughts[0].attempts=8;const before=thoughtPriority(f.c.thoughts[0]);f.c.thoughts[0].lastConsideredAt=now;assert.ok(thoughtPriority(f.c.thoughts[0])<before)
 await f.service.apply({...f.turn,id:'next',at:now,user:'我又找到了个新的'}, {...f.proposal,value:{...f.proposal.value,evidence:'我又找到了个新的'}})
 assert.equal(f.c.thoughts.length,1);assert.equal(f.c.thoughts[0].sourceTurnId,'next');assert.equal(f.c.thoughts[0].attempts,4)
})
test('thought activity stays authorized only while its actual source and destination remain valid',async()=>{
 const f=fixture();await f.service.apply(f.turn,f.proposal)
 f.owner.idleContactState={kind:'thought',thoughtId:f.c.thoughts[0].id,messageId:'notice'}
 assert.equal(activityPolicyCurrent(f.state,f.c,f.owner),true)
 f.state.channels[0].qq.identityBinding.qqIds=[]
 assert.equal(activityPolicyCurrent(f.state,f.c,f.owner),false)
 const events=[{type:'user/message',data:{id:'notice',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}]
 assert.equal(qqChatOnly({session:{id:f.owner.sessionId,snapshotEvents:()=>events}},f.state),true)
})
test('stored thoughts do not randomly choose the next activity destination',async()=>{
 const f=fixture();await f.service.apply(f.turn,f.proposal)
 const events=[{type:'user/message',seq:1,time:now-7200000,data:{id:'u',source:{kind:'user'},content:[]}}],followed=[]
 const agent={status:'idle',session:{id:f.local.sessionId,seq:1,snapshotEvents:()=>events},followup:m=>followed.push(m)}
 const runtime=new PartnerAgentRuntime({agents:{get:()=>undefined}},f.store,'/tmp');runtime.isArchived=()=>false;runtime.ensureAgent=async(c,r)=>{assert.equal(r.id,'local');return agent}
 await runtime.idleContact('c');assert.equal(followed.length,1);assert.equal(f.local.idleContactState.kind,'autonomous');assert.equal(f.owner.idleContactState,undefined)
})
test('explicit thought completion is only available to a current autonomous activity',async()=>{
 const f=fixture();await f.service.apply(f.turn,f.proposal)
 const tool=thoughtTool('c',f.store),events=[{type:'user/message',seq:1,data:{id:'u',source:{kind:'user'}}}]
 const agent={session:{id:f.owner.sessionId,snapshotEvents:()=>events}}
 await assert.rejects(tool.execute({action:'settle',id:f.c.thoughts[0].id,status:'done',reason:'完成'}, {agent,signal:new AbortController().signal,concludeTurn(){}}),/自主活动/)
})
test('autonomous focus chooses one destination, persists it, and finishes without sending',async()=>{
 const f=fixture();await f.service.apply(f.turn,f.proposal);const t=f.c.thoughts[0]
 f.c.idleContact.routeId='group';f.group.idleContactState={kind:'autonomous',userMessageId:'u',messageId:'notice',policyRevision:1}
 const events=[{type:'user/message',seq:1,data:{id:'u',source:{kind:'user'}}},{type:'turn/start',seq:2},{type:'user/message',seq:3,data:{id:'notice',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}]
 let ended=0
 const exec={agent:{session:{id:f.group.sessionId,snapshotEvents:()=>events}},signal:new AbortController().signal,concludeTurn(){ended++}}
 const result=await thoughtTool('c',f.store).execute({action:'focus',id:t.id,routeId:'owner',reason:'想找归属账号接着聊'},exec)
 assert.equal(t.targetRouteId,'owner');assert.equal(ended,1);assert.equal(result.kind,'partner-activity-silent-v1')
 assert.equal(f.owner.idleContactState,undefined,'focus alone never starts another turn or sends');assert.equal(f.c.activityPlan.status,'waiting')
})

test('shared background extraction generates thoughts without an additional model call',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {PartnerMemoryStore}=await import('../lib/memory-store.js'),{PartnerConcernStore}=await import('../lib/concern-store.js'),{MemoryReflectionService}=await import('../lib/memory-reflection.js')
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'partner-thought-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0
 const memory=new PartnerMemoryStore(root)
 const ctx={logger:{warn(){}},agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(input){
  calls++;assert.match(input.system,/额外输出 thought/)
  yield {type:'text-delta',text:JSON.stringify({daily:{summary:'讨论表情'},memories:[],concerns:[],thought:f.proposal.value})}
 }}}
 const reflection=new MemoryReflectionService(ctx,memory,new PartnerConcernStore(root),undefined,f.service)
 await reflection.reflect(f.c,f.turn);assert.equal(calls,0)
 await reflection.processPending(f.c);assert.equal(calls,1);assert.equal(f.c.thoughts[0].targetRouteId,'owner')
 await reflection.processPending(f.c);assert.equal(calls,1)
})

test('transport confirmation and failed sends are distinct and idempotent in the thought journal',async()=>{
 const {ChannelManager}=await import('../lib/channels/manager.js')
 const f=fixture();await f.service.apply(f.turn,f.proposal)
 const manager=Object.create(ChannelManager.prototype);manager.store=f.store;const id=f.c.thoughts[0].id
 await manager.recordThoughtDelivery('c',id,'activity','delivered','已发送')
 await manager.recordThoughtDelivery('c',id,'activity','delivered','已发送')
 assert.equal(f.c.thoughts[0].attempts,1);assert.equal(f.c.thoughts[0].lastOutcome,'delivered')
 await manager.recordThoughtDelivery('c',id,'second','failed','未确认')
 assert.equal(f.c.thoughts[0].attempts,2);assert.equal(f.c.thoughts[0].lastOutcome,'failed');assert.equal(f.c.thoughts[0].status,'open')
})

test('a private follow-up result cannot hitchhike on a public-source thought back into the group',async()=>{
 const f=fixture();await f.service.apply(f.turn,f.proposal)
 const t=f.c.thoughts[0];t.result='私聊中的个人资料';t.resultRouteId='owner'
 assert.doesNotMatch(renderThoughts(f.state,f.c,f.group),/私聊中的个人资料/)
 assert.match(renderThoughts(f.state,f.c,f.owner),/私聊中的个人资料/)
 const listed=await thoughtTool('c',f.store).execute({action:'list'},{agent:{session:{id:f.group.sessionId,snapshotEvents:()=>[]}}})
 assert.doesNotMatch(JSON.stringify(listed),/私聊中的个人资料/)
 const privateTurn={...f.turn,id:'private',sourceRouteIds:['owner'],at:now,sessionId:f.owner.sessionId}
 await f.service.apply(privateTurn,{...f.proposal,sourceRouteIds:['owner']})
 assert.equal(f.c.thoughts.length,2,'same wording from different origins does not merge provenance')
})
