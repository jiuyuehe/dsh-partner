import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDefaultCompanion} from '../lib/domain.js'
import {PartnerStore} from '../lib/store.js'
import {emptyCharacterCard,normalizeCharacterCard} from '../lib/character/domain.js'
import {affectionProgress,affectionEnabled,adjustAffection,renderAffection,AFFECTION_INTERVAL} from '../lib/character/affection.js'
import {affectionAudienceAllowed} from '../lib/character/affection-adapter.js'
import {affectionTurnEligible,currentAffectionAudience} from '../lib/character/affection-context.js'
import {idleActivityProbability,IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
import {applyIdentity} from '../lib/companions/identity.js'
const now=Date.parse('2026-10-29T16:00:00Z')
const user=id=>({type:'user/message',data:{id,content:[{type:'text',text:'我是哥哥'}],source:{kind:'user'}}})
function fixture(){
 const c={...createDefaultCompanion(),id:'c',characterCard:{...emptyCharacterCard(),enabled:true,roleText:'坦率的伙伴'}}
 const other={...structuredClone(c),id:'other'}
 const channels=[{id:'qq',companionId:'c',platform:'qq',enabled:true,qq:{identityBinding:{enabled:true,qqIds:['12345678','22345678']}}}]
 const local={id:'local',kind:'local',sessionId:'s',channelId:'local',userId:'owner',companionId:'c',lastMessageAt:now-60_000}
 const owner={...local,id:'owner',kind:'channel',channelId:'qq',userId:'12345678',inboundMessageIds:['a']}
 const owner2={...owner,id:'owner2',userId:'group:99887766:22345678',inboundMessageIds:['b']}
 const guest={...owner,id:'guest',userId:'group:99887766:33445678',inboundMessageIds:['g']}
 const state={companions:[c,other],channels,sessions:[local,owner,owner2,guest],pairings:[{channelId:'qq',userId:owner.userId,status:'approved'}]}
 return {c,other,state,local,owner,owner2,guest}
}
test('default channels participate; QQ owners share eligibility, guests and group-wide autonomy do not',()=>{
 const f=fixture(),channel=f.state.channels[0]
 assert.equal(affectionAudienceAllowed({route:f.local}),true)
 assert.equal(affectionAudienceAllowed({route:f.owner,channel:{...channel,platform:'matrix'}}),true)
 for(const route of [f.owner,f.owner2])assert.equal(affectionAudienceAllowed({route,channel}),true)
 assert.equal(affectionAudienceAllowed({route:f.guest,channel}),false)
 assert.equal(affectionAudienceAllowed({route:f.owner2,channel,autonomous:true}),false)
 channel.qq.identityBinding.enabled=false
 assert.equal(affectionAudienceAllowed({route:f.owner,channel}),false)
})
test('verified input provenance survives shared sessions, unknown QQ-only input and mixed guest turns fail closed',()=>{
 const f=fixture()
 for(const id of ['a','b','browser'])assert.equal(affectionTurnEligible(f.state,'c','s',[user(id)]),true)
 assert.equal(affectionTurnEligible(f.state,'other','s',[user('a')]),false)
 assert.equal(affectionTurnEligible(f.state,'c','s',[user('g'),user('a')]),false)
 assert.equal(currentAffectionAudience(f.state,'c','s',[user('a'),user('g')]),false)
 f.state.sessions=f.state.sessions.filter(r=>r.kind!=='local')
 assert.equal(affectionTurnEligible(f.state,'c','s',[user('unknown')]),false)
 const notice={type:'user/message',data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}
 f.owner.idleContactState={messageId:'idle'}
 assert.equal(currentAffectionAudience(f.state,'c','s',[notice]),true)
 assert.equal(affectionTurnEligible(f.state,'c','s',[notice]),false)
 delete f.owner.idleContactState;f.owner2.idleContactState={messageId:'idle'}
 assert.equal(currentAffectionAudience(f.state,'c','s',[notice]),false)
})
const change=(c,id,at,delta=1)=>adjustAffection(c,id,at,delta,'具体互动带来的感受','当前用户原话')
test('slower positive changes, separate rolling budgets, deduplication and pause',()=>{
 const f=fixture(),revision=f.c.updatedAt
 assert.equal(affectionProgress().score,0)
 assert.equal(change(f.c,'a',now),true)
 assert.equal(change(f.c,'a',now+AFFECTION_INTERVAL),false)
 assert.equal(change(f.c,'b',now+1000),false)
 assert.equal(change(f.c,'b',now+AFFECTION_INTERVAL),true)
 assert.equal(change(f.c,'c',now+2*AFFECTION_INTERVAL),false)
 assert.equal(f.c.affection.score,2)
 assert.equal(change(f.c,'bad',now+2*AFFECTION_INTERVAL,-3),true)
 assert.equal(f.c.affection.score,-1)
 assert.equal(change(f.c,'c',now+3*AFFECTION_INTERVAL),false,'negative change cannot replenish positive budget')
 assert.equal(change(f.c,'bad2',now+3*AFFECTION_INTERVAL,-3),true)
 assert.equal(change(f.c,'bad3',now+4*AFFECTION_INTERVAL,-1),false)
 assert.equal(change(f.c,'next-day',now+25*3600000),true)
 assert.equal(affectionProgress(f.other.affection).score,0)
 assert.equal(f.c.updatedAt,revision)
 f.c.characterCard.affectionEnabled=false
 assert.throws(()=>change(f.c,'paused',now+30*3600000),/暂停/)
 assert.equal(renderAffection(f.c,true),'')
})
test('eleven bidirectional stages, saturation and positive probability even at negative extreme',()=>{
 const f=fixture()
 for(const [score,level] of [[-100,1],[-75,2],[-50,3],[-25,4],[-10,5],[0,6],[10,7],[25,8],[45,9],[70,10],[90,11],[100,11]])assert.equal(affectionProgress({score}).level,level)
 for(const [initial,delta,expected] of [[99,1,100],[-99,-3,-100]]) {
  f.c.affection={score:initial,updatedAt:1,lastAwardAt:0,lastTurnId:'old'}
  assert.equal(change(f.c,'edge',now,delta),true);assert.equal(f.c.affection.score,expected)
  assert.equal(change(f.c,'more',now+AFFECTION_INTERVAL,delta),false)
 }
 f.c.idleContact={enabled:true,routeId:'owner',idleMinutes:30}
 const last={id:'u',at:now-60000}
 assert.equal(idleActivityProbability(f.state,f.c,last,now),0.5/30)
 f.c.characterCard.affectionEnabled=false
 assert.equal(idleActivityProbability(f.state,f.c,last,now),1/30)
 assert.equal(renderAffection(f.c,false),'')
 assert.equal(affectionProgress({score:80}).score,80,'legacy values are preserved')
})
test('negative score and bounded journal survive persistence and identity changes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'partner-affection-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(root,'state.json')),f=fixture()
 for(let i=0;i<45;i++)change(f.c,'event-'+i,now+i*25*3600000,i%2?-1:1)
 assert.equal(f.c.affection.history.length,40)
 change(f.c,'negative',now+46*25*3600000,-3)
 await store.update(s=>{s.companions=[f.c]})
 const reopened=await PartnerStore.open(join(root,'state.json'));const c=reopened.snapshot().companions[0]
 assert.equal(c.affection.score,-2)
 const before=structuredClone(c.affection)
 applyIdentity({companions:[c]},c,{name:'新名字'},c.updatedAt,'ai')
 assert.deepEqual(c.affection,before)
 assert.throws(()=>applyIdentity({companions:[c]},c,{affection:{score:100}},c.updatedAt,'ai'))
})
test('completed ordinary conversations no longer automatically gain affection',async()=>{
 const {PartnerAgentRuntime}=await import('../lib/agent-runtime.js')
 const f=fixture();f.c.automation.memory.enabled=false
 const runtime=Object.create(PartnerAgentRuntime.prototype)
 Object.assign(runtime,{store:{snapshot:()=>f.state,update:async fn=>fn(f.state)}})
 const start={type:'turn/start',seq:1,time:now-100,data:{turn:1}}
 const input={...user('a'),seq:2,time:now-90}
 const answer={type:'assistant/message',seq:3,time:now-10,data:{message:{content:[{type:'text',text:'好啊，一起聊聊。'}]}}}
 const end={type:'turn/end',seq:4,time:now,data:{turn:1,reason:{kind:'completed'}}}
 const session={id:'s',snapshotEvents:()=>[start,input,answer,end]}
 await runtime.processSessionEvent(session,end)
 assert.equal(f.c.affection,undefined)
})
test('affection tool verifies current user evidence, audience, revocation and new-input race',async()=>{
 const {affectionTool}=await import('../lib/character/affection-tool.js')
 const f=fixture();let events=[{type:'turn/start',seq:1},{...user('a'),seq:2}]
 let beforeWrite=()=>{}
 const store={snapshot:()=>structuredClone(f.state),isCompanionRemoving:()=>false,update:async fn=>{beforeWrite();fn(f.state);return f.state}}
 const tool=affectionTool('c',store),exec={agent:{session:{id:'s',snapshotEvents:()=>events}},signal:new AbortController().signal}
 const call=patch=>tool.execute({action:'adjust',delta:-1,reason:'当前互动让角色有些不舒服',evidence:'我是哥哥',...patch},exec)
 await assert.rejects(call({evidence:'从来没说过的话'}),/原文/)
 assert.equal(f.c.affection,undefined)
 await assert.rejects(call({delta:3}),/参数无效/)
 assert.equal((await call()).applied,true);assert.equal(f.c.affection.score,-1)
 assert.equal((await call()).applied,false)
 events=[{type:'turn/start',seq:3},{...user('g'),seq:4}]
 await assert.rejects(call(),/不能修改/)
 events=[{type:'turn/start',seq:5},{type:'user/message',seq:6,data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}]
 await assert.rejects(call(),/用户互动/)
 events=[{type:'turn/start',seq:7},{...user('a'),seq:8}]
 f.c.characterCard.affectionEnabled=false
 await assert.rejects(call(),/暂停/)
 f.c.characterCard.affectionEnabled=true
 beforeWrite=()=>{events.push({...user('b'),seq:9})}
 await assert.rejects(call(),/消息已变化/)
 assert.equal(f.c.affection.score,-1)
})

test('relationship bookkeeping needs no chat preamble and history is not injected into persona',async()=>{
 const {needsTaskPreamble}=await import('../lib/execution/task-preamble.js')
 assert.equal(needsTaskPreamble('partner_affection',{action:'adjust'}),false)
 const f=fixture();change(f.c,'a',now,-1)
 assert.ok(!renderAffection(f.c,true).includes('当前用户原话'))
})
