import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'

test('schema 15 Mattermost batch state stays versioned and intact in the P2 runtime',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'partner-schema-forward-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const path=join(dir,'state.json')
 await PartnerStore.open(path)
 const original=JSON.parse(await readFile(path,'utf8'))
 const batches=[{id:'completed-batch',status:'completed',sourcePostIds:['post-1']}]
 await writeFile(path,JSON.stringify({...original,schemaVersion:15,mattermostBatches:batches},null,2))

 const store=await PartnerStore.open(path)
 assert.equal(store.snapshot().schemaVersion,15)
 await store.update(state=>{state.skillMarketNetwork.proxyUrl='http://proxy.local'})
 const persisted=JSON.parse(await readFile(path,'utf8'))
 assert.equal(persisted.schemaVersion,15)
 assert.deepEqual(persisted.mattermostBatches,batches)
 assert.equal(persisted.skillMarketNetwork.proxyUrl,'http://proxy.local')
})

test('unknown future state schemas remain rejected',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'partner-schema-unknown-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const path=join(dir,'state.json')
 await PartnerStore.open(path)
 const original=JSON.parse(await readFile(path,'utf8'))
 await writeFile(path,JSON.stringify({...original,schemaVersion:16,mattermostBatches:[]}))
 await assert.rejects(PartnerStore.open(path),/unsupported partner state schema/)
})
