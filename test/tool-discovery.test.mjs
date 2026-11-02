import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {installToolDiscovery,PARTNER_TOOL_ENTRIES} from '../lib/collaboration/tool-discovery.js'
import {installToolAccessGuard} from '../lib/execution/tool-access-adapter.js'
import {restrictExecutionTools} from '../lib/execution/operation-tool-access.js'
import {chatTools} from '../lib/chat/tools.js'
import {channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
import {createDefaultCompanion,normalizeCompanionDraft} from '../lib/domain.js'
import {SessionConfigurationIndex} from '../lib/companions/session-configuration.js'
import {projectConversationPrompt} from '../lib/character/prompt-projection.js'

function fixture(t){
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('discovery'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx
 const companion={id:'c',toolDiscovery:true},state={companions:[companion],channels:[],sessions:[{id:'local',kind:'local',companionId:'c',sessionId:agent.session.id,channelId:'local',userId:'owner'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false}
 const invoke=(name,args={},signal=new AbortController().signal)=>root.tools.execute({callId:'call-'+name,name,arguments:args,agent,signal})
 const call=(name,args={},signal)=>invoke('partner_tools',{action:'call',name,argumentsJson:JSON.stringify(args)},signal)
 t.after(()=>scope.dispose());return {root,agent,scope,store,state,companion,invoke,call}
}
const definition=(name,execute=async()=>({ok:true}))=>({name,description:'工具说明 '+name,parameters:{type:'object',properties:{text:{type:'string'}},additionalProperties:false},output:{schema:{type:'object'},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},timeoutMs:5000,execute})
const names=f=>f.root.tools.schemas(f.agent).filter(t=>PARTNER_TOOL_ENTRIES.includes(t.name)).map(t=>t.name).sort()

test('describe returns deferred host protocol only after live tool authorization',async t=>{
 const f=fixture(t),tool=definition('write')
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool,allowed:()=>true,protocol:()=> 'Additional policy.'}]))
 projectConversationPrompt({sections:[{name:'tool:write',order:0,text:'Read before overwriting.'}],tools:[],contexts:[],variables:{}},f.agent,{roleEnabled:true,discovery:true})
 const r=await f.invoke('partner_tools',{action:'describe',name:'write'})
 assert.equal(r.isError,false);assert.equal(r.value.protocol,'Additional policy.\n\nRead before overwriting.')
 f.state.channels=[{id:'qq',platform:'qq',qq:{identityBinding:{enabled:true,qqIds:['12345678']}}}]
 const m=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]});f.agent.session.append('user/message',m,{surfaceOp:'append'})
 f.state.sessions.push({id:'guest',kind:'channel',companionId:'c',sessionId:f.agent.session.id,channelId:'qq',userId:'22345678',inboundMessageIds:[m.id]})
 const denied=await f.invoke('partner_tools',{action:'describe',name:'write'})
 assert.equal(denied.isError,true)
 assert.ok(!JSON.stringify(denied.content).includes('Read before overwriting.'))
})

test('fixed entries describe and invoke original tools without registry churn; host policies still deny',async t=>{
 const f=fixture(t);let calls=0,changes=0
 const original=definition('partner_identity',async()=>{calls++;return {ok:true}})
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:original,allowed:()=>true}]))
 t.after(f.root.on('tools/changed',()=>{changes++}))
 assert.deepEqual(names(f),['partner_channel_access','partner_tools'])
 const before=f.root.tools.schemas(f.agent)
 for(const action of ['describe','load','unload'])assert.equal((await f.invoke('partner_tools',{action,name:original.name})).isError,false)
 assert.equal(calls,0);assert.deepEqual(f.root.tools.schemas(f.agent),before);assert.equal(changes,0)
 const result=await f.call(original.name,{text:'x'});assert.equal(result.isError,false);assert.equal(result.value.dispatch.isError,false);assert.equal(calls,1)
 f.scope.ctx.tools.guard(e=>e.name===original.name?'policy revoked':undefined)
 const denied=await f.call(original.name);assert.equal(denied.value.dispatch.isError,true);assert.equal(calls,1)
 assert.equal(f.root.tools.schemas().some(s=>s.name===original.name),false)
 const logs=f.agent.session.snapshotEvents().filter(e=>e.type==='tool/ptc-dispatch')
 assert.equal(logs.length,2);assert.equal(logs[1].data.isError,true)
})
test('QQ adapter lists only authorized abilities, changes identity without changing tools, and denies stale/nested calls',async t=>{
 const f=fixture(t);let calls=0
 const defs=['partner_identity','partner_chat_reply','partner_stickers','partner_qq_reply','partner_memory_recall'].map(name=>definition(name,async()=>{calls++;return {ok:true}}))
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,defs.map(tool=>({tool,allowed:()=>true}))))
 t.after(f.scope.ctx.tools.register(definition('host_private')))
 t.after(installToolAccessGuard(f.root.tools,()=>f.state))
 f.state.channels=[{id:'qq',platform:'qq',qq:{identityBinding:{enabled:true,qqIds:['12345678']}}}]
 for(const [id,userId] of [['owner','12345678'],['guest','22345678']])f.state.sessions.push({id,kind:'channel',channelId:'qq',userId,companionId:'c',sessionId:f.agent.session.id,inboundMessageIds:[]})
 const send=id=>{const m=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]});f.agent.session.append('user/message',m,{surfaceOp:'append'});f.state.sessions.find(s=>s.id===id).inboundMessageIds.push(m.id)}
 const before=f.root.tools.schemas(f.agent)
 send('owner');let access=await f.invoke('partner_channel_access',{offset:0});assert.ok(access.value.tools.some(t=>t.name==='partner_identity'));assert.ok(!access.value.tools.some(t=>t.name==='host_private'))
 assert.equal((await f.call('partner_identity')).value.dispatch.isError,false)
 send('guest');access=await f.invoke('partner_channel_access',{offset:0});assert.deepEqual(access.value.tools.map(t=>t.name).sort(),['partner_chat_reply','partner_memory_recall','partner_qq_reply','partner_stickers'])
 assert.equal((await f.call('partner_identity')).isError,true);assert.equal((await f.invoke('partner_identity')).isError,true)
 assert.equal((await f.invoke('partner_tools',{action:'describe',name:'host_private'})).isError,true)
 assert.equal((await f.call('partner_chat_reply')).value.dispatch.isError,false)
 send('owner');assert.equal((await f.invoke('host_private')).isError,false)
 f.state.channels[0].qq.identityBinding.qqIds=[];assert.equal((await f.invoke('host_private')).isError,true)
 assert.deepEqual(f.root.tools.schemas(f.agent),before);assert.equal(calls,2)
})
test('gateway preserves validation, cancellation, additional context and terminal reply metadata',async t=>{
 const f=fixture(t);let called=0
 const tool=definition('partner_test',async(_args,exec)=>{if('bad' in _args)throw Error('invalid arguments');called++;exec.deferContext(createUserMessage({source:{kind:'plugin:test'},content:[{type:'text',text:'context'}]}));exec.concludeTurn();return {ok:true}})
 tool.output.presentationMeta=()=>({kind:'original'})
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool,allowed:()=>true}]))
 const invalid=await f.call(tool.name,{bad:1});assert.equal(invalid.value.dispatch.isError,true);assert.equal(called,0)
 const result=await f.call(tool.name);assert.equal(result.concludesTurn,true);assert.deepEqual(result.value.dispatch.meta,{kind:'original'});assert.equal(result.meta,undefined);assert.equal(result.additionalContexts.length,1)
 const canceled=await f.call(tool.name,{},AbortSignal.abort());assert.equal(canceled.isError,true);assert.equal(called,1)
})
test('chat reply through the gateway ends the turn and remains deliverable as native chat',async t=>{
 const f=fixture(t)
 f.companion.characterCard={enabled:true,segmentedReplies:true,stickersEnabled:true}
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,chatTools('c',f.store,{}, {},{},'/partner-local/v1').map(tool=>({tool,allowed:()=>true}))))
 f.agent.session.append('turn/start',{turn:1})
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]}),{surfaceOp:'append'})
 const result=await f.call('partner_chat_reply',{messages:[{text:'好吧，被你抓到了。',stickerId:''}]})
 assert.equal(result.isError,false);assert.equal(result.value.dispatch.isError,false);assert.equal(result.concludesTurn,true)
 assert.equal(result.meta,undefined,'only the nested event renders chat, preventing duplicate bubbles');assert.equal(result.value.dispatch.meta.kind,'partner-chat-v1');assert.deepEqual(result.value.dispatch.meta.parts,[{type:'text',text:'好吧，被你抓到了。'}])
 f.agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 assert.equal(channelReplyPartsAfter(f.agent.session.snapshotEvents(),0).chatParts[0].text,'好吧，被你抓到了。')
})
test('revoked catalogue entries and recursive gateway calls never execute',async t=>{
 const f=fixture(t);let allowed=true
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:definition('partner_test'),allowed:()=>allowed}]))
 allowed=false
 for(const name of ['partner_test','partner_tools','partner_channel_access','run_code'])assert.equal((await f.call(name)).isError,true)
 const listed=await f.invoke('partner_channel_access');assert.equal(listed.value.total,0);assert.deepEqual(listed.value.categories,[]);assert.equal(listed.value.tools,undefined)
 f.state.sessions=[];assert.equal((await f.invoke('partner_channel_access')).isError,true)
})
test('discovery setting remains validated and participates in next-turn composition revision',()=>{
 assert.throws(()=>normalizeCompanionDraft({name:'角色',toolDiscovery:'yes'}))
 const c={...createDefaultCompanion(),toolDiscovery:false},state={companions:[c],sessions:[{sessionId:'s',companionId:c.id}],skillBindings:[],companionAccessGrants:[],skills:[]}
 const index=new SessionConfigurationIndex({snapshot:()=>state,subscribe:()=>()=>{}})
 const before=index.forSession('s').revision;c.toolDiscovery=true;assert.notEqual(index.forSession('s').revision,before);index.close()
})

test('partner entry routes knowledge and SSH envelopes without bypassing operation allowlists',async t=>{
 const f=fixture(t),calls=[]
 for(const name of ['knowledge','ssh'])f.root.tools.register({name,description:name,
  parameters:{type:'object',properties:{action:{type:'string'},tool:{type:'string'},arguments:{type:'object',additionalProperties:true}},required:['action'],additionalProperties:false},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{assert.equal(exec.agent,f.agent);calls.push({name,args});return 'ok'},
 })
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[]))
 restrictExecutionTools(f.scope.ctx,f.agent,['partner_tools','knowledge_read','ssh_exec'])
 for(const [name,tool] of [['knowledge','knowledge_read'],['ssh','ssh_exec']]) {
  assert.equal((await f.invoke(name,{action:'list'})).isError,false)
  assert.equal((await f.invoke(name,{action:'describe',tool})).isError,false)
  assert.equal((await f.invoke(name,{action:'call',tool,arguments:{id:'fixture'}})).isError,false)
 }
 const before=calls.length
 for(const [name,tool] of [['knowledge','knowledge_note_update'],['ssh','ssh_forward_start']])assert.equal((await f.invoke(name,{action:'call',tool,arguments:{}})).isError,true)
 assert.equal((await f.invoke('ssh_exec',{})).isError,true,'old operation is not a top-level catalogue entry')
 assert.equal(calls.length,before)
 assert.deepEqual(calls.at(-1).args,{action:'call',tool:'ssh_exec',arguments:{id:'fixture'}})
 f.scope.ctx.tools.guard(exec=>exec.name==='ssh'?'host approval required':undefined)
 assert.equal((await f.invoke('ssh',{action:'call',tool:'ssh_exec',arguments:{}})).isError,true)
 assert.equal(calls.length,before)
})

test('persona reference is discoverable and fully delivered through the two permanent tool entries',async t=>{
 const {identityTool}=await import('../lib/companions/identity-tool.js')
 const {ROLE_REFERENCE_TEXT}=await import('../lib/character/role-reference-data.js')
 const f=fixture(t);Object.assign(f.companion,createDefaultCompanion(),{id:'c'})
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:identityTool('c',f.store),allowed:()=>true}]))
 for(const query of ['大肥鱼','参考模板','角色设定','关系设定']) {
  const found=await f.invoke('partner_tools',{action:'list',query})
  assert.equal(found.value.tools[0].name,'partner_identity',query)
 }
 const entry=f.root.tools.get('partner_tools',f.agent)
 const example=JSON.parse(entry.description.match(/人格参考模板直接调用：(\{.*?\})。/)[1])
 assert.equal(typeof example.argumentsJson,'string')
 assert.deepEqual(JSON.parse(example.argumentsJson),{action:'reference'})
 const direct=await f.invoke('partner_tools',example)
 assert.equal(direct.isError,false);assert.equal(direct.value.dispatch.isError,false)
 const before=names(f),result=await f.call('partner_identity',{action:'reference'})
 assert.equal(result.isError,false);assert.equal(result.value.dispatch.isError,false)
 const data=JSON.parse(result.content.filter(c=>c.type==='text').map(c=>c.text).join(''))
 assert.equal(data.reference.text,ROLE_REFERENCE_TEXT);assert.match(data.reference.text,/## 十、你的样子/)
 assert.deepEqual(names(f),before,'reference is on demand, not another permanent tool')
})

test('other plugin entries remain native and cannot be listed or invoked through partner_tools',async t=>{
 const f=fixture(t);let calls=0
 const image={...definition('generate_image',async()=>{calls++;return {files:[{path:'/workspace/generated/result.png'}]}}),description:'Generate images'}
 t.after(f.scope.ctx.tools.register(image))
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[]))
 assert.deepEqual((await f.invoke('partner_tools',{action:'list',query:'image'})).value.tools,[])
 assert.equal((await f.invoke('partner_tools',{action:'describe',name:'generate_image'})).isError,true)
 assert.equal((await f.call('generate_image')).isError,true)
 assert.equal(calls,0)
 assert.equal((await f.invoke('generate_image',{text:'a tree'})).isError,false)
 assert.equal(calls,1)
 f.scope.ctx.tools.guard(e=>e.name==='generate_image'?'permission revoked':undefined)
 assert.equal((await f.invoke('generate_image')).isError,true)
 assert.equal(calls,1)
})

test('image discovery never invents unavailable tools or exposes them to QQ chat-only identities',async t=>{
 const f=fixture(t)
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[]))
 assert.deepEqual((await f.invoke('partner_tools',{action:'list',query:'生图'})).value.tools,[])
 t.after(f.scope.ctx.tools.register({...definition('generate_image'),description:'Generate images'}))
 f.state.channels=[{id:'qq',platform:'qq',qq:{identityBinding:{enabled:true,qqIds:['12345678']}}}]
 const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'帮我生图'}]})
 f.agent.session.append('user/message',message,{surfaceOp:'append'})
 f.state.sessions.push({id:'guest',kind:'channel',channelId:'qq',userId:'22345678',companionId:'c',sessionId:f.agent.session.id,inboundMessageIds:[message.id]})
 assert.deepEqual((await f.invoke('partner_tools',{action:'list',query:'生图'})).value.tools,[])
 assert.equal((await f.call('generate_image')).isError,true)
})

test('missing tools are distinguished from revoked permissions',async t=>{
 const f=fixture(t)
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:definition('revoked'),allowed:()=>false}]))
 const missing=await f.call('partner_chat_progress')
 assert.equal(missing.isError,true);assert.match(JSON.stringify(missing.content),/未注册或已结束/)
 const revoked=await f.call('revoked')
 assert.equal(revoked.isError,true);assert.match(JSON.stringify(revoked.content),/当前渠道未授权/)
})


test('permission summary is bounded and paginated, never dumps the whole tool catalogue',async t=>{
 const f=fixture(t)
 const tools=Array.from({length:93},(_,i)=>definition('mcp__test_'+i))
 tools.push(definition('partner_work_execute'))
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,tools.map(tool=>({tool,allowed:()=>true}))))
 const summary=await f.invoke('partner_channel_access')
 assert.equal(summary.value.total,94);assert.equal(summary.value.tools,undefined)
 assert.ok(JSON.stringify(summary.value).length<1800);assert.match(summary.value.next,/partner_work_execute/)
 const found=[]
 for(let offset=0;offset<93;offset+=12){
  const page=await f.invoke('partner_channel_access',{category:'mcp',offset})
  assert.ok(page.value.tools.length<=12);found.push(...page.value.tools.map(t=>t.name))
 }
 assert.equal(new Set(found).size,93)
 const empty=await f.invoke('partner_tools',{action:'list',query:'browser'})
 assert.deepEqual(empty.value.tools,[]);assert.match(empty.value.next,/partner_work_execute/)
 assert.equal((await f.invoke('partner_channel_access',{offset:-1})).isError,true)
})

test('sticker lookup is a direct entry and still honors live capability revocation',async t=>{
 const f=fixture(t);let allowed=true,calls=0
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:definition('partner_stickers',async()=>{calls++;return {ok:true}}),allowed:()=>allowed}]))
 assert.ok(PARTNER_TOOL_ENTRIES.includes('partner_stickers'))
 assert.ok(names(f).includes('partner_stickers'))
 assert.equal((await f.invoke('partner_stickers')).isError,false)
 allowed=false
 assert.equal((await f.invoke('partner_stickers')).isError,true)
 assert.equal((await f.call('partner_stickers')).isError,true)
 assert.equal(calls,1)
})

test('autonomous persona update concludes through unified gateway with a silent receipt',async t=>{
 const {identityTool}=await import('../lib/companions/identity-tool.js')
 const f=fixture(t);Object.assign(f.companion,createDefaultCompanion(),{id:'c',characterCard:{enabled:true,roleText:'原角色'},idleContact:{enabled:true,routeId:'local',idleMinutes:120,selfRefinement:true}})
 f.store.update=async update=>{update(f.state);return f.state}
 const user=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'今天很开心'}]})
 f.agent.session.append('user/message',user,{surfaceOp:'append'});f.agent.session.append('turn/start',{turn:2})
 const notice=createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:'伙伴闲时主动联系'},content:[{type:'text',text:'按兴趣活动'}]})
 f.agent.session.append('user/message',notice,{surfaceOp:'append'})
 f.state.sessions[0].idleContactState={messageId:notice.id,userMessageId:user.id,policyRevision:f.companion.updatedAt}
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:identityTool('c',f.store),allowed:()=>true}]))
 const result=await f.call('partner_identity',{action:'update',expectedAt:f.companion.updatedAt,patch:{characterCard:{roleText:'自己决定的新角色'}},reason:'最近有了新的喜好'})
 assert.equal(result.value.dispatch.isError,false,JSON.stringify(result.content))
 assert.equal(result.concludesTurn,true)
 assert.equal(f.companion.personaHistory.length,1)
 assert.equal(result.value.dispatch.meta.kind,'partner-activity-silent-v1')
 assert.equal(f.agent.session.snapshotEvents().some(e=>e.type==='tool/ptc-dispatch'&&e.data.meta?.kind==='partner-activity-silent-v1'),true)
})

test('failed discovered tool exposes exact current evidence accepted by blocked reply without retry',async t=>{
 const {validateTaskStop}=await import('../lib/chat/action-obligation.js')
 const f=fixture(t);let calls=0
 f.agent.session.append('turn/start',{turn:1})
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'draw'}]}),{surfaceOp:'append'})
 const tool=definition('generate_image',async()=>{calls++;throw Error('Provider rejected request; request ID provider-id. policy_check_failed')})
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool,allowed:()=>true}]))
 const result=await f.call('generate_image')
 assert.equal(result.value.dispatch.isError,true);assert.equal(calls,1)
 const receipt=result.content.filter(b=>b.type==='text').map(b=>{try{return JSON.parse(b.text)}catch{return null}}).find(b=>b?.taskEvidence)
 assert.ok(receipt);assert.notEqual(receipt.taskEvidence.callId,'provider-id')
 const verified=validateTaskStop(f.agent.session.snapshotEvents(),receipt.taskEvidence)
 assert.equal(verified.toolName,'generate_image');assert.match(verified.excerpt,/policy_check_failed/)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'new'}]}),{surfaceOp:'append'})
 assert.throws(()=>validateTaskStop(f.agent.session.snapshotEvents(),receipt.taskEvidence),/不存在/)
})
