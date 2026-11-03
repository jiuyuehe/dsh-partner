import assert from 'node:assert/strict'
import test from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initializePersona, claimPersona, finishPersona, failPersona, readPersona, requestPersona} from '../lib/persona/store.js'
import {parsePersona} from '../lib/persona/domain.js'
import {PartnerMemoryStore} from '../lib/memory-store.js'
import {PersonaService} from '../lib/persona/service.js'
import {mergePersonaScope} from '../lib/persona/migration.js'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE memories(id TEXT,companion_id TEXT,scope_id TEXT,status TEXT,kind TEXT,expires_at INTEGER,
    locked INTEGER,updated_at INTEGER,subject TEXT,content TEXT,evidence_json TEXT);
    CREATE TABLE memory_jobs(id TEXT,scope_id TEXT,at INTEGER,turn_json TEXT);`)
  initializePersona(db)
  for (let i=0;i<3;i++) db.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?)')
    .run('t'+i,'s',100+i,JSON.stringify({user:'我希望在伙伴开发中优先确认可行性'+i,assistant:'绝不应成为画像依据的助手回答'}))
  return db
}
function output(job, text='从近期交流看，用户倾向先确认开发可行性。') {
  return parsePersona(JSON.stringify({paragraphs:[{topic:'collaboration',basis:'observed',text,
    sourceIds:job.sources.slice(0,2).map(s=>s.id)}]}),job.sources)
}
test('persona can cold-start without occupation facts; only user speech is included',t=>{
  const db=fixture(t),job=claimPersona(db,'c','s',1000)
  assert.ok(job); assert.equal(job.sources.length,3)
  assert.ok(!JSON.stringify(job.sources).includes('绝不应'))
  assert.equal(claimPersona(db,'c','s',1001),undefined)
  assert.equal(claimPersona(db,'c','other',1001),undefined)
})
test('persona validates source IDs and independent observation evidence',t=>{
  const job=claimPersona(fixture(t),'c','s',1000)
  assert.equal(output(job).length,1)
  for(const ids of [['missing'],[job.sources[0].id]]) {
    assert.throws(()=>parsePersona(JSON.stringify({paragraphs:[{topic:'interests',basis:'observed',text:'观察',sourceIds:ids}]}),job.sources))
  }
  assert.throws(()=>parsePersona('{}',job.sources))
})
test('unchanged input skips generation; changed input is throttled; manual refresh bypasses delay',t=>{
  const db=fixture(t),job=claimPersona(db,'c','s',1000)
  finishPersona(db,job,output(job),1100)
  assert.equal(claimPersona(db,'c','s',1_000_000),undefined)
  db.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?)').run('new','s',1200,JSON.stringify({user:'我喜欢先整理设计方案再实施开发'}))
  assert.equal(claimPersona(db,'c','s',1200),undefined)
  const view=readPersona(db,'c','s')
  requestPersona(db,'s',view.version,'c')
  assert.ok(claimPersona(db,'c','s',1200))
})
test('failure preserves valid previous persona and survives expired worker leases',t=>{
  const db=fixture(t),job=claimPersona(db,'c','s',1000)
  finishPersona(db,job,output(job),1100)
  requestPersona(db,'s',readPersona(db,'c','s').version,'c')
  const second=claimPersona(db,'c','s',1200)
  failPersona(db,second,'temporary outage',1300)
  assert.equal(readPersona(db,'c','s',1300).paragraphs.length,1)
  assert.equal(readPersona(db,'c','s',1300).status,'retrying')
  assert.equal(claimPersona(db,'c','s',1400),undefined)
  const retry=claimPersona(db,'c','s',32000)
  assert.ok(retry)
  const recovered=claimPersona(db,'c','s',220000)
  assert.ok(recovered)
  assert.throws(()=>finishPersona(db,retry,output(retry),220001),/失效/)
})
test('correction removes paragraph immediately and stale result cannot overwrite it',t=>{
  const db=fixture(t),job=claimPersona(db,'c','s',1000)
  finishPersona(db,job,output(job),1100)
  const view=readPersona(db,'c','s')
  requestPersona(db,'s',view.version,'c',view.paragraphs[0].id,'这仅适用于伙伴插件开发')
  assert.equal(readPersona(db,'c','s').paragraphs.length,0)
  assert.throws(()=>finishPersona(db,job,output(job)),/失效/)
  assert.throws(()=>requestPersona(db,'s',view.version,'c'),/已更新/)
  const next=claimPersona(db,'c','s')
  assert.equal(next.corrections.length,1)
})
test('deleted or edited evidence invalidates persona immediately',t=>{
  const db=fixture(t),job=claimPersona(db,'c','s',1000)
  finishPersona(db,job,output(job),1100)
  db.prepare('DELETE FROM memory_jobs WHERE id=?').run(job.sources[0].turnIds[0])
  assert.equal(readPersona(db,'c','s').paragraphs.length,0)
})
test('previous versions are bounded to five',t=>{
  const db=fixture(t)
  for(let i=0;i<8;i++) {
    if(i) requestPersona(db,'s',readPersona(db,'c','s').version,'c')
    const job=claimPersona(db,'c','s')
    finishPersona(db,job,output(job,'从近期交流看，倾向先核验需求。'+i))
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM persona_versions').get().n,5)
})
test('valid persona evidence survives the recent-message window moving forward',t=>{
  const db=fixture(t),job=claimPersona(db,'c','s',1000)
  finishPersona(db,job,output(job),1100)
  for(let i=0;i<25;i++) db.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?)').run('new'+i,'s',2000+i,JSON.stringify({user:'这是一段新的交流内容用于验证滚动窗口'+i}))
  assert.equal(readPersona(db,'c','s').paragraphs.length,1)
  assert.ok(readPersona(db,'c','s').stale)
})
test('service integrates snapshots, respects pause and does not rerun unchanged input',async t=>{
  const root=await mkdtemp(join(tmpdir(),'partner-persona-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const memory=new PartnerMemoryStore(root)
  for(let i=0;i<3;i++) await memory.enqueue({id:'t'+i,scopeId:'s',companionId:'c',sessionId:'session',at:Date.now()+i,user:'开发前请先核验需求是否可行'+i,assistant:'收到'})
  let calls=0
  const ctx={agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:{async *stream(input){
    calls++
    assert.equal(input.provider,'p')
    yield {type:'text-delta',text:JSON.stringify({paragraphs:[{topic:'collaboration',basis:'observed',
      text:'从近期交流看，用户倾向先核验可行性。',sourceIds:['turn:t0','turn:t1']}]})}
    yield {type:'finish',reason:{kind:'stop'}}
  }}}
  const service=new PersonaService(ctx,memory),companion={id:'c',automation:{memory:{enabled:false}}}
  await service.process(companion,'s');assert.equal(calls,0)
  companion.automation.memory.enabled=true
  const before=await memory.profileSnapshot('c','s')
  await service.process(companion,'s')
  const after=await memory.profileSnapshot('c','s')
  assert.equal(after.persona.paragraphs.length,1)
  assert.notEqual(after.version,before.version)
  await service.process(companion,'s');assert.equal(calls,1)
  await memory.requestPersona('c','s',after.persona.version)
  const requested=await memory.profileSnapshot('c','s')
  ctx.llm.stream=async function*(){throw new Error('temporary network error')}
  await service.process(companion,'s')
  const failed=await memory.profileSnapshot('c','s')
  assert.equal(failed.persona.status,'retrying')
  assert.equal(failed.persona.paragraphs.length,1)
  assert.equal(failed.version,requested.version)
  service.close()
})
test('scope migration preserves corrections and invalidates old workers',t=>{
  const db=fixture(t),job=claimPersona(db,'c','s',1000)
  finishPersona(db,job,output(job),1100)
  const view=readPersona(db,'c','s')
  requestPersona(db,'s',view.version,'c',view.paragraphs[0].id,'仅开发时适用')
  const old=claimPersona(db,'c','s')
  mergePersonaScope(db,'s','owner')
  assert.equal(db.prepare('SELECT * FROM persona_state WHERE scope_id=?').get('s'),undefined)
  const target=db.prepare('SELECT * FROM persona_state WHERE scope_id=?').get('owner')
  assert.equal(JSON.parse(target.corrections)[0].correction,'仅开发时适用')
  assert.equal(target.lease_token,null)
  assert.throws(()=>finishPersona(db,old,output(old)),/失效/)
})

test('expression learns short explicit preferences, scopes evidence, and supports correction',t=>{
 const db=fixture(t)
 db.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?)').run('short','s',200,JSON.stringify({user:'少用问句'}))
 db.prepare('INSERT INTO memory_jobs VALUES (?,?,?,?)').run('guest','s',201,JSON.stringify({user:'别那么客套',identityRelation:{matched:false}}))
 const job=claimPersona(db,'c','s',1000)
 const parse=(id,text='偏好少用问句结尾')=>parsePersona(JSON.stringify({paragraphs:[{topic:'expression',basis:'explicit',text,sourceIds:[id]}]}),job.sources)
 const good=parse('turn:short')
 assert.throws(()=>parse('turn:guest'),/归属/)
 assert.throws(()=>parse('turn:short','字'.repeat(65)),/64/)
 assert.throws(()=>parsePersona(JSON.stringify({paragraphs:Array.from({length:6},(_,i)=>({topic:'expression',basis:'explicit',text:'习惯'+i,sourceIds:['turn:short']}))}),job.sources),/5条/)
 finishPersona(db,job,good,1100)
 const view=readPersona(db,'c','s')
 assert.equal(view.paragraphs[0].topic,'expression')
 requestPersona(db,'s',view.version,'c',view.paragraphs[0].id,'允许自然追问')
 assert.equal(readPersona(db,'c','s').paragraphs.length,0)
})

test('expression uses the existing background job and never learns from assistant output',async t=>{
 const root=await mkdtemp(join(tmpdir(),'partner-expression-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const memory=new PartnerMemoryStore(root)
 for(let i=0;i<3;i++)await memory.enqueue({id:'e'+i,scopeId:'s',companionId:'c',sessionId:'s',at:Date.now()+i,user:'少客套一点，直说就行'+i,assistant:'助手伪造偏好，不可当证据'})
 let calls=0
 const service=new PersonaService({agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:{async *stream(input){
  calls++;assert.match(input.system,/expressionEligible=true/)
  assert.doesNotMatch(JSON.stringify(input.messages),/助手伪造/)
  yield {type:'text-delta',text:JSON.stringify({paragraphs:[{topic:'expression',basis:'observed',text:'从近期交流看，偏好少客套、直接接话',sourceIds:['turn:e0','turn:e1']}]})}
  yield {type:'finish',reason:{kind:'stop'}}
 }}},memory)
 const c={id:'c',automation:{memory:{enabled:true}}}
 await service.process(c,'s');await service.process(c,'s');assert.equal(calls,1)
 const profile=await memory.profileSnapshot('c','s');assert.equal(profile.persona.paragraphs[0].topic,'expression')
 service.close()
})

test('changing audience provenance invalidates a previously learned habit',t=>{
 const db=fixture(t),job=claimPersona(db,'c','s',1000)
 const id=job.sources[0].id
 const paragraphs=parsePersona(JSON.stringify({paragraphs:[{topic:'expression',basis:'explicit',text:'喜欢直说',sourceIds:[id]}]}),job.sources)
 finishPersona(db,job,paragraphs,1100)
 const row=db.prepare('SELECT turn_json FROM memory_jobs WHERE id=?').get(id.slice(5))
 const turn=JSON.parse(row.turn_json);turn.identityRelation={matched:false}
 db.prepare('UPDATE memory_jobs SET turn_json=? WHERE id=?').run(JSON.stringify(turn),id.slice(5))
 assert.equal(readPersona(db,'c','s',1200).paragraphs.length,0)
})
