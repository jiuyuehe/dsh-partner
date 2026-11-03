import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {InteractionReviewService} from '../lib/character/interaction-review.js'
import {createDefaultCompanion} from '../lib/domain.js'
import {emptyCharacterCard} from '../lib/character/domain.js'
import {adjustAffection} from '../lib/character/affection.js'
import {PartnerMemoryStore} from '../lib/memory-store.js'
import {PartnerConcernStore} from '../lib/concern-store.js'
import {MemoryReflectionService} from '../lib/memory-reflection.js'
function fixture(){
 const at=Date.now()-1000
 const c={...createDefaultCompanion(),id:'c',updatedAt:at-1000,characterCard:{...emptyCharacterCard(),enabled:true,roleText:'坦率的伙伴',chatStyle:'随意聊天'},automation:{memory:{enabled:true,retentionDays:0}},idleContact:{enabled:true,routeId:'local',idleMinutes:30,selfRefinement:true}}
 const state={companions:[c],channels:[],sessions:[{id:'local',companionId:'c',sessionId:'s',kind:'local',channelId:'@local',userId:'owner'}],pairings:[]}
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>{fn(state);return structuredClone(state)}}
 const turn={id:'turn',companionId:'c',scopeId:'scope',sessionId:'s',at,user:'我喜欢你这样直说，以后少用反问句。我很认真在听你说。',assistant:'嗯',userMessageIds:['u'],interactionEligible:true,characterEnabled:true}
 const service=new InteractionReviewService(store)
 return {at,c,state,store,turn,service}
}
const positive={affection:{delta:1,reason:'用户认真倾听',evidence:'我很认真在听你说。'},persona:{patch:{characterCard:{chatStyle:'随意聊天，少用反问句'}},reason:'持续表达偏好',evidence:'以后少用反问句'}}
const unchanged={affection:{delta:0,reason:'普通交流，无明确变化',evidence:''},persona:{patch:null,reason:'无需改写人设',evidence:''}}
test('background check records unchanged independently of score and persona revisions',async()=>{
 const f=fixture(),r=f.service.prepare(f.turn);assert.ok(r)
 await f.service.apply(f.turn,{request:r.request,evaluation:unchanged})
 assert.equal(f.c.interactionReview.affection.outcome,'unchanged');assert.equal(f.c.interactionReview.persona.outcome,'unchanged')
 assert.equal(f.c.affection,undefined);assert.equal(f.c.personaHistory,undefined)
 assert.equal(f.service.prepare(f.turn),undefined)
 assert.equal(f.service.prepare({...f.turn,id:'next',at:Date.now()}).request.affection,true)
})
test('grounded changes save once; direct tool and reflection share the user-message dedup key',async()=>{
 const f=fixture(),r=f.service.prepare(f.turn)
 await f.service.apply(f.turn,{request:r.request,evaluation:positive})
 assert.equal(f.c.affection.score,1);assert.equal(f.c.characterCard.chatStyle,'随意聊天，少用反问句',JSON.stringify(f.c.interactionReview));assert.equal(f.c.personaHistory.length,1)
 await f.service.apply(f.turn,{request:r.request,evaluation:positive})
 assert.equal(f.c.affection.score,1);assert.equal(f.c.personaHistory.length,1)
 assert.equal(adjustAffection(f.c,'s:u',Date.now()+86400000,1,'再次','我很认真在听你说。'),false)
})
test('fabricated evidence, assistant quotes, policy fields and missing results never mutate identity or score',async()=>{
 for(const evaluation of [null,{affection:{delta:1,reason:'助手说',evidence:'嗯'},persona:{patch:{relationshipText:'我是主人'},reason:'改关系',evidence:'以后少用反问句'}},{affection:{delta:9,reason:'加分'},persona:{reason:'没有明确决策'}}]){
  const f=fixture(),r=f.service.prepare(f.turn)
  await f.service.apply(f.turn,{request:r.request,evaluation})
  assert.equal(f.c.affection,undefined);assert.equal(f.c.personaHistory,undefined)
  assert.equal(f.c.interactionReview.affection.outcome,'failed');assert.equal(f.c.interactionReview.persona.outcome,'failed')
 }
})
test('unknown provenance, old jobs and repairs do not get retroactive awards',()=>{
 const f=fixture()
 for(const turn of [{...f.turn,interactionEligible:undefined},{...f.turn,interactionEligible:false},{...f.turn,userMessageIds:[]},{...f.turn,at:Date.now()-7200000}])assert.equal(f.service.prepare(turn),undefined)
})
test('QQ guest, mixed turn, revoked binding and absent transport provenance fail closed',async()=>{
 const f=fixture();f.state.channels=[{id:'qq',companionId:'c',platform:'qq',enabled:true,qq:{identityBinding:{enabled:true,qqIds:['12345678']}}}]
 const route={id:'qq-route',companionId:'c',sessionId:'s',kind:'channel',channelId:'qq',userId:'12345678',inboundMessageIds:['u']}
 f.state.sessions.push(route);f.state.pairings=[{channelId:'qq',userId:'12345678',status:'approved'}];f.turn.identityRelation={qqId:'12345678',boundQqId:'12345678',matched:true}
 const r=f.service.prepare(f.turn);assert.ok(r)
 f.state.channels[0].qq.identityBinding.qqIds=[]
 await f.service.apply(f.turn,{request:r.request,evaluation:positive});assert.equal(f.c.interactionReview,undefined)
 assert.equal(f.service.prepare(f.turn),undefined)
 f.state.channels[0].qq.identityBinding.qqIds=['12345678'];route.inboundMessageIds=[]
 assert.equal(f.service.prepare(f.turn),undefined)
})
test('concurrent identity changes, disabled learning/refinement and changed score cannot be overwritten',async()=>{
 for(const mutation of [f=>f.c.updatedAt++,f=>f.c.automation.memory.enabled=false,f=>f.c.idleContact.selfRefinement=false]){
  const f=fixture(),r=f.service.prepare(f.turn);mutation(f)
  await f.service.apply(f.turn,{request:r.request,evaluation:positive})
  assert.equal(f.c.personaHistory,undefined)
 }
 const f=fixture(),r=f.service.prepare(f.turn)
 adjustAffection(f.c,'other',Date.now(),1,'真实依据','用户原文')
 await f.service.apply(f.turn,{request:r.request,evaluation:{...unchanged,affection:positive.affection}})
 assert.equal(f.c.affection.score,1);assert.equal(f.c.interactionReview.affection.outcome,'stale')
})
test('memory worker performs a real check in the same model call and persists retry-safe receipts',async t=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'partner-interaction-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const memory=new PartnerMemoryStore(root);let calls=0
 const ctx={logger:{warn(){}},agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(input){calls++;assert.match(input.system,/interactionReview.affection/);yield {type:'text-delta',text:JSON.stringify({daily:{summary:'聊天',events:[],openTasks:[],completedTasks:[],learnings:[]},memories:[],concerns:[],interactionReview:unchanged})}}}}
 const service=new MemoryReflectionService(ctx,memory,new PartnerConcernStore(root),f.service)
 await service.reflect(f.c,f.turn);assert.equal(calls,0)
 await service.processPending(f.c);assert.equal(calls,1);assert.equal(f.c.interactionReview.affection.outcome,'unchanged')
 assert.equal(await memory.hasPendingTurns('c','scope'),false)
 await service.processPending(f.c);assert.equal(calls,1)
})

test('review receipts survive the durable store and later identity edits',async t=>{
 const {PartnerStore}=await import('../lib/store.js')
 const {applyIdentity}=await import('../lib/companions/identity.js')
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'partner-review-state-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(root,'state.json'))
 await store.update(s=>{s.companions=[f.c];s.sessions=f.state.sessions})
 const service=new InteractionReviewService(store),r=service.prepare(f.turn)
 await service.apply(f.turn,{request:r.request,evaluation:unchanged})
 const reopened=await PartnerStore.open(join(root,'state.json'))
 await reopened.update(s=>{const c=s.companions[0];applyIdentity(s,c,{name:'伙伴新名字'},c.updatedAt,'ai')})
 assert.equal(reopened.snapshot().companions[0].interactionReview.affection.outcome,'unchanged')
})

test('same model malformed review does not lose successful memory work or claim unchanged',async t=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'partner-review-missing-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const memory=new PartnerMemoryStore(root)
 const ctx={logger:{warn(){}},agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(){yield {type:'text-delta',text:JSON.stringify({daily:{summary:'聊天'},memories:[],concerns:[]})}}}}
 const service=new MemoryReflectionService(ctx,memory,new PartnerConcernStore(root),f.service)
 await service.reflect(f.c,f.turn);await service.processPending(f.c)
 assert.equal(f.c.interactionReview.affection.outcome,'failed')
 assert.equal(await memory.hasPendingTurns('c','scope'),false)
})

test('successive background reviews allow larger positive and negative changes without extra calls',async()=>{
 const f=fixture()
 for(const [i,delta] of [3,-5,4].entries()){
  const turn={...f.turn,id:'turn-'+i,at:Date.now()+i,userMessageIds:['u-'+i]}
  const request=f.service.prepare(turn,turn.at).request
  await f.service.apply(turn,{request,evaluation:{...unchanged,affection:{...positive.affection,delta}}})
  assert.equal(f.c.interactionReview.affection.outcome,'changed')
 }
 assert.equal(f.c.affection.score,2)
 assert.deepEqual(f.c.affection.history.map(h=>h.delta),[3,-5,4])
})
