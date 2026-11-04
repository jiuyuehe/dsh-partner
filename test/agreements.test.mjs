import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {agreementTool,projectAgreements,agreementScope,validateAgreements} from '../lib/chat/agreements.js'
import {PartnerStore} from '../lib/store.js'
import {rollConversationContext} from '../lib/rolling-context.js'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
const assembly=()=>({sections:[{name:'identity',text:'角色'}],contexts:[{name:'recent',text:'滚动对话'}],tools:[],variables:{}})
function fixture(){
 const events=[{seq:1,type:'turn/start'},{seq:2,type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'这局解谜记得配合生图，玩完就不用了'}]}}]
 const state={companions:[{id:'c'}],sessions:[{id:'r',kind:'channel',channelId:'qq',userId:'1',companionId:'c',sessionId:'s',inboundMessageIds:['u']},{id:'other',kind:'channel',channelId:'qq',userId:'2',companionId:'c',sessionId:'s',inboundMessageIds:['v']}]}
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async f=>f(state)}
 const exec={agent:{session:{id:'s',snapshotEvents:()=>events}},signal:new AbortController().signal}
 return {events,state,store,exec,tool:agreementTool('c',store)}
}
const args={action:'set',text:'这局解谜配合生图',until:'本局结束或用户取消',evidence:'这局解谜记得配合生图'}
test('agreements are source-grounded, bounded, scope-isolated and removed with revision protection',async()=>{
 const f=fixture(),{agreement:a}=await f.tool.execute(args,f.exec)
 assert.equal(a.sourceMessageId,'u');assert.equal(f.state.companions[0].temporaryAgreements.length,1)
 await f.tool.execute(args,f.exec);assert.equal(f.state.companions[0].temporaryAgreements.length,1)
 await assert.rejects(f.tool.execute({...args,text:'伪造',evidence:'我自愿替你持续执行任务'},f.exec),/原话/)
 await assert.rejects(f.tool.execute({action:'remove',id:a.id,expectedAt:0,reason:'completed'},f.exec),/已变化/)
 const original=assembly(),projected=projectAgreements(original,f.state,'c','s',f.events)
 assert.equal(original.sections.length,1);assert.equal(projected.contexts,original.contexts);assert.match(projected.sections.at(-1).text,/这局解谜配合生图/)
 const foreign=[{...f.events[1],data:{...f.events[1].data,id:'v'}}]
 assert.equal(projectAgreements(original,f.state,'c','s',foreign).sections.length,1)
 await f.tool.execute({action:'remove',id:a.id,expectedAt:a.updatedAt,reason:'completed'},f.exec)
 assert.equal(f.state.companions[0].temporaryAgreements.length,0)
 assert.equal(projectAgreements(projected,f.state,'c','s',f.events).sections.length,1,'expired content must not stay in a reused assembly')
 assert.equal(f.events.length,2,'never rewrite history')
})
test('agreement state survives store restart and rolling away its source conversation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'agreements-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(dir,'state.json'));const owner=store.snapshot().companions[0].id
 const session=Session.create('agreement-rolling');session.append('turn/start',{turn:1})
 const input=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'这局解谜记得配合生图'}]});session.append('user/message',input,{surfaceOp:'append'})
 await store.update(s=>s.sessions.push({id:'r',kind:'channel',channelId:'qq',userId:'1',companionId:owner,sessionId:session.id,inboundMessageIds:[input.id]}))
 await agreementTool(owner,store).execute(args,{agent:{session},signal:new AbortController().signal});session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 const before=session.snapshotEvents().length
 for(let i=2;i<7;i++){session.append('turn/start',{turn:i});const u=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续'+i}]});session.append('user/message',u,{surfaceOp:'append'});await store.update(s=>s.sessions[0].inboundMessageIds.push(u.id));session.append('turn/end',{turn:i,reason:{kind:'completed'}})}
 assert.ok(rollConversationContext(session,{rollingContextEnabled:true,rollingContextTurns:2,rollingContextMaxChars:48000})>0)
 assert.ok(!JSON.stringify(session.deriveMessages()).includes('这局解谜记得配合生图'))
 const reopened=await PartnerStore.open(join(dir,'state.json'))
 assert.match(projectAgreements(assembly(),reopened.snapshot(),owner,session.id,session.snapshotEvents()).sections.at(-1).text,/这局解谜配合生图/)
 assert.ok(session.snapshotEvents().length>before)
})
test('limits never silently evict ongoing agreements, and autonomous turns cannot modify them',async()=>{
 const f=fixture()
 for(let i=0;i<6;i++)await f.tool.execute({...args,text:'约定'+i},f.exec)
 await assert.rejects(f.tool.execute({...args,text:'第七条'},f.exec),/最多保留 6/)
 assert.throws(()=>validateAgreements(Array(49).fill({})),/48/)
 f.events.push({seq:3,type:'user/message',data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:'伙伴闲时主动联系'}}})
 await assert.rejects(f.tool.execute(args,f.exec),/内部任务和自主活动/)
 assert.equal(f.state.companions[0].temporaryAgreements.length,6)
})

test('management API requires mutation header, detects stale writes, and settings edits preserve active agreements',async t=>{
 const {Readable}=await import('node:stream');const {registerPartnerApi}=await import('../lib/api.js')
 const dir=await mkdtemp(join(tmpdir(),'agreements-api-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(dir,'state.json')),id=store.snapshot().companions[0].id
 let handler;registerPartnerApi({register:r=>{handler=r.handler;return()=>{}}},'/api',{store,connection:{requestRejection:()=>undefined}})
 const call=async(body,path=`/api/companions/${id}/agreements`,headers={'x-dsh-partner-request':'1'})=>{
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method:'PUT',url:path,headers}),res={statusCode:0,setHeader(){},end(data){this.body=data?JSON.parse(data):undefined}};await handler(req,res);return res
 }
 const record={id:'a',scope:'local',text:'这局配图',until:'游戏结束',evidence:'配图',sourceMessageId:'u',updatedAt:1}
 assert.equal((await call({agreements:[record],expectedAgreements:[]},undefined,{})).statusCode,403)
 assert.equal((await call({agreements:[record],expectedAgreements:[]})).statusCode,200)
 assert.equal((await call({agreements:[],expectedAgreements:[]})).statusCode,409)
 assert.equal((await call({companion:{...store.snapshot().companions[0],name:'改名'}},`/api/companions/${id}`)).statusCode,200)
 assert.equal(store.snapshot().companions[0].temporaryAgreements.length,1)
 assert.equal((await call({agreements:[],expectedAgreements:[record]})).statusCode,200)
})
