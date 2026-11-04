import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'
import {PartnerConcernStore} from '../lib/concern-store.js'
import {ConcernExecutionDispatcher} from '../lib/concern-execution.js'
import {Readable} from 'node:stream'
import {registerPartnerApi} from '../lib/api.js'

test('explicit recovery immediately dispatches same receipt with reconciliation instructions, guards repeat clicks',async t=>{
 const root=await mkdtemp(join(tmpdir(),'concern-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(root,'state.json')),id=store.snapshot().companions[0].id,concerns=new PartnerConcernStore(root)
 await store.update(s=>s.sessions.push({id:'r',companionId:id,kind:'local',channelId:'@local',userId:'u',sessionId:'s',lastMessageAt:0}))
 const concern=await concerns.createExplicit(id,'@local:u','执行测试','',undefined,'只保存草稿，不发布')
 const result=await concerns.recordObservations([concern],[{concernId:concern.id,changed:false,executionNeeded:true,executionKey:'item|draft|1',event:'待办',evidence:'已核实',source:'source',relevance:1,confidence:1,actionability:1}],Date.now(),false)
 await store.update(s=>{s.concernExecutions=[{id:'receipt',companionId:id,concernId:concern.id,fingerprint:result.observations[0].fingerprint,sessionId:'s',messageId:'old-message',status:'failed',createdAt:1,updatedAt:2,error:'unknown'}]})
 let calls=0,prompt='',finish
 const dispatcher=new ConcernExecutionDispatcher(store,concerns,{executeConcern:async(r,c,p)=>{calls++;prompt=p;await new Promise(resolve=>finish=resolve)}})
 await assert.rejects(dispatcher.recover(id,concern.id,'receipt',1),/状态已变化/)
 await dispatcher.recover(id,concern.id,'receipt',2)
 assert.equal(calls,1)
 const receipt=store.snapshot().concernExecutions[0]
 assert.equal(receipt.id,'receipt');assert.notEqual(receipt.messageId,'old-message');assert.equal(receipt.recoveryFromMessageId,'old-message')
 assert.match(prompt,/先核对/);assert.match(prompt,/有副作用操作禁止重放/);assert.match(prompt,/只保存草稿，不发布/)
 await assert.rejects(dispatcher.recover(id,concern.id,'receipt',2),/已有执行/)
 assert.equal(store.snapshot().concernExecutions.length,1);assert.equal(store.snapshot().tasks.length,0)
 finish();await new Promise(r=>setTimeout(r,10))
 await assert.rejects(dispatcher.recover(id,concern.id,'receipt',receipt.updatedAt),/状态已变化/)
})

test('recovery UI exposes status, async lock, explicit version and no blind retry label',async()=>{
 const source=await readFile(new URL('../src/ui/memory/concern-execution-status.tsx',import.meta.url),'utf8')
 assert.match(source,/核对产物并恢复/);assert.match(source,/expectedUpdatedAt/);assert.match(source,/lock\.current/)
 assert.match(source,/role="alert"/);assert.match(source,/disabled=\{disabled\|\|busy\}/)
 const heartbeat=await readFile(new URL('../src/heartbeat.ts',import.meta.url),'utf8')
 assert.match(heartbeat,/await this\.recordActivity\(companion, route, execution, partialError[^\n]*\n\s*await this\.executionDispatcher\?\.\(companion\.id\)/)
 assert.match(heartbeat,/await this\.recordActivity\(companion, route, execution, 'notified'[^\n]*\n\s*await this\.executionDispatcher\?\.\(companion\.id\)/)
})

test('recovery API requires mutation header and exact receipt version, propagates conflicts',async t=>{
 const root=await mkdtemp(join(tmpdir(),'concern-recovery-api-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(root,'state.json')),id=store.snapshot().companions[0].id
 let handler,conflict=false;const calls=[]
 registerPartnerApi({register:route=>{handler=route.handler;return()=>{}}},'/api',{store,connection:{requestRejection:()=>undefined},concernExecution:{recover:async(...args)=>{calls.push(args);if(conflict)throw new Error('执行状态已变化，请刷新后再试')}}})
 const call=async(body,headers={'x-dsh-partner-request':'1'})=>{
   const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method:'POST',url:`/api/companions/${id}/concerns/c/retry-execution`,headers})
   const res={statusCode:0,setHeader(){},end(data){this.body=data?JSON.parse(data):undefined}}
   await handler(req,res);return res
 }
 const body={mode:'recover',executionId:'receipt',expectedUpdatedAt:2}
 assert.equal((await call(body,{})).statusCode,403)
 for(const expectedUpdatedAt of [undefined,null,'2',2.5])assert.equal((await call({...body,expectedUpdatedAt})).statusCode,400)
 assert.equal(calls.length,0)
 assert.equal((await call(body)).statusCode,202)
 assert.deepEqual(calls,[[id,'c','receipt',2]])
 conflict=true;assert.equal((await call(body)).statusCode,409)
})

test('stopped concerns cannot be recovered or alter persisted receipts',async()=>{
 const receipt={id:'r',status:'failed',updatedAt:2}
 let updates=0
 const dispatcher=new ConcernExecutionDispatcher({snapshot:()=>({concernExecutions:[receipt]}),update:async()=>updates++},{list:async()=>[{id:'c',executionInstructions:'保存草稿',state:'watching',control:'stopped'}]}, {executeConcern:async()=>assert.fail('must not execute')})
 await assert.rejects(dispatcher.recover('p','c','r',2),/关注已停止/)
 assert.equal(updates,0);assert.equal(receipt.status,'failed')
})
