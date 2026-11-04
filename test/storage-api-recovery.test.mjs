import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { StorageCoordinator } from '../lib/storage/coordinator.js'
import { registerPartnerApi } from '../lib/api.js'
import { readStorageConfig } from '../lib/storage/bootstrap.js'

test('migration POST is accepted without waiting; status remains readable while gated and after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'storage-api-')),statePath=join(root,'state.json'),store=await PartnerStore.open(statePath)
 let proceed,finish,restarts=0;const paused=new Promise(r=>proceed=r),finished=new Promise(r=>finish=r)
 const runtime={store,connection:{requestRejection:()=>undefined}}
 const ports={busy:()=>false,snapshot:()=>store.snapshot(),quiesce:async()=>{await paused;await store.freeze()},report:error=>finish(error),restart:async()=>{restarts++;runtime.storage=new StorageCoordinator(statePath,root,1,ports);finish()}}
 runtime.storage=new StorageCoordinator(statePath,root,0,ports)
 let handler;registerPartnerApi({register:r=>{handler=r.handler;return()=>{}}},'/api',runtime)
 const call=async(method,path,body={})=>{
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method,url:'/api'+path,headers:{'x-dsh-partner-request':'1'}})
  const res={setHeader(){},end(data){this.body=JSON.parse(data)}};await handler(req,res);return res
 }
 try{
  assert.equal((await call('POST','/storage/migrate',{confirm:true,expectedVersion:0})).statusCode,202)
  const during=await call('GET','/storage/status');assert.equal(during.statusCode,200);assert.equal(during.body.running,true)
  assert.equal((await call('POST','/storage/migrate',{confirm:true,expectedVersion:0})).statusCode,503)
  proceed();const error=await finished;if(error)throw error
  const after=await call('GET','/storage/status');assert.equal(after.body.currentVersion,1);assert.equal(after.body.running,false);assert.equal(after.body.cleanupPending,0)
  assert.equal((await readStorageConfig(statePath,root)).storageVersion,1);assert.equal(restarts,1)
 }finally{proceed();await rm(root,{recursive:true,force:true})}
})
