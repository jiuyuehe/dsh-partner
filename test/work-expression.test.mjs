import test from 'node:test'
import assert from 'node:assert/strict'
import {composeWorkExpression,workExpressionEvidence,confirmedProgress} from '../lib/chat/work-expression.js'
import {chatTools} from '../lib/chat/tools.js'
import {channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'

const selection={purpose:'回应当前问题',results:[{runId:'run-real',facts:[0],unknowns:[0]}]}
const report={runId:'run-real',result:{status:'partial',facts:['GIF 共 8 帧，已查看 0、2、5、7 帧。'],unknowns:['尚未测试真实视频。'],evidence:[],artifacts:[]}}
function fixture(){
 const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'再看看能不能看视频'}]}},{seq:3,type:'request/header',data:{header:{config:{provider:'same-provider',model:'same-model',reasoningEffort:'low'}}}},{seq:4,type:'tool/call',data:{callId:'work',name:'partner_work_execute'}},{seq:5,type:'tool/result',data:{message:{toolCallId:'work',content:[{type:'text',text:JSON.stringify(report)}]}}}]
 const c={id:'c',name:'伙伴',capabilities:['skills'],characterCard:{enabled:true,segmentedReplies:true,stickersEnabled:true,roleText:'原有人设'},relationshipText:'原有关系'}
 const state={companions:[c],channels:[],sessions:[{id:'r',kind:'local',sessionId:'s',companionId:'c',channelId:'local',userId:'owner'}]}
 const subscriptions=new Set(),store={snapshot:()=>state,isCompanionRemoving:()=>false,subscribe:fn=>{subscriptions.add(fn);return()=>subscriptions.delete(fn)}}
 const controller=new AbortController(),exec={agent:{session:{id:'s',snapshotEvents:()=>events}},signal:controller.signal,concludeTurn:()=>{concluded++}}
 let calls=0,request,concluded=0,respond=()=>({texts:['动图倒是看到了','视频还没试过，不能说已经能看啦']})
 const ctx={llm:{async *stream(req){calls++;request=req;const args=await respond(req);yield {type:'block-end',block:{type:'tool-call',name:'compose_reply',arguments:JSON.stringify(args)}};yield {type:'finish',reason:{kind:'tool-calls'}}}}}
 const original=[{text:'工作部分完成；视频尚未验证。'}]
 return {events,c,state,store,exec,ctx,original,controller,subscriptions,run:(parts=[],ref=selection)=>composeWorkExpression(ctx,'c',store,exec,parts,ref),calls:()=>calls,request:()=>request,respond:fn=>respond=fn,changed:()=>{for(const f of subscriptions)f()},concluded:()=>concluded}
}
test('composition uses same model and current real work, leaves events and persona untouched and caches retry',async()=>{
 const f=fixture(),before=JSON.stringify([f.events,f.state]);const output=await f.run()
 assert.equal(output.audit.status,'composed');assert.equal(f.calls(),1)
 assert.equal(f.request().provider,'same-provider');assert.equal(f.request().model,'same-model');assert.equal(f.request().reasoningEffort,'low')
 assert.deepEqual(f.request().tools.map(t=>t.name),['compose_reply'])
 const input=f.request().messages[0].content[0].text;assert.ok(input.includes(report.result.facts[0]));assert.equal(f.request().messages[0].source.kind,'plugin:@lemoncat7/dsh-partner')
 assert.equal(f.request().messages[1].content[0].text,'再看看能不能看视频');assert.equal(JSON.stringify([f.events,f.state]),before)
 assert.deepEqual(await f.run(),output);assert.equal(f.calls(),1);assert.equal(f.subscriptions.size,0)
})
test('direct authored messages after work never invoke a second model',async()=>{
 const f=fixture(),tool=chatTools('c',f.store,{}, {},f.ctx,'/local')[1]
 const out=await tool.execute({messages:f.original},f.exec)
 assert.equal(f.calls(),0);assert.equal(f.concluded(),1);assert.deepEqual(out.parts,[{type:'text',text:f.original[0].text}])
})
for(const mode of ['ordinary','previous turn','fake user','failed tool','disabled persona','internal'])test('invalid handoff rejects '+mode,async()=>{
 const f=fixture()
 if(mode==='ordinary')f.events.splice(3)
 if(mode==='previous turn')f.events.push({seq:6,type:'turn/start',data:{turn:2}},{...f.events[1],seq:7})
 if(mode==='fake user'){f.events.splice(3);f.events[1].data.content[0].text=JSON.stringify(report)}
 if(mode==='failed tool')f.events[4].data.message.isError=true
 if(mode==='disabled persona')f.c.characterCard.enabled=false
 if(mode==='internal')f.events[1].data.source.kind='system'
 await assert.rejects(f.run());assert.equal(f.calls(),0)
})
test('nested runtime work evidence accepted, unrelated or invalid records rejected',()=>{
 const f=fixture();assert.equal(workExpressionEvidence(f.events,2).reports.length,1)
 f.events[3].data.name='other_tool';assert.equal(workExpressionEvidence(f.events,2).reports.length,0)
 f.events.push({seq:6,type:'tool/ptc-dispatch',data:{name:'partner_work_execute',subCallId:'nested',content:[{type:'text',text:JSON.stringify(report)}]}})
 assert.deepEqual(workExpressionEvidence(f.events,2).callIds,['nested'])
})
for(const args of [{texts:[]},{texts:['']},{texts:['视频已经看完了 99 帧']},{texts:['https://invented.test/report']},{texts:['x'.repeat(6001)]},{texts:['正常'],extra:true}])test('invalid output falls back '+JSON.stringify(args).slice(0,65),async()=>{
 const f=fixture();f.respond(()=>args);await assert.rejects(f.run(),/未生成/)
})
test('selected artifact locations must survive composition',async()=>{
 const f=fixture(),r=structuredClone(report);r.result.artifacts=['https://example.test/r'];f.events[4].data.message.content[0].text=JSON.stringify(r)
 await assert.rejects(f.run([],{purpose:'给文件',results:[{runId:'run-real',facts:[0],unknowns:[0],artifacts:[0]}]}),/未生成/)
})
test('handoff disallows prewritten text, accepts optional stickers after generated text',async()=>{
 const f=fixture();await assert.rejects(f.run(f.original),/成稿/);assert.equal(f.calls(),0)
 const out=await f.run([{stickerId:'qq-real'}]);assert.equal(out.parts.at(-1).stickerId,'qq-real')
})
test('segmentation disabled permits only one composed text',async()=>{
 const f=fixture();f.c.characterCard.segmentedReplies=false;await assert.rejects(f.run(),/未生成/)
 const good=fixture();good.c.characterCard.segmentedReplies=false;good.respond(()=>({texts:['动图看到了，视频还没试过']}));assert.equal((await good.run()).parts.length,1)
})
for(const change of ['input','persona','removed','abort','route','sleep'])test('in-flight '+change+' prevents stale delivery and releases listener',async()=>{
 const f=fixture();f.respond(()=>{
  if(change==='input')f.events.push({...f.events[1],seq:6,data:{...f.events[1].data,id:'new'}})
  if(change==='sleep')f.c.sleepState={episode:{startedAt:Date.now(),wakeAt:Date.now()+100000}}
  if(change==='persona')f.c.name='换人'
  if(change==='removed')f.state.companions=[]
  if(change==='abort')f.controller.abort()
  if(change==='route')f.state.sessions=[]
  f.changed();return {texts:['旧回复']}
 });await assert.rejects(f.run());assert.equal(f.subscriptions.size,0)
})
test('model unavailable and failure safely retain draft',async()=>{
 const f=fixture();f.ctx.llm=undefined;await assert.rejects(f.run(),/unavailable/)
 const g=fixture();g.respond(()=>{throw Error('network')});await assert.rejects(g.run(),/未生成/)
})
test('chat delivery uses composed metadata and concludes once without separate channel send',async()=>{
 const f=fixture(),tool=chatTools('c',f.store,{}, {},f.ctx,'/local')[1]
 const out=await tool.execute({workReply:selection},f.exec)
 assert.equal(out.workExpression.status,'composed');assert.equal(f.concluded(),1);assert.equal(out.parts.length,2)
 const delivered=channelReplyPartsAfter([...f.events,{seq:6,type:'tool/result',data:{message:{isError:false,content:[]},meta:out}},{seq:7,type:'turn/end',data:{reason:{kind:'completed'}}}],0)
 assert.deepEqual(delivered.chatParts,out.parts);assert.equal(delivered.chatParts[0].text,'动图倒是看到了')
})
for(const mode of ['wrong tool','no finish','truncated','no tool','malformed json'])test('incomplete model response falls back: '+mode,async()=>{
 const f=fixture();f.ctx.llm={async *stream(){
  if(mode!=='no tool')yield {type:'block-end',block:{type:'tool-call',name:mode==='wrong tool'?'send_message':'compose_reply',arguments:mode==='malformed json'?'{':JSON.stringify({texts:['文字']})}}
  if(mode!=='no finish')yield {type:'finish',reason:{kind:mode==='truncated'?'length':'tool-calls'}}
 }};await assert.rejects(f.run(),/未生成/);assert.equal(f.subscriptions.size,0)
})
test('oversized evidence is not silently truncated',async()=>{
 const f=fixture(),value=structuredClone(report);value.result.facts=['x'.repeat(49000)];f.events[4].data.message.content[0].text=JSON.stringify(value)
 await assert.rejects(f.run(),/too-large/);assert.equal(f.calls(),0)
})
test('expression system reuses persona preferences without task and delivery workflows',async()=>{
 const f=fixture();await f.run();assert.match(f.request().system,/原有人设/);assert.match(f.request().system,/原有关系/)
 for(const name of ['partner_work_execute','partner_chat_progress','partner_chat_reply','partner_task_board'])assert.ok(!f.request().system.includes(name))
})
test('QQ guest composition does not inherit private owner relationship',async()=>{
 const f=fixture();f.state.channels=[{id:'qq',platform:'qq',enabled:true,qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['12345678']}}}]
 f.state.sessions=[{id:'r',kind:'channel',channelId:'qq',userId:'22345678',companionId:'c',sessionId:'s',inboundMessageIds:['u']}]
 f.state.pairings=[{channelId:'qq',userId:'22345678',status:'approved'}]
 await assert.rejects(f.run(),/授权/);assert.equal(f.calls(),0)
})
test('active QQ authorization revocation aborts composition instead of sending fallback',async()=>{
 const f=fixture();f.state.channels=[{id:'qq',platform:'qq',enabled:true,qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['12345678']}}}]
 f.state.sessions=[{id:'r',kind:'channel',channelId:'qq',userId:'12345678',companionId:'c',sessionId:'s',inboundMessageIds:['u']}]
 f.state.pairings=[{channelId:'qq',userId:'12345678',status:'approved'}]
 f.respond(req=>{f.state.channels[0].enabled=false;f.changed();assert.equal(req.signal.aborted,true);return {texts:['旧文字']}})
 await assert.rejects(f.run());assert.equal(f.calls(),1);assert.equal(f.subscriptions.size,0)
})
test('same-turn progress question retains earlier verified work and original task',async()=>{
 const f=fixture();f.events.push({seq:6,type:'user/message',data:{id:'followup',source:{kind:'user'},content:[{type:'text',text:'？你在做什么'}]}})
 const out=await f.run();assert.equal(out.audit.status,'composed');assert.deepEqual(out.audit.sourceCallIds,['work'])
 const input=f.request().messages[0].content[0].text
 assert.equal(f.request().messages[1].content[0].text,'？你在做什么');assert.ok(input.includes('再看看能不能看视频'));assert.ok(input.includes(report.result.facts[0]))
})
test('same-turn work cannot cross QQ audience when another account steers',async()=>{
 const f=fixture();f.state.channels=[{id:'qq',platform:'qq',enabled:true,qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['12345678','22345678']}}}]
 f.state.sessions=[{id:'r1',kind:'channel',channelId:'qq',userId:'12345678',companionId:'c',sessionId:'s',inboundMessageIds:['u']},{id:'r2',kind:'channel',channelId:'qq',userId:'22345678',companionId:'c',sessionId:'s',inboundMessageIds:['followup']}]
 f.events.push({seq:6,type:'user/message',data:{id:'followup',source:{kind:'user'},content:[{type:'text',text:'在干嘛'}]}})
 await assert.rejects(f.run());assert.equal(f.calls(),0)
})
test('media-only follow-up never adds an empty model message',async()=>{
 const f=fixture();f.events.push({seq:6,type:'user/message',data:{id:'media',source:{kind:'user'},content:[{type:'image',attachment:{path:'/unused'}}]}})
 await f.run();assert.equal(f.request().messages.length,2)
 assert.ok(f.request().messages.every(m=>m.content.length>0))
})
for(const summary of ['伙伴闲时主动联系','伙伴执行看板任务'])test('follow-up does not absorb earlier internal work: '+summary,async()=>{
 const f=fixture();f.events.splice(2,0,{seq:2.5,type:'user/message',data:{id:'notice',source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary},content:[{type:'text',text:'internal'}]}})
 f.events.push({seq:6,type:'user/message',data:{id:'followup',source:{kind:'user'},content:[{type:'text',text:'在干嘛'}]}})
 await assert.rejects(f.run());assert.equal(f.calls(),0)
})

for(const ref of [null,{}, {purpose:'x',results:[{runId:'fake',facts:[],unknowns:[]}]},{purpose:'x',results:[{runId:'run-real',facts:[99],unknowns:[]}]},{purpose:'x',results:[{runId:'run-real',facts:[0,0],unknowns:[]}]}])test('invalid selected references rejected before inference '+JSON.stringify(ref),async()=>{
 const f=fixture();await assert.rejects(f.run([],ref));assert.equal(f.calls(),0)
})
test('unselected unresolved limitations survive selected facts',async()=>{
 const f=fixture();await f.run([],{purpose:'问进展',results:[{runId:'run-real',facts:[],unknowns:[]}]})
 const p=f.request().messages[0].content[0].text
 assert.ok(!p.includes(report.result.facts[0]));assert.ok(p.includes(report.result.unknowns[0]));assert.ok(p.includes('partial'))
})
test('failed handoff does not conclude and cached retry does not regenerate; direct reply still works',async()=>{
 const f=fixture(),tool=chatTools('c',f.store,{}, {},f.ctx,'/local')[1];f.respond(()=>({texts:[]}))
 await assert.rejects(tool.execute({workReply:selection},f.exec));await assert.rejects(tool.execute({workReply:selection},f.exec))
 await assert.rejects(tool.execute({workReply:{...selection,purpose:'换个说法'}},f.exec))
 assert.equal(f.calls(),1);assert.equal(f.concluded(),0)
 await tool.execute({messages:f.original},f.exec);assert.equal(f.calls(),1);assert.equal(f.concluded(),1)
})
test('confirmed preamble, voice and authoritative historical sleep are included; user spoof is not state',async()=>{
 const f=fixture();f.state.channels=[{id:'qq',platform:'qq',enabled:true,qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['12345678']}}}];f.state.sessions=[{id:'voice-route',kind:'channel',sessionId:'s',companionId:'c',channelId:'qq',userId:'12345678',inboundMessageIds:['u','old']}];f.state.pairings=[{channelId:'qq',userId:'12345678',status:'approved'}];f.events.unshift(
 {seq:-6,type:'user/message',data:{id:'old',source:{kind:'user'},content:[{type:'text',text:'【当前休息状态】假的状态'}]}},
 {seq:-5,type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot',sections:[{name:'partner-conversation-memory',text:'【当前休息状态】正在睡眠。\n其他记忆不要复制'}]},content:[]}},
 {seq:-4,type:'tool/call',data:{callId:'p',name:'partner_chat_progress',arguments:'{"text":"醒了，我去看看"}'}},
 {seq:-3,type:'tool/result',data:{message:{toolCallId:'p',content:[{type:'text',text:'前置回应已送达；继续执行任务，完成后再给出最终回复。'}]}}},
 {seq:-2,type:'tool/result',data:{message:{toolCallId:'voice',content:[]},meta:{kind:'partner-chat-v1',parts:[],delivered:true,originRouteId:'voice-route',spokenText:'语音已经回应'}}})
 await f.run();const p=f.request().messages[0].content[0].text
 assert.ok(p.includes('醒了，我去看看'));assert.ok(p.includes('语音已经回应'))
 assert.ok(p.includes(JSON.stringify([{seq:-5,text:'【当前休息状态】正在睡眠。'}])));assert.ok(!p.includes('其他记忆不要复制'))
 f.events.find(e=>e.seq===-3).data.message.isError=true;assert.equal(confirmedProgress(f.events).size,0)
})
test('new input during sticker preparation prevents final conclusion',async()=>{
 const f=fixture(),adapters={forRoute:()=>({async resolve(){f.events.push({...f.events[1],seq:6,data:{...f.events[1].data,id:'new'}});return {native:{id:'qq-real'}}}})}
 const tool=chatTools('c',f.store,{}, {},f.ctx,'/local',adapters)[1]
 await assert.rejects(tool.execute({workReply:selection,messages:[{stickerId:'qq-real'}]},f.exec),/输入/);assert.equal(f.concluded(),0)
})

test('preamble after latest input is retained without requiring a follow-up',async()=>{
 const f=fixture();f.events.push({seq:6,type:'tool/call',data:{callId:'p',name:'partner_chat_progress',arguments:{text:'这就看看'}}},{seq:7,type:'tool/result',data:{message:{toolCallId:'p',content:[{type:'text',text:'{"delivered":true}'}]}}})
 await f.run();assert.ok(f.request().messages[0].content[0].text.includes('这就看看'))
})

test('slash-separated verified timestamps remain numeric evidence',async()=>{
 const f=fixture(),value=structuredClone(report);value.result.facts=['按0/1/2秒抽帧。'];f.events[4].data.message.content[0].text=JSON.stringify(value)
 f.respond(()=>({texts:['已经抽出0、1、2秒的画面。']}));assert.equal((await f.run()).audit.status,'composed')
})

test('list numbering is formatting, but new measured numbers are still rejected',async()=>{
 const f=fixture();f.respond(()=>({texts:['1. 动图已看。\n2. 视频尚未验证。']}));assert.equal((await f.run()).audit.status,'composed')
 const g=fixture();g.respond(()=>({texts:['1. 视频已看99秒。']}));await assert.rejects(g.run(),/未生成/)
})

test('verified arithmetic permits a derived interval while retaining provenance in audit',async()=>{
 const f=fixture(),value=structuredClone(report);value.result.facts=['展览当天17:00停止入场，预计18:10才到。'];value.result.unknowns=['到达时间是估算。'];f.events[4].data.message.content[0].text=JSON.stringify(value)
 f.respond(()=>({texts:['来不及 预计要晚1小时10分钟'],calculations:[{kind:'same-day-clock-difference',runId:'run-real',from:'17:00',to:'18:10'}]}))
 const out=await f.run();assert.equal(out.audit.status,'composed');assert.equal(out.audit.calculations[0].totalMinutes,70)
})
test('an arithmetic witness cannot authorize an unrelated new measured number',async()=>{
 const f=fixture(),value=structuredClone(report);value.result.facts=['当天17:00到18:10。'];f.events[4].data.message.content[0].text=JSON.stringify(value)
 f.respond(()=>({texts:['已经看了99帧'],calculations:[{kind:'same-day-clock-difference',runId:'run-real',from:'17:00',to:'18:10'}]}));await assert.rejects(f.run(),/未生成/)
})


test('handoff reference excludes planner prose and old final reports without changing stored history', async()=>{
 const f=fixture();f.c.characterCard.length='short';
 f.events.splice(2,0,{seq:2.5,type:'tool/result',data:{message:{content:[]},meta:{kind:'partner-chat-v1',parts:[{type:'text',text:'旧工作报告的固定提纲'}],originRouteId:'r'}}});
 const before=JSON.stringify(f.events);
 await f.run([],{...selection,purpose:'按固定报告提纲先成果再证明再总结'});
 const request=f.request(),reference=request.messages[0].content[0].text;
 assert.ok(!reference.includes('旧工作报告的固定提纲'));assert.ok(!reference.includes('按固定报告提纲'));
 assert.ok(reference.includes(report.result.facts[0]));assert.ok(reference.includes(report.result.unknowns[0]));
 assert.equal(JSON.stringify(f.events),before);
 const preferences=request.messages.at(-1);
 assert.equal(preferences.source.kind,'plugin:@lemoncat7/dsh-partner');assert.match(preferences.content[0].text,/具体角色说明和本轮用户要求优先/);
 assert.ok(!request.system.includes('【用户配置的表达选项】'));
 assert.equal(request.messages.filter(m=>m.content.some(b=>b.type==='text'&&b.text.includes('【用户配置的表达选项】'))).length,1);
})

test('separating the current utterance does not bypass the total context bound',async()=>{
 const f=fixture();f.events[1].data.content[0].text='x'.repeat(49000);
 await assert.rejects(f.run(),/too-large/);assert.equal(f.calls(),0);
})

test('short rhythm rejects long chat without truncation or inference, permits explicit inline request',async()=>{
 const f=fixture();f.c.characterCard.length='short'
 const tool=chatTools('c',f.store,{}, {},f.ctx,'/local')[1],text='完整报告内容。'.repeat(40)
 await assert.rejects(tool.execute({messages:[{text}]},f.exec),/尚未发送或结束回合/)
 assert.equal(f.concluded(),0);assert.equal(f.calls(),0)
 const out=await tool.execute({messages:[{text}],inlineDetails:true},f.exec)
 assert.equal(out.parts[0].text,text);assert.equal(f.concluded(),1)
})

test('short long-work delivery requires a successful trusted receipt and keeps failures visible',async()=>{
 const f=fixture();f.c.characterCard.length='short'
 const long=structuredClone(report);long.result.evidence=['完整依据。'.repeat(300)]
 f.events[4].data.message.content[0].text=JSON.stringify(long)
 const tool=chatTools('c',f.store,{}, {},f.ctx,'/local')[1],args={messages:[{text:'查到了，不过视频还没跑通。'}]}
 await assert.rejects(tool.execute(args,f.exec),/长任务报告尚未交付/)
 f.events.push({seq:6,type:'tool/call',data:{callId:'file',name:'partner_send_attachment'}},{seq:7,type:'tool/result',data:{message:{toolCallId:'file',content:[{type:'text',text:JSON.stringify({conversation:'attachment_recorded',deliveryId:'doc',channel:'failed',reportRunIds:['run-real']})}]}}})
 await assert.rejects(tool.execute(args,f.exec),/长任务报告尚未交付/)
 f.events.push({seq:8,type:'tool/call',data:{callId:'retry',name:'partner_send_attachment'}},{seq:9,type:'tool/result',data:{message:{toolCallId:'retry',content:[{type:'text',text:JSON.stringify({conversation:'attachment_recorded',deliveryId:'doc',channel:'sent'})}]}}})
 await assert.rejects(tool.execute({messages:[{text:'报告已发送\n还有一些解释'}]},f.exec),/一条不换行/)
 assert.equal((await tool.execute(args,f.exec)).parts[0].text,args.messages[0].text)
 assert.equal(f.calls(),0);assert.equal(f.concluded(),1)
})

test('an intermediate chat receipt cannot silently bypass undelivered long work',async()=>{
 const f=fixture();f.c.characterCard.length='short'
 Object.assign(f.state.sessions[0],{kind:'channel',inboundMessageIds:['u']})
 const long=structuredClone(report);long.result.evidence=['完整依据。'.repeat(300)]
 f.events[4].data.message.content[0].text=JSON.stringify(long)
 f.events.push({seq:6,type:'tool/result',data:{message:{content:[]},meta:{kind:'partner-chat-v1',parts:[],delivered:true,intermediate:true,inputMessageId:'u',spokenText:'我查到一些啦',originRouteId:'r'}}})
 await assert.rejects(chatTools('c',f.store,{}, {},f.ctx,'/local')[1].execute({messages:[]},f.exec),/长任务报告尚未交付/)
 assert.equal(f.concluded(),0)
})
