import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentDeliveryService } from '../lib/attachments/service.js'
import { attachmentTool } from '../lib/attachments/tool.js'
import { dispatchAttachmentsApi } from '../lib/api/features/attachments-api.js'

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'partner-delivery-')),cwd=join(root,'workspace'),storage=join(root,'deliveries')
  await mkdir(cwd)
  const service=await AttachmentDeliveryService.open(storage)
  t.after(async()=>{service.close();await rm(root,{recursive:true,force:true})})
  const input={companionId:'c1',sessionId:'s1',turn:1,cwd,path:'report.md',channel:true}
  await writeFile(join(cwd,'report.md'),'# Final result')
  return {root,cwd,storage,service,input,signal:new AbortController().signal}
}

test('explicit file snapshots survive source mutation and success retries do not resend',async t=>{
  const f=await fixture(t),item=await f.service.prepare(f.input,f.signal)
  assert.equal((await f.service.prepare(f.input,f.signal)).id,item.id)
  await writeFile(join(f.cwd,'report.md'),'changed')
  assert.equal((await f.service.bytes(item)).toString(),'# Final result')
  let sends=0
  const send=async file=>{sends++;assert.equal((await readFile(file.path)).toString(),'# Final result');assert.equal(file.name,'report.md')}
  await f.service.deliver(item,send)
  await f.service.deliver(f.service.get(item.id),send)
  assert.equal(sends,1)
  assert.equal((await stat(join(f.storage,item.id))).mode&0o777,0o600)
  const reopened=await AttachmentDeliveryService.open(f.storage)
  try { assert.equal(reopened.get(item.id).channel,'sent');assert.equal((await reopened.bytes(item)).toString(),'# Final result') } finally { reopened.close() }
})

test('failed channel delivery retains identity and can retry after source removal',async t=>{
  const f=await fixture(t),item=await f.service.prepare(f.input,f.signal)
  await assert.rejects(f.service.deliver(item,async()=>{throw Error('network unavailable')}),/network/)
  assert.equal(f.service.get(item.id).channel,'failed')
  await rm(join(f.cwd,'report.md'))
  await f.service.deliver(f.service.get(item.id),async()=>{})
  assert.equal(f.service.get(item.id).channel,'sent')
})

test('boundaries reject links outside cwd, symlinks, missing files, URLs and canceled work',async t=>{
  const f=await fixture(t)
  await writeFile(join(f.root,'private.md'),'secret');await symlink(join(f.root,'private.md'),join(f.cwd,'escape.md'))
  for(const path of ['../private.md','escape.md','missing.md','https://example.com/report.md','sandbox:/mnt/data/report.md'])
    await assert.rejects(f.service.prepare({...f.input,path},f.signal),/附件不可用/)
  const abort=new AbortController();abort.abort()
  await assert.rejects(f.service.prepare(f.input,abort.signal))
  assert.equal(f.service.get('../report.md'),undefined)
})

test('tool records native images and download links, reports channel failure, retries by ID',async t=>{
  const f=await fixture(t),messages=[],saved=[]
  const route={id:'route',companionId:'c1',sessionId:'s1',kind:'channel',cwd:f.cwd,inboundMessageIds:['inbound']}
  const store={snapshot:()=>({companions:[{id:'c1'}],sessions:[route]}),isCompanionRemoving:()=>false}
  let fail=true,sends=0
  const channels={sendExplicitAttachment:async()=>{sends++;if(fail)throw Error('upload failed')}}
  const ctx={attachments:{saveImage:async input=>{saved.push(input);return {attachmentId:'test-image',mediaType:'image/png',bytes:input.data.length,width:1,height:1}}}}
  const exec={signal:f.signal,agent:{session:{id:'s1',seq:3,header:{cwd:f.cwd},snapshotEvents:()=>[{type:'user/message',seq:1,data:{id:'inbound',source:{kind:'user'}}}]}},deferContext:msg=>messages.push(msg)}
  await writeFile(join(f.cwd,'image.png'),'test-image-bytes')
  const tool=attachmentTool('c1',store,f.service,ctx,channels,'/partner-local/v1')
  const first=JSON.parse(await tool.execute({path:'image.png'},exec))
  assert.equal(first.channel,'failed');assert.equal(first.retry.deliveryId,first.deliveryId)
  assert.equal(saved.length,1);assert.ok(messages[0].content.some(b=>b.type==='image'))
  assert.match(messages[0].content[0].text,/\/partner-local\/v1\/attachments\//)
  fail=false
  const retry=JSON.parse(await tool.execute({deliveryId:first.deliveryId},exec))
  assert.equal(retry.channel,'sent')
  await tool.execute({deliveryId:first.deliveryId},exec)
  assert.equal(sends,2,'one failed attempt and one successful attempt')
  assert.ok(messages.every(m=>m.source.summary==='伙伴附件交付'))
  const other=attachmentTool('c2',{...store,snapshot:()=>({companions:[{id:'c2'}],sessions:[{...route,companionId:'c2'}]})},f.service,ctx,channels,'/api')
  await assert.rejects(other.execute({deliveryId:first.deliveryId},exec),/不属于/)
})

test('shared-session attachment delivery follows source and pins retry to the original route',async t=>{
  const f=await fixture(t),sends=[]
  const state={companions:[{id:'c1'}],sessions:[
    {id:'local',companionId:'c1',sessionId:'s1',kind:'local',cwd:f.cwd},
    {id:'matrix',companionId:'c1',sessionId:'s1',kind:'channel',cwd:f.cwd,inboundMessageIds:['mx']},
    {id:'mattermost',companionId:'c1',sessionId:'s1',kind:'channel',cwd:f.cwd,inboundMessageIds:['mm']},
  ]}
  let source='mx',seq=1,fail=true
  const tool=attachmentTool('c1',{snapshot:()=>state,isCompanionRemoving:()=>false},f.service,{},
    {sendExplicitAttachment:async(_session,_file,_signal,route)=>{sends.push(route);if(fail)throw Error('network')}},'/api')
  const exec={signal:f.signal,agent:{session:{id:'s1',header:{cwd:f.cwd},snapshotEvents:()=>[{type:'user/message',seq,data:{id:source,source:{kind:'user'}}}]}},deferContext:()=>{}}
  const first=JSON.parse(await tool.execute({path:'report.md'},exec))
  assert.equal(first.channel,'failed');assert.deepEqual(sends,['matrix'])
  assert.equal(f.service.get(first.deliveryId).channelRouteId,'matrix')
  source='mm';seq++
  await assert.rejects(tool.execute({deliveryId:first.deliveryId},exec),/来源不一致/)
  source='browser';seq++
  const local=JSON.parse(await tool.execute({path:'report.md'},exec))
  assert.equal(local.channel,'none');assert.equal(sends.length,1)
  source='mx';seq++;fail=false
  assert.equal(JSON.parse(await tool.execute({deliveryId:first.deliveryId},exec)).channel,'sent')
  assert.deepEqual(sends,['matrix','matrix'])
})

test('internal task/review file delivery never calls the channel',async t=>{
  const f=await fixture(t),store={snapshot:()=>({companions:[{id:'c1'}],sessions:[{companionId:'c1',sessionId:'s1',cwd:f.cwd}]}),isCompanionRemoving:()=>false}
  const tool=attachmentTool('c1',store,f.service,{}, {sendExplicitAttachment:async()=>assert.fail('internal channel leak')},'/api')
  const exec={signal:f.signal,agent:{session:{id:'s1',header:{cwd:f.cwd},snapshotEvents:()=>[{type:'user/message',seq:1,data:{source:{kind:'user'}}},{type:'user/message',seq:2,data:{source:{kind:'plugin',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴核验看板任务'}}}]}},deferContext:()=>{}}
  const reply=JSON.parse(await tool.execute({path:'report.md'},exec))
  assert.equal(reply.channel,'none')
})

test('task executor records explicit deliverables once; reviewer cannot add them',async t=>{
  const f=await fixture(t)
  const state={companions:[{id:'c1'}],sessions:[{companionId:'c1',sessionId:'s1',cwd:f.cwd}],tasks:[{id:'task',assigneeCompanionId:'c1',status:'doing'}],delegations:[{taskId:'task',status:'running',kind:'task',toCompanionId:'c1',executionSessionId:'s1'}]}
  const store={snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)}
  const tool=attachmentTool('c1',store,f.service,{}, {sendExplicitAttachment:async()=>assert.fail('internal channel leak')},'/api')
  const exec={signal:f.signal,agent:{session:{id:'s1',header:{cwd:f.cwd},snapshotEvents:()=>[{type:'user/message',seq:2,data:{source:{kind:'plugin',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴执行看板任务'}}}]}},deferContext:()=>{}}
  const reply=JSON.parse(await tool.execute({path:'report.md'},exec))
  await tool.execute({deliveryId:reply.deliveryId},exec)
  assert.deepEqual(state.tasks[0].resultAttachmentIds,[reply.deliveryId])
  state.delegations[0].kind='review'; state.tasks[0].resultAttachmentIds=[]
  await tool.execute({deliveryId:reply.deliveryId},exec)
  assert.deepEqual(state.tasks[0].resultAttachmentIds,[])
})

test('continuation attachment inherits saved origin and retry never follows latest channel',async t=>{
  const f=await fixture(t), sends=[]
  const route={id:'matrix',kind:'channel',companionId:'c1',sessionId:'s1',channelId:'mx',userId:'alice',cwd:f.cwd}
  const state={companions:[{id:'c1'}],sessions:[route,{...route,id:'mm',channelId:'mm',userId:'bob'}],schedules:[{companionId:'c1',continuation:{originSessionId:'s1',messageId:'wake',state:'completed',originChannel:{routeId:'matrix',channelId:'mx',userId:'alice'}}}]}
  let fail=true
  const tool=attachmentTool('c1',{snapshot:()=>state,isCompanionRemoving:()=>false},f.service,{},
    {sendExplicitAttachment:async(_s,_f,_signal,id)=>{sends.push(id);if(fail)throw Error('offline')}},'/api')
  const exec={signal:f.signal,agent:{session:{id:'s1',header:{cwd:f.cwd},snapshotEvents:()=>[{seq:2,type:'user/message',data:{id:'wake',source:{kind:'plugin',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴长任务续接'}}}]}},deferContext:()=>{}}
  const first=JSON.parse(await tool.execute({path:'report.md'},exec))
  assert.equal(first.channel,'failed')
  fail=false
  assert.equal(JSON.parse(await tool.execute({deliveryId:first.deliveryId},exec)).channel,'sent')
  assert.deepEqual(sends,['matrix','matrix'])
  state.sessions=state.sessions.filter(s=>s.id!=='matrix')
  await assert.rejects(tool.execute({deliveryId:first.deliveryId},exec),/原渠道已移除/)
  assert.equal(sends.length,2)
})

test('download endpoint serves only recorded snapshots and rejects deleted owners',async t=>{
  const f=await fixture(t),item=await f.service.prepare(f.input,f.signal),headers={}
  let body
  const res={setHeader:(k,v)=>headers[k]=v,end:data=>body=data}
  const store={snapshot:()=>({companions:[{id:'c1'}]}),isCompanionRemoving:()=>false}
  assert.equal(await dispatchAttachmentsApi({method:'GET'},res,['attachments',item.id],f.service,store),true)
  assert.equal(body.toString(),'# Final result');assert.match(headers['content-disposition'],/^attachment;/)
  assert.equal(headers['x-content-type-options'],'nosniff')
  await assert.rejects(dispatchAttachmentsApi({method:'GET'},res,['attachments','../x'],f.service,store),/不存在/)
  await assert.rejects(dispatchAttachmentsApi({method:'GET'},res,['attachments',item.id],f.service,{...store,snapshot:()=>({companions:[]})}),/不存在/)
})

test('inline document delivers exact content, retries idempotently and never concludes the chat',async t=>{
 const f=await fixture(t),messages=[],sent=[]
 const state={companions:[{id:'c1'}],sessions:[{id:'r',companionId:'c1',sessionId:'s1',kind:'channel',cwd:f.cwd,inboundMessageIds:['u']}]}
 const events=[{seq:1,type:'turn/start',data:{}},{seq:2,type:'user/message',data:{id:'u',source:{kind:'user'}}}]
 const tool=attachmentTool('c1',{snapshot:()=>state,isCompanionRemoving:()=>false},f.service,{}, {sendExplicitAttachment:async(_s,file)=>sent.push(await readFile(file.path,'utf8'))},'/api')
 const exec={signal:f.signal,agent:{session:{id:'s1',header:{cwd:f.cwd},snapshotEvents:()=>events}},deferContext:m=>messages.push(m),concludeTurn:()=>assert.fail('file must not end conversation')}
 const content='# 调查\n\n结论\n\n未验证：本轮没有实测。\n\n'+ '详细依据\n'.repeat(100)
 const input={document:{name:'调查结果.md',content}}
 const result=JSON.parse(await tool.execute(structuredClone(input),exec))
 assert.equal(result.channel,'sent');assert.deepEqual(sent,[content]);assert.equal(messages.length,1)
 await tool.execute(structuredClone(input),exec);assert.equal(sent.length,1)
 for(const document of [{name:'../escape.md',content:'x'},{name:'x.md',content:''},{name:'x.exe',content:'x'}])await assert.rejects(tool.execute({document},exec))
 await assert.rejects(tool.execute({...input,path:'report.md'},exec),/只能提供一个/)
})

test('work report preserves all facts and failures without another model, rejects old or invented runs',async t=>{
 const f=await fixture(t),state={companions:[{id:'c1'}],sessions:[{id:'local',companionId:'c1',sessionId:'s1',kind:'local',cwd:f.cwd}]}
 const report={runId:'real',result:{status:'partial',facts:['确实抽过帧'],unknowns:['本轮尚未端到端实测'],evidence:['https://example.test/reference'],artifacts:['/workspace/result.md']}}
 const events=[{seq:1,type:'turn/start',data:{}},{seq:2,type:'user/message',data:{id:'u',source:{kind:'user'}}},{seq:3,type:'tool/call',data:{name:'partner_work_execute',callId:'w'}},{seq:4,type:'tool/result',data:{message:{toolCallId:'w',content:[{type:'text',text:JSON.stringify(report)}]}}}]
 const tool=attachmentTool('c1',{snapshot:()=>state,isCompanionRemoving:()=>false},f.service,{}, {sendExplicitAttachment:()=>assert.fail('local must not send')},'/api')
 const exec={signal:f.signal,agent:{session:{id:'s1',header:{cwd:f.cwd},snapshotEvents:()=>events}},deferContext:()=>{}}
 const result=JSON.parse(await tool.execute({workReport:{runIds:['real'],name:'视频能力核验.md'}},exec));assert.equal(result.channel,'none');assert.equal(result.name,'视频能力核验.md')
 await assert.rejects(tool.execute({workReport:{runIds:['real'],name:'../escape.md'}},exec),/安全/)
 const text=(await f.service.bytes(f.service.get(result.deliveryId))).toString()
 for(const field of ['facts','unknowns','evidence','artifacts'])for(const value of report.result[field])assert.ok(text.includes(value))
 await assert.rejects(tool.execute({workReport:{runIds:['invented']}},exec),/不存在/)
 events.push({seq:5,type:'turn/start',data:{}})
 await assert.rejects(tool.execute({workReport:{runIds:['real']}},exec),/当前回合/)
})
