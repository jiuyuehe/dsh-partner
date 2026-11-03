import test from 'node:test'
import assert from 'node:assert/strict'
import {LiveSpeech,installLiveSpeech,hasCurrentSpeech} from '../lib/chat/live-speech.js'
import {channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
import {replyCompletionState} from '../lib/chat/reply-completion.js'
import {nativeChatBlocks} from '../lib/chat/conversation.js'
import {chatTools} from '../lib/chat/tools.js'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {installToolDiscovery} from '../lib/collaboration/tool-discovery.js'
const start={seq:1,type:'turn/start',data:{turn:1}}
const user=(id='u',seq=2)=>({seq,type:'user/message',data:{id,source:{kind:'user'},content:[]}})
const speech=(seq=3)=>({seq,type:'tool/result',data:{message:{isError:false,content:[]},meta:{kind:'partner-chat-v1',parts:[],delivered:true,deliveryKind:'text',intermediate:true,inputMessageId:'u',spokenText:'才不给你',originRouteId:'r'}}})
const end={seq:9,type:'turn/end',data:{reason:{kind:'completed'}}}
const signal=()=>new AbortController().signal

test('live speech delivers successive calls immediately, serializes and deduplicates without ending',async()=>{
 const sent=[],events=[start,user()];let release
 const gate=new Promise(r=>release=r)
 const live=new LiveSpeech(()=>events,async text=>{sent.push(text);if(text==='才不给你')await gate},()=>true)
 const first=live.say('才不给你',signal()),second=live.say('就一小口哦',signal())
 await new Promise(r=>setImmediate(r));assert.deepEqual(sent,['才不给你'])
 release();await Promise.all([first,second]);await live.say('才不给你',signal())
 assert.deepEqual(sent,['才不给你','就一小口哦'])
 for(const text of ['a','b','c','d'])await live.say(text,signal())
 await assert.rejects(live.say('e',signal()),/上限/)
})
test('steering cancels queued old speech; revocation, cancellation and unknown sends never leak or retry',async()=>{
 const events=[start,user()],sent=[];let release
 const wait=new Promise(r=>release=r)
 const live=new LiveSpeech(()=>events,async text=>{sent.push(text);await wait},()=>true)
 const first=live.say('第一句',signal()),next=live.say('旧的第二句',signal());const rejected=assert.rejects(next,/输入/)
 await new Promise(r=>setImmediate(r));events.push(user('new',4));release();await first;await rejected
 assert.deepEqual(sent,['第一句'])
 let attempts=0;const failed=new LiveSpeech(()=>events,async()=>{attempts++;throw Error('unknown')},()=>true)
 await assert.rejects(failed.say('消息',signal()));await assert.rejects(failed.say('消息',signal()));await assert.rejects(failed.say('不重试',signal()));assert.equal(attempts,1)
 const revoked=new LiveSpeech(()=>events,async()=>assert.fail(),()=>false);await assert.rejects(revoked.say('不发送',signal()))
 const abort=new AbortController();abort.abort();await assert.rejects(new LiveSpeech(()=>events,async()=>assert.fail(),()=>true).say('不发送',abort.signal))
})
test('live receipts display as speech, never resend, retain ordinary final prose and do not mask empty stops',()=>{
 const events=[start,user(),speech()]
 assert.equal(hasCurrentSpeech(events),true);assert.equal(hasCurrentSpeech([start,user(),user('new',3),speech(4)]),false);assert.equal(hasCurrentSpeech([...events,user('new',4)]),false)
 assert.equal(hasCurrentSpeech([start,user(),{...speech(),data:{...speech().data,message:{isError:true}}}]),false)
 assert.deepEqual(nativeChatBlocks(speech().data.meta),[{kind:'text',text:'才不给你'}])
 assert.equal(channelReplyPartsAfter([...events,end],0).alreadyDelivered,true)
 assert.deepEqual(channelReplyPartsAfter([...events,end],0).chatParts,[])
 const final={seq:5,type:'assistant/message',data:{message:{content:[{type:'text',text:'就一小口哦'}]}}}
 assert.equal(channelReplyPartsAfter([...events,final,end],0).text,'就一小口哦')
 const empty={...final,data:{message:{content:[{type:'text',text:''}]}}}
 assert.notEqual(replyCompletionState([...events,empty]).phase,'complete')
})
test('actual scoped runtime supports successive native calls, silent explicit end, and denies empty end after new input',async t=>{
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('live'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 const state={companions:[{id:'c',toolDiscovery:true,characterCard:{enabled:true,segmentedReplies:true}}],channels:[],sessions:[{id:'r',kind:'channel',channelId:'ch',userId:'peer',companionId:'c',sessionId:agent.session.id}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false},sent=[]
 t.after(installToolDiscovery(scope.ctx.tools,'c',store,[]))
 t.after(installLiveSpeech(agent,async text=>sent.push(text),()=> 'r'))
 const terminal=chatTools('c',store,{}, {},{},'/api').find(t=>t.name==='partner_chat_reply');t.after(scope.ctx.tools.register(terminal))
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'给我吃一口'}]}),{surfaceOp:'append'})
 state.sessions[0].inboundMessageIds=[agent.session.snapshotEvents().find(e=>e.type==='user/message').data.id]
 let seq=0;const call=async(name,args={})=>{const request={name,arguments:args,agent,signal:signal(),callId:'call-'+seq++};agent.session.append('tool/call',{name,arguments:JSON.stringify(args),callId:request.callId});const result=await root.tools.execute(request);agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{id:request.callId,role:'tool',source:{kind:'tool',callId:request.callId},toolCallId:request.callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'});return result}
 for(const text of ['才不给你','就一小口哦']){
  const r=await call('partner_chat_say',{text});assert.equal(r.isError,false);assert.ok(!r.concludesTurn)
 }
 assert.deepEqual(sent,['才不给你','就一小口哦']);assert.equal(hasCurrentSpeech(agent.session.snapshotEvents()),true)
 const done=await call('partner_chat_reply',{messages:[]});assert.equal(done.isError,false,JSON.stringify(done));assert.equal(done.concludesTurn,true)
 agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'新问题'}]}),{surfaceOp:'append'})
 const denied=await call('partner_chat_reply',{messages:[]});assert.equal(denied.isError,true)
})

test('native speech releases work only after action receipt, never duplicates a preamble or treats it as final',async t=>{
 const {installTaskPreamble}=await import('../lib/execution/task-preamble.js')
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('unified'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 const sent=[],state={companions:[{id:'c',toolDiscovery:true}],channels:[],sessions:[{id:'r',kind:'local',companionId:'c',sessionId:agent.session.id}]}
 t.after(installToolDiscovery(scope.ctx.tools,'c',{snapshot:()=>state,isCompanionRemoving:()=>false},[]))
 t.after(installLiveSpeech(agent,async text=>sent.push(text),()=> 'r'))
 t.after(installTaskPreamble(agent,async()=>assert.fail('no separate sender'),()=>true,()=>true,true))
 assert.equal(scope.ctx.tools.get('partner_chat_progress',agent),undefined)
 let executed=0;t.after(scope.ctx.tools.register({name:'generate_image',description:'image',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>{executed++;return {ok:true}}}))
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'画张图'}]}),{surfaceOp:'append'})
 let seq=0;const call=async(name,args={})=>{const request={name,arguments:args,agent,signal:signal(),callId:'unified-'+seq++};agent.session.append('tool/call',{name,arguments:JSON.stringify(args),callId:request.callId});const result=await root.tools.execute(request);agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{id:request.callId,role:'tool',source:{kind:'tool',callId:request.callId},toolCallId:request.callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'});return result}
 await call('partner_chat_say',{text:'哥哥来啦'})
 assert.equal((await call('generate_image')).isError,true);assert.equal(executed,0)
 const ack=await call('partner_chat_say',{text:'我画给你看',beforeTools:true,expectedTools:['generate_image']});assert.equal(ack.isError,false)
 t.after(scope.ctx.tools.register(chatTools('c',{snapshot:()=>({...state,companions:[{id:'c',toolDiscovery:true,characterCard:{enabled:true,segmentedReplies:true}}]}),isCompanionRemoving:()=>false},{},{},{},'/api').find(t=>t.name==='partner_chat_reply')))
 const early=await call('partner_chat_reply',{messages:[{text:'咔哒，开啦'}]});assert.equal(early.isError,true);assert.equal(early.concludesTurn,undefined)
 assert.match(JSON.stringify(early),/尚未实际调用/)

 assert.equal(hasCurrentSpeech(agent.session.snapshotEvents()),false)
 await call('partner_chat_say',{text:'重复的动作告知',beforeTools:true,expectedTools:['generate_image']});assert.deepEqual(sent,['哥哥来啦','我画给你看'])
 assert.equal((await call('generate_image')).isError,false);assert.equal(executed,1)
 const completed=await call('partner_chat_reply',{messages:[{text:'画出来啦'}]});assert.equal(completed.isError,false);assert.equal(completed.concludesTurn,true)
 agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'再画一张'}]}),{surfaceOp:'append'})
 assert.equal((await call('generate_image')).isError,true)
 await call('partner_chat_say',{text:'这次画小一点',beforeTools:true,expectedTools:['generate_image']})
 assert.equal(hasCurrentSpeech(agent.session.snapshotEvents()),false,'a task preamble alone must not permit empty final')
 const invalid=await call('partner_chat_reply',{messages:[],taskDisposition:'blocked',taskReason:'用户取消'});assert.equal(invalid.isError,true)
 const invented=await call('partner_chat_reply',{messages:[{text:'服务安全系统拒绝了'}],taskDisposition:'blocked',taskReason:'收到服务拒绝',taskEvidence:{kind:'tool_error',callId:'fake-generation',excerpt:'安全系统拒绝'}});assert.equal(invented.isError,true);assert.equal(invented.concludesTurn,undefined);assert.equal(executed,1)
 const missing=await call('partner_chat_reply',{messages:[{text:'服务拒绝了'}],taskDisposition:'blocked',taskReason:'收到拒绝'});assert.equal(missing.isError,true);assert.equal(missing.concludesTurn,undefined)
 const blocked=await call('partner_chat_reply',{messages:[{text:'这张先不画啦'}],taskDisposition:'blocked',taskReason:'用户取消当前动作',taskEvidence:{kind:'not_executed'}});assert.equal(blocked.isError,false);assert.equal(blocked.concludesTurn,true)

 await call('partner_chat_say',{text:'好了，这张归你啦'})
 assert.equal(hasCurrentSpeech(agent.session.snapshotEvents()),true)
})

test('failed, late or cancelled action speech cannot release work; repeated in-flight preamble sends once',async t=>{
 const {TaskPreambleGate}=await import('../lib/execution/task-preamble.js')
 const events=[start,user()],gate=new TaskPreambleGate(()=>events,async()=>assert.fail(),()=>true,()=>true,true)
 const receipt={...speech(),data:{...speech().data,meta:{...speech().data.meta,taskPreamble:true}}}
 assert.match(await gate.before('generate_image',{}),/partner_chat_say/)
 events.push({...receipt,data:{...receipt.data,message:{isError:true}}});assert.match(await gate.before('generate_image',{}),/尚未执行/)
 events.push(receipt);assert.equal(await gate.before('generate_image',{}),undefined)
 events.push(user('next',5),receipt);assert.match(await gate.before('generate_image',{}),/尚未执行/)
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:{snapshotEvents:()=>[start,user()]}},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 let release;const wait=new Promise(r=>release=r);const sent=[]
 t.after(installLiveSpeech(agent,async text=>{sent.push(text);await wait},()=> 'r'))
 t.after(scope.ctx.tools.register({name:'generate_image',description:'image',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>({})}))
 const tool=scope.ctx.tools.get('partner_chat_say',agent),exec={signal:signal()}
 const a=tool.execute({text:'我去看看',beforeTools:true,expectedTools:['generate_image']},exec),b=tool.execute({text:'不要重复发',beforeTools:true,expectedTools:['generate_image']},exec)
 await new Promise(r=>setImmediate(r));assert.deepEqual(sent,['我去看看']);release();await Promise.all([a,b])
})

test('unknown names never send; recall then additional image obligations persist without repeating the preamble',async t=>{
 const {pendingActions}=await import('../lib/chat/action-obligation.js')
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('staged'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 const state={companions:[{id:'c',toolDiscovery:true,characterCard:{enabled:true,segmentedReplies:true}}],channels:[],sessions:[{id:'r',kind:'local',companionId:'c',sessionId:agent.session.id}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false},sent=[],executed=[]
 t.after(installToolDiscovery(scope.ctx.tools,'c',store,[]));t.after(installLiveSpeech(agent,async text=>sent.push(text),()=> 'r'))
 for(const name of ['partner_memory_recall','generate_image','partner_send_attachment'])t.after(scope.ctx.tools.register({name,description:name,parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>{executed.push(name);return {ok:true}}}))
 t.after(scope.ctx.tools.register(chatTools('c',store,{},{},{},'/api').find(t=>t.name==='partner_chat_reply')))
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'看看屋里有什么'}]}),{surfaceOp:'append'})
 let seq=0;const call=async(name,args={})=>{const request={name,arguments:args,agent,signal:signal(),callId:'stage-'+seq++};agent.session.append('tool/call',{name,arguments:JSON.stringify(args),callId:request.callId});const result=await root.tools.execute(request);agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{id:request.callId,role:'tool',source:{kind:'tool',callId:request.callId},toolCallId:request.callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'});return result}
 const wrong=await call('partner_chat_say',{text:'我画给你看',beforeTools:true,expectedTools:['image_gen.imagegen','partner_send_attachment']})
 assert.equal(wrong.isError,true);assert.deepEqual(sent,[]);assert.deepEqual(pendingActions(agent.session.snapshotEvents()),[])
 await call('partner_chat_say',{text:'我想想屋里的摆设',beforeTools:true,expectedTools:['partner_memory_recall']});await call('partner_memory_recall')
 assert.deepEqual(pendingActions(agent.session.snapshotEvents()),[])
 const extra=await call('partner_chat_say',{text:'我把这边也画出来',beforeTools:true,expectedTools:['generate_image','partner_send_attachment']})
 assert.equal(extra.isError,false);assert.deepEqual(sent,['我想想屋里的摆设'])
 assert.deepEqual(pendingActions(agent.session.snapshotEvents()),['generate_image','partner_send_attachment'])
 const early=await call('partner_chat_reply',{messages:[{text:'找到座钟啦'}]});assert.equal(early.isError,true)
 await call('partner_chat_say',{text:'找到座钟啦'});assert.deepEqual(sent,['我想想屋里的摆设','找到座钟啦'])
 await call('generate_image');assert.deepEqual(pendingActions(agent.session.snapshotEvents()),['partner_send_attachment'])
 await call('partner_send_attachment');assert.deepEqual(pendingActions(agent.session.snapshotEvents()),[])
 await call('partner_chat_say',{text:'重复告知',beforeTools:true,expectedTools:['generate_image','partner_send_attachment']})
 assert.deepEqual(pendingActions(agent.session.snapshotEvents()),[]);assert.equal(sent.length,2)
 const done=await call('partner_chat_reply',{messages:[{text:'在这儿呢'}]});assert.equal(done.isError,false);assert.equal(done.concludesTurn,true)
 assert.deepEqual(executed,['partner_memory_recall','generate_image','partner_send_attachment'])
})

test('speech length preference adds no retry while action completion and preamble dedup remain enforced',async t=>{
 const {pendingActions}=await import('../lib/chat/action-obligation.js')
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('short-feedback'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 const state={companions:[{id:'c',toolDiscovery:true,characterCard:{enabled:true,length:'short',segmentedReplies:true}}],channels:[],sessions:[{id:'r',kind:'local',companionId:'c',sessionId:agent.session.id}]},store={snapshot:()=>state,isCompanionRemoving:()=>false},sent=[]
 t.after(installToolDiscovery(scope.ctx.tools,'c',store,[]));t.after(installLiveSpeech(agent,async text=>sent.push(text),()=> 'r'))
 let executed=0;t.after(scope.ctx.tools.register({name:'generate_image',description:'image',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>{executed++;return {ok:true}}}))
 t.after(scope.ctx.tools.register(chatTools('c',store,{},{},{},'/api').find(t=>t.name==='partner_chat_reply')))
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'画一张图'}]}),{surfaceOp:'append'})
 let seq=0;const call=async(name,args={})=>{const request={name,arguments:args,agent,signal:signal(),callId:'short-'+seq++};agent.session.append('tool/call',{name,arguments:JSON.stringify(args),callId:request.callId});const result=await root.tools.execute(request);agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{id:request.callId,role:'tool',source:{kind:'tool',callId:request.callId},toolCallId:request.callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'});return result}
 const long='接下来我会根据你说的内容绘制一张图片并查看结果。'
 const denied=await call('partner_chat_say',{text:long,beforeTools:true,expectedTools:['generate_image']})
 assert.equal(denied.isError,false);assert.deepEqual(sent,[long]);assert.deepEqual(pendingActions(agent.session.snapshotEvents()),['generate_image']);assert.equal(executed,0)
 const retry=await call('partner_chat_say',{text:'我来画',beforeTools:true,expectedTools:['generate_image']})
 assert.equal(retry.isError,false);assert.deepEqual(sent,[long]);assert.deepEqual(pendingActions(agent.session.snapshotEvents()),['generate_image'])
 const premature=await call('partner_chat_reply',{messages:[{text:'画好了'}]});assert.equal(premature.isError,true);assert.ok(!premature.concludesTurn)
 await call('generate_image');assert.equal(executed,1)
 const final=await call('partner_chat_reply',{messages:[{text:'图片已经生成了但是还没有发送出去我会等你决定下一步。'}]})
 assert.equal(final.isError,false);assert.equal(final.concludesTurn,true);assert.equal(executed,1)
})

test('invalid action preamble can be corrected without caching unsent failure; unknown delivery stays sticky',async t=>{
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('preamble-validation'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 const sent=[];let fail=false
 t.after(installLiveSpeech(agent,async text=>{sent.push(text);if(fail)throw Error('delivery unknown')},()=> 'r',()=>true,()=>true))
 t.after(scope.ctx.tools.register({name:'generate_image',description:'image',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>({})}))
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'draw'}]}),{surfaceOp:'append'})
 const tool=scope.ctx.tools.get('partner_chat_say',agent),exec={signal:signal()},args={beforeTools:true,expectedTools:['generate_image']}
 await assert.rejects(tool.execute({...args,text:'提示词：\n普通插画'},exec),/最多/)
 assert.deepEqual(sent,[])
 await tool.execute({...args,text:'开始画'},exec);assert.deepEqual(sent,['开始画'])
 agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'again'}]}),{surfaceOp:'append'})
 fail=true;await assert.rejects(tool.execute({...args,text:'再画'},exec),/delivery unknown/)
 await assert.rejects(tool.execute({...args,text:'不要重复发'},exec),/delivery unknown/)
 assert.deepEqual(sent,['开始画','再画'])
})
