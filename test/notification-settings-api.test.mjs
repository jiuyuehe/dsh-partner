import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'
import {registerPartnerApi} from '../lib/api.js'

test('notification API validates ownership/approval and identity edits preserve configuration',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'notification-api-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const store=await PartnerStore.open(join(dir,'state.json')),id=store.snapshot().companions[0].id
  await store.update(state=>{
    state.channels.push({id:'a',companionId:id,enabled:true},{id:'foreign',companionId:'another',enabled:true})
    state.pairings.push({id:'p',channelId:'a',userId:'u',status:'approved'},{id:'q',channelId:'foreign',userId:'x',status:'approved'},{id:'blocked',channelId:'a',userId:'b',status:'blocked'})
  })
  let handler
  registerPartnerApi({register:route=>{handler=route.handler;return()=>{}}},'/api',{store,connection:{requestRejection:()=>undefined}})
  const call=async(body,path=`/api/companions/${id}/notifications`,headers={'x-dsh-partner-request':'1'})=>{
    const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method:'PUT',url:path,headers})
    const res={statusCode:0,setHeader(){},end(data){this.body=data?JSON.parse(data):undefined}}
    await handler(req,res);return res
  }
  assert.equal((await call({mode:'selected',targetPairingIds:['p']},undefined,{})).statusCode,403)
  for(const targetPairingIds of [[],['q'],['blocked'],['missing'],[null]])assert.equal((await call({mode:'selected',targetPairingIds})).statusCode,400)
  assert.equal((await call({mode:'selected',targetPairingIds:['p','p']})).statusCode,200)
  assert.deepEqual(store.snapshot().companions[0].notificationDelivery,{mode:'selected',targets:[{channelId:'a',userId:'u'}]})
  assert.equal((await call({companion:{...store.snapshot().companions[0],name:'新名称'}},`/api/companions/${id}`)).statusCode,200)
  assert.equal(store.snapshot().companions[0].notificationDelivery.mode,'selected')
  await store.update(state=>{state.channels[0].enabled=false})
  assert.equal((await call({mode:'selected',targetPairingIds:['p']})).statusCode,400)
  assert.equal((await call({mode:'recent',targetPairingIds:[]})).statusCode,200)
  const reopened=await PartnerStore.open(join(dir,'state.json'))
  assert.deepEqual(reopened.snapshot().companions[0].notificationDelivery,{mode:'recent',targets:[]})
})
