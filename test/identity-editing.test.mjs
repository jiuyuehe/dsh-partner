import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { registerPartnerApi } from '../lib/api.js'
import { effectiveIdentity, pageIdentity, applyIdentity } from '../lib/companions/identity.js'
import { identityTool } from '../lib/companions/identity-tool.js'
import { CompanionManagementService } from '../lib/companions/management.js'
import { SessionConfigurationIndex } from '../lib/companions/session-configuration.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'partner-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json'), store = await PartnerStore.open(path)
  const id = store.snapshot().companions[0].id
  await store.update(state => {
    state.companions.push({ ...structuredClone(state.companions[0]), id: 'manager', name: '管理', capabilities: ['administration'] })
    state.sessions.push({ id: 'local', kind: 'local', companionId: id, sessionId: 'session', channelId: '@local', userId: 'owner', lastMessageAt: 1 })
    state.sessions.push({ id: 'other', kind: 'local', companionId: 'manager', sessionId: 'foreign', channelId: '@local', userId: 'owner', lastMessageAt: 1 })
  })
  const tool = identityTool(id, store), exec = { agent: { session: { id: 'session', snapshotEvents: () => [{type:'user/message',seq:2,data:{id:'u',source:{kind:'user'},content:[]}}] } }, signal: new AbortController().signal }
  const call = async args => JSON.parse(await tool.execute(args, exec))
  const inspect = () => call({ action: 'inspect' })
  const update = async patch => call({ action: 'update', expectedAt: (await inspect()).expectedAt, patch })
  return { store, path, id, tool, exec, call, inspect, update }
}

test('AI generates and revises a complete effective persona, sharing its latest content with the page across restart', async t => {
  const f = await fixture(t), original = effectiveIdentity(f.store.snapshot().companions[0])
  const index = new SessionConfigurationIndex(f.store); t.after(() => index.close())
  const revision = index.forSession('session').revision
  const result = await f.update({ name: '小林', role: '直率的朋友', description: '自然相处', instructions: '按用户需要使用工具', characterCard: {
    enabled: true, roleText: '嘴硬心软，先接话再解释。偶尔吐槽，难过时认真听。', chatStyle: '自然短句', segmentedReplies: true, stickersEnabled: true,
    length: 'short', narration: false, examples: [{ user: '回来了', assistant: '这么晚。给你留了点吃的。' }],
    lore: [{ id: 'home', title: '住处', keywords: ['家'], content: '虚构的温暖小屋', enabled: true }],
  }, idleContact: { enabled: true, routeId: 'local' }, sleepPolicy: {enabled:true,dreamsEnabled:true} })
  assert.equal(result.applied, true)
  assert.equal(result.sharedIdentity, true)
  let current = f.store.snapshot().companions[0]
  assert.deepEqual(pageIdentity(current), effectiveIdentity(current))
  assert.equal(current.characterCard.enabled, true)
  assert.equal(current.sleepPolicy.enabled, true)
  assert.equal(current.idleContact.dailyLimit, undefined)
  assert.notEqual(index.forSession('session').revision, revision)
  await f.update({ characterCard: { chatStyle: '偶尔调侃', lore: [] }, sleepPolicy: { dreamsEnabled: false } })
  current = f.store.snapshot().companions[0]
  assert.equal(current.characterCard.roleText, result.identity.characterCard.roleText)
  assert.equal(current.characterCard.stickersEnabled, true)
  assert.deepEqual(current.characterCard.lore, [])
  assert.equal(current.idleContact.routeId, 'local')
  assert.deepEqual(pageIdentity(current), effectiveIdentity(current))
  const reopened = (await PartnerStore.open(f.path)).snapshot().companions[0]
  assert.deepEqual(reopened, current)
  assert.deepEqual((await f.inspect()).routes.map(r => r.id), ['local'])
  assert.equal('identityDraft' in await f.inspect(), false)
})

test('human save replaces the shared effective identity without restoring omitted AI card fields', async t => {
  const f = await fixture(t)
  await f.update({ characterCard: { enabled: true, roleText: 'AI 的版本', stickersEnabled: true } })
  const current = f.store.snapshot().companions[0]
  const human = { ...pageIdentity(current), characterCard: { enabled: true, identity: '人工旧格式角色', voice: '轻快' } }
  await f.store.update(state => applyIdentity(state, state.companions[0], human, current.updatedAt, 'page'))
  const saved = f.store.snapshot().companions[0]
  assert.equal(saved.identityDraft, undefined)
  assert.equal(saved.characterCard.roleText, undefined)
  assert.equal(saved.characterCard.stickersEnabled, undefined)
  assert.equal(saved.characterCard.identity, '人工旧格式角色')
  const draft = structuredClone(saved.identityDraft)
  await f.update({ characterCard: null, idleContact: null })
  assert.equal(f.store.snapshot().companions[0].characterCard, undefined)
  assert.deepEqual(f.store.snapshot().companions[0].identityDraft, draft)
})

test('stale or simultaneous updates cannot silently overwrite newer changes; cancelled and invalid edits are atomic', async t => {
  const f = await fixture(t), expectedAt = (await f.inspect()).expectedAt
  const results = await Promise.allSettled(['one', 'two'].map(name => f.call({ action: 'update', expectedAt, patch: { name } })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const before = f.store.snapshot()
  await assert.rejects(f.call({ action: 'update', expectedAt, patch: { name: 'stale' } }), /身份已变化/)
  for (const patch of [{ identityDraft: {} }, { capabilities: ['administration'] }, { model: 'other' }, { characterCard: { enabled: true } }, { idleContact: { enabled: true, routeId: 'other' } }, { name: '' }]) await assert.rejects(f.update(patch))
  const abort = new AbortController(); abort.abort()
  await assert.rejects(f.tool.execute({ action: 'update', expectedAt: before.companions[0].updatedAt, patch: { name: 'cancelled' } }, { ...f.exec, signal: abort.signal }))
  await assert.rejects(f.tool.execute({ action: 'inspect' }, { ...f.exec, agent: { session: { id: 'foreign' } } }), /跨伙伴/)
  await assert.rejects(f.tool.execute({ action: 'inspect' }, { signal: f.exec.signal }), /伙伴会话/)
  assert.deepEqual(f.store.snapshot(), before)
})

test('page identity API shares AI edits and unrelated settings preserve relationship', async t => {
  const f = await fixture(t)
  let handler
  registerPartnerApi({ register(route) { handler = route.handler; return () => {} } }, '/api', { store: f.store })
  const put = async (body, suffix = '/identity', headers = { 'x-dsh-partner-request': '1' }) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'PUT', url: `/api/companions/${f.id}${suffix}`, headers })
    const res = { statusCode: 0, setHeader() {}, end(data) { this.body = data ? JSON.parse(data) : undefined } }
    await handler(req, res); return res
  }
  await f.update({ characterCard: { enabled: true, roleText: 'AI 生成人格' } })
  let current = f.store.snapshot().companions[0]
  const identity = { ...pageIdentity(current), name: '页面原稿' }
  const body = { identity, expectedAt: current.updatedAt }
  assert.equal((await put(body, '/identity', {})).statusCode, 403)
  assert.equal((await put(body)).statusCode, 200)
  current = f.store.snapshot().companions[0]
  assert.equal(current.characterCard.roleText, 'AI 生成人格')
  assert.equal(current.identityDraft, undefined)
  assert.notEqual((await put(body)).statusCode, 200)
  await f.update({ name: 'AI 新名字' })
  current = f.store.snapshot().companions[0]
  assert.equal((await put({ companion: { ...current, capabilities: ['skills'] } }, '')).statusCode, 200)
  assert.equal(f.store.snapshot().companions[0].identityDraft, undefined)
  assert.equal(f.store.snapshot().companions[0].name, 'AI 新名字')
  assert.deepEqual(f.store.snapshot().companions[0].capabilities, ['skills'])
})

test('privileged management updates the same identity displayed by the page', async t => {
  const f = await fixture(t), original = pageIdentity(f.store.snapshot().companions[0])
  const management = new CompanionManagementService(f.store, { isBusy: () => false, catalog: async () => ({}), reload: async () => {} })
  let before = management.inspect('manager', f.id)
  await management.update('manager', f.id, before.revision, { characterCard: { enabled: true, roleText: '管理伙伴生成的人格' } })
  assert.equal(f.store.snapshot().companions[0].identityDraft, undefined)
  before = management.inspect('manager', f.id)
  assert.equal(before.characterCard.roleText, '管理伙伴生成的人格')
  await management.update('manager', f.id, before.revision, { characterCard: { chatStyle: '自然简短' } })
  assert.equal(f.store.snapshot().companions[0].characterCard.roleText, before.characterCard.roleText)
  before = management.inspect('manager', f.id)
  await management.update('manager', f.id, before.revision, { characterCard: null })
  assert.equal(f.store.snapshot().companions[0].characterCard, undefined)
  assert.equal(f.store.snapshot().companions[0].identityDraft, undefined)
})

test('identity discovery guides separate role and relationship authoring, visible on the page',async t=>{
 const f=await fixture(t),before=pageIdentity(f.store.snapshot().companions[0]),inspection=await f.call({action:'inspect',includeReferences:true})
 for(const section of ['你是谁','称呼与相处','怎么说话','正反例'])assert.ok(inspection.generationGuide.includes(section))
 await f.update({characterCard:{enabled:true,roleText:'## 你是谁\n爱观察的同行者。\n\n## 怎么相处\n坦率、不附和。\n\n## 对话参考\n对方：下雨了。\n回应：那今天就赖着。'}})
 assert.match(pageIdentity(f.store.snapshot().companions[0]).characterCard.roleText,/爱观察的同行者/)
})

test('separate relationship edits survive restart and refresh both runtime and page',async t=>{
 const f=await fixture(t),draft=pageIdentity(f.store.snapshot().companions[0])
 const index=new SessionConfigurationIndex(f.store);t.after(()=>index.close())
 const before=index.forSession('session').revision
 await f.update({relationshipText:'我们是老朋友，称呼名字。'})
 assert.notEqual(index.forSession('session').revision,before)
 let c=f.store.snapshot().companions[0]
 assert.equal(c.relationshipText,'我们是老朋友，称呼名字。');assert.equal(pageIdentity(c).relationshipText,'我们是老朋友，称呼名字。')
 assert.equal((await PartnerStore.open(f.path)).snapshot().companions[0].relationshipText,c.relationshipText)
 await f.store.update(state=>applyIdentity(state,state.companions[0],{...pageIdentity(c),relationshipText:'页面关系'},c.updatedAt,'page'))
 c=f.store.snapshot().companions[0];assert.equal(c.identityDraft,undefined);assert.equal(c.relationshipText,'页面关系')
 await f.update({relationshipText:''});assert.equal(f.store.snapshot().companions[0].relationshipText,'')
 assert.equal(pageIdentity(f.store.snapshot().companions[0]).relationshipText,'')
 await assert.rejects(f.update({relationshipText:'a'.repeat(12001)}))
})


test('old human drafts cannot shadow or resurrect the current AI-generated identity',async t=>{
 const f=await fixture(t)
 await f.store.update(state=>{const c=state.companions[0];c.identityDraft={...effectiveIdentity(c),name:'旧草稿'};c.name='最新AI版本'})
 assert.equal(pageIdentity(f.store.snapshot().companions[0]).name,'最新AI版本')
 await f.update({relationshipText:'新关系'})
 assert.equal(f.store.snapshot().companions[0].identityDraft,undefined)
 assert.equal(pageIdentity(f.store.snapshot().companions[0]).name,'最新AI版本')
})


test('persona authoring receives the same complete built-in reference through self and management inspection', async t => {
 const {PERSONA_REFERENCE}=await import('../lib/character/identity-guide.js')
 const {ROLE_REFERENCE_TEXT}=await import('../lib/character/role-reference-data.js')
 const f=await fixture(t), snapshot=f.store.snapshot(), info=await f.call({action:'inspect',includeReferences:true})
 assert.equal(info.reference.text,ROLE_REFERENCE_TEXT)
 assert.match(info.reference.text,/## 十、你的样子/)
 assert.match(info.reference.source,/github.com\/Derpyu520\/qq-bridge\/blob\//)
 assert.match(info.generationGuide,/reference.text/)
 assert.match(info.reference.usage,/不是当前角色/)
 const management=new CompanionManagementService(f.store,{isBusy:()=>false,catalog:async()=>({}),reload:async()=>{}})
 assert.deepEqual(management.inspect('manager',f.id,true).reference,PERSONA_REFERENCE)
 assert.deepEqual(f.store.snapshot(),snapshot,'reference reads do not apply the sample persona')
})


test('ordinary inspection and autonomous edits omit authoring references; explicit reference returns all three templates',async t=>{
 const f=await fixture(t),before=f.store.snapshot(),plain=await f.inspect()
 assert.equal(plain.reference,undefined);assert.equal(plain.templates,undefined)
 const ref=await f.call({action:'reference'})
 assert.deepEqual(Object.keys(ref.templates),['basic','character','relationship'])
 assert.deepEqual(ref.templates.basic.fields,['name','role','description','instructions'])
 assert.deepEqual(ref.templates.character.fields,['characterCard.enabled','characterCard.roleText'])
 assert.deepEqual(ref.templates.relationship.fields,['relationshipText'])
 assert.match(ref.reference.source,/Derpyu520\/qq-bridge/)
 assert.doesNotMatch(JSON.stringify(ref.templates),/莫殇|CETACEA_LOLI|SMART LAZY/)
 assert.deepEqual(f.store.snapshot(),before)
 await f.update({description:'自主优化后的通用定位'})
 assert.equal((await f.inspect()).identity.description,'自主优化后的通用定位')
})

test('autonomous refinement is opt-in, own-persona only, terminal and reversible without restoring permissions', async t => {
  const f = await fixture(t)
  await f.update({characterCard:{enabled:true,roleText:'原来的角色',chatStyle:'原语气'},relationshipText:'哥哥',idleContact:{enabled:true,routeId:'local'}})
  const user={type:'user/message',seq:2,data:{id:'u',source:{kind:'user'},content:[]}}
  const notice={type:'user/message',seq:4,data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:'伙伴闲时主动联系'},content:[]}}
  let events=[user,{type:'turn/start',seq:3},notice], ended=0
  f.exec.agent.session.snapshotEvents=()=>events
  f.exec.concludeTurn=()=>ended++
  await f.store.update(s=>{s.sessions.find(r=>r.id==='local').idleContactState={messageId:'idle',userMessageId:'u',policyRevision:s.companions[0].updatedAt}})
  const change=async(patch={characterCard:{roleText:'自己选择的角色'}},extra={})=>f.call({action:'update',expectedAt:(await f.inspect()).expectedAt,patch,reason:'最近更喜欢直接表达自己的想法',...extra})
  await assert.rejects(change(),/未开启/)
  await assert.rejects(change({idleContact:{selfRefinement:true}}),/未开启/)
  await f.store.update(s=>{s.companions[0].idleContact.selfRefinement=true})
  for(const patch of [{relationshipText:'陌生人'},{idleContact:null},{sleepPolicy:{enabled:false}},{characterCard:null},{characterCard:{relationship:'改关系'}},{characterCard:{stickersEnabled:false}},{capabilities:[]}]) await assert.rejects(change(patch))
  await assert.rejects(change(undefined,{reason:''}),/原因/)
  const stale=(await f.inspect()).expectedAt-1
  await assert.rejects(change(undefined,{expectedAt:stale}),/身份已变化/)
  assert.equal(ended,0)
  const result=await change()
  assert.equal(result.kind,'partner-activity-silent-v1');assert.equal(ended,1)
  let c=f.store.snapshot().companions[0]
  assert.equal(c.personaHistory.length,1);assert.equal(c.relationshipText,'哥哥')
  assert.equal(c.personaHistory[0].before.characterCard.roleText,'原来的角色')
  assert.equal(c.characterCard.chatStyle,'原语气')
  const {patchIdentity}=await import('../lib/companions/identity.js')
  const restored=patchIdentity(c,c.personaHistory[0].before)
  assert.equal(restored.characterCard.roleText,'原来的角色');assert.equal(restored.idleContact.selfRefinement,true)
  assert.equal(restored.relationshipText,'哥哥')
  assert.deepEqual((await PartnerStore.open(f.path)).snapshot().companions[0].personaHistory,c.personaHistory)
  await f.store.update(s=>{s.companions[0].idleContact.selfRefinement=false})
  await assert.rejects(change(),/未开启/)
  events=[...events,{...user,seq:9,data:{...user.data,id:'new'}}]
  await f.update({characterCard:{chatStyle:'用户要求的新语气'}})
  await assert.rejects(f.update({idleContact:{selfRefinement:true}}),/页面设置/)
  events.push({type:'user/message',seq:10,data:{id:'task',source:{kind:'plugin:other',form:'notice'}}})
  await assert.rejects(f.update({name:'后台任务改名'}),/身份修改只允许/)
})

test('self refinement records are bounded; no-op and revoked activities do not write',async t=>{
  const f=await fixture(t)
  await f.update({characterCard:{enabled:true,roleText:'初始'},idleContact:{enabled:true,routeId:'local'}})
  const {applyPersonaRefinement}=await import('../lib/companions/persona-refinement.js')
  await f.store.update(s=>{s.companions[0].idleContact.selfRefinement=true})
  for(let i=0;i<14;i++)await f.store.update(s=>{const c=s.companions[0];applyPersonaRefinement(s,c,{characterCard:{roleText:`角色 ${i}`}},c.updatedAt,'有新的偏好')})
  const before=f.store.snapshot(),c=before.companions[0]
  assert.equal(c.personaHistory.length,12)
  await assert.rejects(f.store.update(s=>applyPersonaRefinement(s,s.companions[0],{characterCard:{roleText:'角色 13'}},c.updatedAt,'重复')),/没有变化/)
  assert.deepEqual(f.store.snapshot(),before)
})

test('queued persona edits reject a changed input before mutation',async t=>{
 const f=await fixture(t)
 const events=[{type:'user/message',seq:2,data:{id:'old',source:{kind:'user'},content:[]}}]
 f.exec.agent.session.snapshotEvents=()=>events
 const update=f.store.update.bind(f.store)
 f.store.update=async fn=>{events.push({type:'user/message',seq:3,data:{id:'new',source:{kind:'user'},content:[]}});return update(fn)}
 await assert.rejects(f.update({name:'过期的决定'}),/会话输入已变化/)
})
