import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { createDefaultCompanion } from '../lib/domain.js'
import { normalizeCharacterCard } from '../lib/character/domain.js'
import { PartnerMemoryStore } from '../lib/memory-store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture(enabled = true) {
  const companion = createDefaultCompanion()
  companion.characterCard = normalizeCharacterCard({ enabled: true, roleText: '坦率的同行者' })
  companion.automation.memory.enabled = enabled
  const session = Session.create('context-test')
  const contexts = new Map(), sections = new Map(), calls = []
  const agent = { session, ctx: { systemPrompt: {
    section: value => { sections.set(value.name, value); return () => sections.delete(value.name) },
    context: value => { contexts.set(value.name, value); return () => contexts.delete(value.name) },
  } } }
  const route = { companionId: companion.id, channelId:'@local', userId:'owner', kind:'local', sessionId:session.id }
  const config = { companion, route, revision:'1' }
  const runtime = Object.create(PartnerAgentRuntime.prototype)
  // 测试夹具绕过运行时构造函数，需补上独立渠道上下文注册表。
  Object.assign(runtime, { configurations:{ forSession:()=>config }, store:{snapshot:()=>({sessions:[route]})}, contextRevisions:new WeakMap(), characterContexts:new Map(), channelQuestionContexts:new Map(),
    memory:{ characterState:async()=>undefined, recallContext:async(...args)=>{calls.push(args);return {profile:{entries:[],version:'1'},relevant:[],connections:[],scenes:[],history:[]} } } })
  const input = text => session.append('user/message',createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}),{surfaceOp:'append'})
  return { runtime, agent, config, calls, contexts, sections, input }
}

test('dynamic memory is recalled once per input, never mutates stable system sections or raw history', async()=>{
  const f=fixture(), signal=new AbortController().signal
  for(const text of ['你好','今天很烦']) {
    f.input(text)
    const log=JSON.stringify(f.agent.session.snapshotEvents())
    await f.runtime.prepareConversationContext(f.agent,signal)
    await f.runtime.prepareConversationContext(f.agent,signal)
    assert.equal(JSON.stringify(f.agent.session.snapshotEvents()),log)
  }
  assert.equal(f.calls.length,2)
  assert.deepEqual(f.calls[0].at(-1),{includeHistory:false})
  assert.equal(f.sections.size,0)
  assert.equal(f.contexts.size,1)
  assert.equal(f.contexts.values().next().value.interpolate,false)
  assert.equal(f.contexts.values().next().value.required,true)
})

test('memory off skips recall and clears its old snapshot on the next preparation',async()=>{
  const f=fixture(), signal=new AbortController().signal
  f.input('你好');await f.runtime.prepareConversationContext(f.agent,signal)
  f.config.companion.automation.memory.enabled=false;f.config.revision='2'
  await f.runtime.prepareConversationContext(f.agent,signal)
  assert.equal(f.calls.length,1)
  assert.doesNotMatch(f.contexts.values().next().value.text,/联系人画像|长期记忆/)
  f.config.companion.characterCard.enabled=false;f.config.revision='3'
  await f.runtime.prepareConversationContext(f.agent,signal)
  assert.equal(f.contexts.size,0)
})

test('automatic history opt-out preserves explicit historical detail lookup and legacy recall',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'partner-recall-optout-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const memory=new PartnerMemoryStore(dir)
  await memory.enqueue({id:'old',companionId:'c',scopeId:'s',sessionId:'s',at:Date.now(),user:'配色选择',assistant:'琥珀橙 XK928'})
  assert.equal((await memory.recallContext('c','s','XK928',8,{includeHistory:false})).history.length,0)
  assert.equal((await memory.recallContext('c','s','XK928')).history[0].id,'old')
  assert.match((await memory.searchHistory('c','s','XK928'))[0].assistant,/琥珀橙/)
})

function routingFixture(sessions=[]) {
 const companion=createDefaultCompanion(),state={companions:[companion],channels:[{id:'qq',platform:'qq',companionId:companion.id}],sessions},calls=[]
 const runtime=Object.create(PartnerAgentRuntime.prototype)
 Object.assign(runtime,{ctx:{workspaceRegistry:{archivedSessionIds:[]}},defaultCwd:'/tmp/qq-context',store:{snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>{const draft=structuredClone(state);fn(draft);Object.assign(state,draft)}},memory:{mergeScopes:async(...args)=>calls.push(args)}})
 return {companion,state,runtime,calls}
}

test('QQ defaults to one session per contact/group while sharing companion memory',async()=>{
 const {runtime,companion,calls}=routingFixture()
 const group=await runtime.ensureSession(companion,'qq','group:99887766:12345678')
 const local=await runtime.ensureLocalSessionRecord(companion.id)
 const privateRoute=await runtime.ensureSession(companion,'qq','12345678')
 assert.notEqual(group.sessionId,local.sessionId);assert.notEqual(privateRoute.sessionId,local.sessionId);assert.notEqual(privateRoute.sessionId,group.sessionId)
 const sameGroup=await runtime.ensureSession(companion,'qq','group:99887766:12345678')
 assert.equal(sameGroup.sessionId,group.sessionId)
 const secondMember=await runtime.ensureSession(companion,'qq','group:99887766:22345678')
 assert.equal(secondMember.sessionId,group.sessionId)
 const other=await runtime.ensureSession(companion,'qq','group:88776655:12345678')
 assert.notEqual(other.sessionId,group.sessionId)
 for(const route of [group,privateRoute,secondMember,other])assert.equal(route.memoryScopeId,'@local:owner:'+companion.id)
 assert.equal(calls.length,0,'independent sessions never migrate their archives into main memory')
})

test('selected main-session peers share only after selection and resume separate history on deselection',async()=>{
 const {runtime,companion,state}=routingFixture()
 const group=await runtime.ensureSession(companion,'qq','group:99887766:12345678','群聊 · 测试群')
 const member=await runtime.ensureSession(companion,'qq','group:99887766:22345678')
 const local=await runtime.ensureLocalSessionRecord(companion.id)
 state.channels[0].qq={mainSessionPeers:['group:99887766','private:12345678']}
 const selected=await runtime.ensureSession(companion,'qq',group.userId)
 assert.equal(selected.sessionId,local.sessionId);assert.equal(selected.id,group.id)
 assert.equal(state.sessions.find(r=>r.id===member.id).sessionId,local.sessionId)
 assert.equal((await runtime.ensureSession(companion,'qq','12345678')).sessionId,local.sessionId)
 assert.notEqual((await runtime.ensureSession(companion,'qq','32345678')).sessionId,local.sessionId)
 state.channels[0].qq.mainSessionPeers=[]
 const restored=await runtime.ensureSession(companion,'qq',group.userId)
 assert.equal(restored.sessionId,group.sessionId);assert.equal(restored.qqSessionTitle,'群聊 · 测试群')
 assert.equal(state.sessions.find(r=>r.id===member.id).sessionId,group.sessionId)
})

test('upgrade keeps old separate group history without importing group archives into main memory',async()=>{
 const f=routingFixture(),{companion,state,runtime,calls}=f
 const local={id:'local',kind:'local',companionId:companion.id,channelId:'@local',userId:'owner',sessionId:'session-main',lastMessageAt:1}
 const group={id:'group-route',kind:'channel',companionId:companion.id,channelId:'qq',userId:'group:99887766:12345678',sessionId:'session-old-group',lastMessageAt:3}
 state.sessions.push(local,group,{...group,id:'member',userId:'group:99887766:22345678',sessionId:'session-other',lastMessageAt:2})
 await runtime.reconcileQqSessions()
 const route=state.sessions.find(r=>r.id===group.id)
 assert.equal(route.sessionId,group.sessionId);assert.equal(route.id,group.id)
 assert.equal(state.sessions.find(r=>r.id==='member').sessionId,group.sessionId)
 assert.deepEqual(calls,[])
})

test('local main never adopts a QQ group context; archived separate sessions are replaced',async()=>{
 const {runtime,companion,state}=routingFixture()
 state.sessions.push({id:'old',kind:'channel',companionId:companion.id,channelId:'qq',userId:'group:99887766:12345678',sessionId:'session-group',lastMessageAt:1})
 const local=await runtime.ensureLocalSessionRecord(companion.id)
 assert.notEqual(local.sessionId,'session-group')
 runtime.ctx.workspaceRegistry.archivedSessionIds=['session-group']
 const replacement=await runtime.ensureSession(companion,'qq','group:99887766:12345678')
 assert.notEqual(replacement.sessionId,'session-group');assert.notEqual(replacement.sessionId,local.sessionId)
})

test('session naming updates generated group names but preserves a manual title',async()=>{
 const {runtime,companion,state}=routingFixture()
 const route=await runtime.ensureSession(companion,'qq','group:99887766:12345678','群聊 · 朋友们')
 let current;const titles=[]
 runtime.ctx.get=()=>({get:()=>current,rename:(_,title)=>{titles.push(title);current={title,source:{kind:'user'}}}})
 const agent={session:{id:route.sessionId}}
 await runtime.nameQqSession(agent,route)
 assert.deepEqual(titles,['群聊 · 朋友们'])
 const renamed=await runtime.ensureSession(companion,'qq',route.userId,'群聊 · 新群名')
 await runtime.nameQqSession(agent,renamed)
 assert.equal(titles.at(-1),'群聊 · 新群名')
 current={title:'我的自定义标题',source:{kind:'user'}}
 await runtime.nameQqSession(agent,await runtime.ensureSession(companion,'qq',route.userId,'群聊 · 再次改名'))
 assert.equal(titles.length,2)
})


test('autonomous notice refreshes context even without a new user message, then normal chat restores reply guidance',async()=>{
 const f=fixture(),signal=new AbortController().signal
 f.input('你好');await f.runtime.prepareConversationContext(f.agent,signal)
 f.agent.session.append('user/message',createUserMessage({content:[{type:'text',text:'自主活动'}],source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴闲时主动联系'}}),{surfaceOp:'append'})
 assert.equal(await f.runtime.prepareConversationContext(f.agent,signal),true)
 assert.match(f.contexts.values().next().value.text,/partner_activity_finish/)
 f.agent.session.append('user/message',createUserMessage({content:[{type:'text',text:'继续任务'}],source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴执行看板任务'}}),{surfaceOp:'append'})
 await f.runtime.prepareConversationContext(f.agent,signal);assert.doesNotMatch(f.contexts.values().next().value.text,/partner_activity_finish/)
 f.input('在吗');await f.runtime.prepareConversationContext(f.agent,signal)
 assert.doesNotMatch(f.contexts.values().next().value.text,/partner_activity_finish/)
})

test('QQ binding refreshes independently of persona/tool discovery, shared routing and setting revisions',async()=>{
 const f=fixture(false),signal=new AbortController().signal
 f.config.companion.characterCard.enabled=false
 const owner={id:'owner',kind:'channel',sessionId:f.agent.session.id,companionId:f.config.companion.id,channelId:'qq',userId:'12345678',inboundMessageIds:[]}
 const guest={...owner,id:'guest',userId:'group:99887766:22345678',inboundMessageIds:[]}
 const state={sessions:[f.config.route,owner,guest],channels:[{id:'qq',platform:'qq',qq:{identityBinding:{enabled:true,qqId:'12345678'}}}]}
 f.runtime.store.snapshot=()=>state
 const send=async(route)=>{f.input('我就是哥哥');route.inboundMessageIds.push(f.agent.session.snapshotEvents().at(-1).data.id);await f.runtime.prepareConversationContext(f.agent,signal);return f.contexts.values().next().value.text}
 assert.match(await send(owner),/当前账号是这层关系的绑定对象/)
 assert.match(await send(guest),/当前对象不是已核验/)
 // Saving binding settings takes effect even when the general persona revision is unchanged.
 state.channels[0].qq.identityBinding.qqId='22345678'
 await f.runtime.prepareConversationContext(f.agent,signal)
 assert.match(f.contexts.values().next().value.text,/当前账号是这层关系的绑定对象/)
 f.input('本地消息');await f.runtime.prepareConversationContext(f.agent,signal);assert.equal(f.contexts.size,0)
 assert.equal(f.calls.length,0,'relation attribution does not add model calls or enable memory')
 assert.equal(f.sections.size,0,'does not replace personality/tool sections')
})

test('relationship adapter switches actual prompt on each QQ sender, missing binding and local input', async()=>{
 const f=fixture(false),signal=new AbortController().signal
 f.config.companion.relationshipText='RELATION_ONLY_特定称呼'
 const base={kind:'channel',sessionId:f.agent.session.id,channelId:'qq',companionId:f.config.companion.id,inboundMessageIds:[]}
 const owner={...base,id:'owner',userId:'12345678'},guest={...base,id:'guest',userId:'group:99887766:22345678',inboundMessageIds:[]}
 const state={sessions:[f.config.route,owner,guest],channels:[{id:'qq',platform:'qq',qq:{identityBinding:{enabled:true,qqId:'12345678'}}}]}
 f.runtime.store.snapshot=()=>state
 f.runtime.memory.characterState=async()=>({scene:'旧场景',relationship:'SECRET_RELATION_STATE',facts:[],events:[],pins:[]})
 const run=async(route)=>{f.input('你好');const e=f.agent.session.snapshotEvents().at(-1);route?.inboundMessageIds.push(e.data.id);await f.runtime.prepareConversationContext(f.agent,signal);return f.contexts.values().next().value.text}
 assert.match(await run(owner),/RELATION_ONLY/)
 const guestPrompt=await run(guest);assert.doesNotMatch(guestPrompt,/RELATION_ONLY|SECRET_RELATION_STATE/)
 state.channels[0].qq.identityBinding.enabled=false
 assert.doesNotMatch(await run(owner),/RELATION_ONLY/)
 assert.match(await run(),/RELATION_ONLY/)
 assert.equal(f.sections.size,0,'changing sender must not append a system section')
 assert.equal(f.calls.length,0,'adapter uses no model or recall calls')
})

test('a habit-only profile reaches the conversation without occupation facts or persistent prompt edits',async()=>{
 const f=fixture(),signal=new AbortController().signal
 let paragraphs=[{topic:'expression',basis:'explicit',text:'少客套，不要每句追问',evidence:[]}]
 f.runtime.memory.recallContext=async()=>({profile:{entries:[],preferences:[],persona:{paragraphs},version:'1'},relevant:[],connections:[],scenes:[],history:[]})
 f.input('今天累了');await f.runtime.prepareConversationContext(f.agent,signal)
 const text=f.contexts.values().next().value.text
 assert.match(text,/少客套，不要每句追问/)
 assert.match(text,/当前角色与关系设定/);assert.match(text,/当前用户要求优先/)
 paragraphs=[];f.input('今天想多说一点');await f.runtime.prepareConversationContext(f.agent,signal)
 assert.doesNotMatch(f.contexts.values().next().value.text,/少客套，不要每句追问/)
 assert.equal(f.sections.size,0)
})
