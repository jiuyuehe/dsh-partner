import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'
import {NotificationDelivery} from '../lib/channels/notification-delivery.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
import {prepareChannelReply} from '../lib/channels/outbound-media.js'
import {segmentChatInput,segmentIdleChatReply,parseChatInput,replyDeliveryParts,withChatCompanionText} from '../lib/chat/protocol.js'
import {StickerLibrary,stickerMediaType} from '../lib/chat/stickers.js'
import {AttachmentDeliveryService} from '../lib/attachments/service.js'
import {chatTools} from '../lib/chat/tools.js'
import {chatReplyDefinition,nativeChatBlocks,registerChatReplies} from '../lib/chat/conversation.js'

const image={type:'image',attachment:{path:'/snapshot/image',name:'开心.png',kind:'image',mediaType:'image/png'},url:'/partner-local/v1/attachments/test',label:'开心'}
const meta={kind:'partner-chat-v1',parts:[{type:'text',text:'你可算来了'},image,{type:'text',text:'还以为今天不来了'}]}
const start={type:'turn/start',seq:1,data:{turn:1}},user={type:'user/message',seq:2,data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'来了'}]}}
const result={type:'tool/result',seq:4,data:{message:{isError:false,content:[]},meta}},end={type:'turn/end',seq:5,data:{reason:{kind:'completed'}}}

test('explicit bubbles preserve paragraphs/code, reject empty and mixed messages',()=>{
  const code='a\n\nb\n```js\nx();\n```'
  assert.deepEqual(parseChatInput({messages:[{text:code}]}),[{text:code}])
  for(const messages of [[],[{text:''}],[{text:'a',stickerId:'b'}],Array(9).fill({text:'a'}),Array(3).fill({stickerId:'builtin-happy'})])assert.throws(()=>parseChatInput({messages}))
})
test('completed chat tool is final reply; error/interruption/internal turns never forward it',async()=>{
  const events=[start,user,result,end],parts=channelReplyPartsAfter(events,0)
  assert.deepEqual(parts.chatParts,meta.parts)
  assert.equal((await prepareChannelReply(parts,'/unused')).chatParts.length,3)
  assert.match(parts.text,/你可算来了.*\n.*表情/s)
  for(const failed of [{...result,data:{...result.data,message:{isError:true}}},{...result,data:{meta:{kind:'partner-chat-v1',parts:[null]},message:{isError:false}}}])assert.equal(channelReplyPartsAfter([start,user,failed,end],0).chatParts,undefined)
  assert.equal(channelReplyPartsAfter([start,user,result,{...end,data:{reason:{kind:'interrupted'}}}],0).text,'')
  assert.equal(channelReplyPartsAfter([start,result,end],0).text,'')
  const nested={...result,type:'tool/ptc-dispatch'}
  assert.deepEqual(channelReplyPartsAfter([start,user,nested,{type:'tool/result',seq:4.5,data:{message:{isError:false}}},end],0).chatParts,meta.parts)
})
test('interleaved delivery resumes after restart without resending acknowledged bubbles or image',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chat-ledger-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const path=join(root,'state.json'),store=await PartnerStore.open(path),target={channelId:'c',userId:'u'},sent=[]
  let fail=true
  const send=async(_target,reply,part)=>{for(const [i,p] of replyDeliveryParts(reply).entries())await part(i,async()=>{if(i===2&&fail)throw Error('offline');sent.push(p.type==='text'?p.text:p.attachment.name)})}
  const reply={text:'fallback',attachments:[],chatParts:meta.parts}
  await assert.rejects(new NotificationDelivery(store).deliver('one','owner',()=>[target],reply,send))
  assert.deepEqual(sent,['你可算来了','开心.png'])
  const reopened=await PartnerStore.open(path);fail=false
  await new NotificationDelivery(reopened).deliver('one','owner',()=>[{channelId:'other',userId:'wrong'}],{text:'changed',attachments:[]},send)
  assert.deepEqual(sent,['你可算来了','开心.png','还以为今天不来了'])
  assert.ok(reopened.snapshot().notificationDeliveries[0].completedAt)
})
test('sticker library isolates companions, validates raster uploads and keeps private files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'stickers-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const library=new StickerLibrary(owner=>join(root,owner)),builtin=await library.image('a','builtin-happy')
  assert.equal(stickerMediaType(builtin.data),'image/png')
  const added=await library.upload('a','微笑',['开心'],builtin.data.toString('base64'))
  await assert.rejects(library.image('b',added.id),/不存在/)
  await assert.rejects(library.upload('a','坏图',[],Buffer.from('<svg onload="alert(1)"/>').toString('base64')),/只支持/)
  await assert.rejects(library.image('a','../../secret'),/标识/)
  assert.equal((await library.list('a','微笑')).length,1)
  assert.ok((await library.list('a','开心 得意 可爱')).some(s=>s.id==='builtin-happy'))
  await library.remove('a',added.id);await assert.rejects(library.image('a',added.id),/不存在/)
})
test('terminal tool snapshots stickers, respects revocation, and never sends to a channel itself',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chat-tool-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const deliveries=await AttachmentDeliveryService.open(join(root,'delivery'));t.after(()=>deliveries.close())
  const library=new StickerLibrary(owner=>join(root,owner)),card={enabled:true,segmentedReplies:true,stickersEnabled:true}
  const state={companions:[{id:'a',characterCard:card}],sessions:[{sessionId:'s',companionId:'a'}]}
  const store={snapshot:()=>state,isCompanionRemoving:()=>false}
  let conclusions=0,events=[start,user]
  const exec={signal:new AbortController().signal,concludeTurn:()=>conclusions++,agent:{session:{id:'s',snapshotEvents:()=>events}}}
  const tool=chatTools('a',store,library,deliveries,{},'/partner-local/v1')[1]
  const outcome=await tool.execute({messages:[{text:'来了'},{stickerId:'builtin-happy'}]},exec)
  assert.equal(conclusions,1);assert.equal(outcome.parts.length,2)
  assert.ok((await readFile(outcome.parts[1].attachment.path)).length>100)
  assert.deepEqual(tool.output.presentationMeta({},outcome),outcome)
  events=[start,user,{type:'assistant/message',seq:3,data:{message:{content:[{type:'text',text:'留给你的。'},{type:'tool-call',id:'mixed',name:'partner_chat_reply',arguments:'{}'}]}}}]
  const mixed=await tool.execute({messages:[{stickerId:'builtin-happy'}]},{...exec,callId:'mixed'})
  assert.deepEqual(mixed.parts.map(p=>p.type),['text','image'])
  assert.equal(mixed.parts[0].text,'留给你的。')
  const transmitted=channelReplyPartsAfter([start,user,{...result,data:{...result.data,meta:mixed}},end],0)
  assert.deepEqual(transmitted.chatParts,mixed.parts)
  assert.match(transmitted.text,/留给你的/)
  assert.match(tool.output.render({},mixed)[0].text,/留给你的/)
  card.stickersEnabled=false
  await assert.rejects(tool.execute({messages:[{stickerId:'builtin-happy'}]},exec),/未开启/)
  assert.equal(conclusions,2)
  card.enabled=false;await assert.rejects(tool.execute({messages:[{text:'x'}]},exec),/停用/)
  card.enabled=true;events=[start];await assert.rejects(tool.execute({messages:[{text:'x'}]},exec),/内部任务/)
  assert.equal(conclusions,2)
})
test('chat metadata projects into the native assistant renderer without registering a custom bubble',()=>{
  let definition
  const registry={register(d){definition=d;return()=>{}}}
  const ctx={get:()=>({events:registry}),effect:fn=>fn(),inject:(keys,fn)=>{if(keys[0]==='uiConversation')fn(ctx)}}
  registerChatReplies(ctx);assert.equal(definition,chatReplyDefinition)
  assert.notEqual(definition.match(result).exclusive,true)
  const blocks=nativeChatBlocks(meta)
  assert.deepEqual(blocks.map(b=>b.kind),['text','text','text'])
  assert.equal(blocks[0].text,'你可算来了')
  assert.equal(blocks[1].text,'![开心](/partner-local/v1/attachments/test)')
  assert.equal(blocks[2].text,'还以为今天不来了')
  assert.equal(nativeChatBlocks(meta,'https://chat.example.test/')[1].text,'![开心](https://chat.example.test/partner-local/v1/attachments/test)')
  assert.doesNotMatch(JSON.stringify(blocks),/snapshot\/image/)
  assert.equal(definition.match({...result,data:{...result.data,message:{isError:true}}}),null)
})
test('terminal replies stay outside native process folding and leave tool results observable',()=>{
  for (const event of [result,{...result,type:'tool/ptc-dispatch'}]) {
    const match=chatReplyDefinition.match(event)
    assert.notEqual(match.exclusive,true,'native tool lifecycle must still receive the result')
    const location={kind:'step',turn:{turn:1},step:1}
    const node=chatReplyDefinition.buildViewNode({key:'reply',id:match.id,state:chatReplyDefinition.start({}, {event}),start:{event,location}})
    assert.equal(node.groupTree,'turn','DSH groups nodes without a position into collapsed process steps')
    assert.equal(node.visibility,'visible')
    assert.equal(node.location,location)
    assert.equal(node.kind,'assistant-step')
    assert.equal(node.data.status,'settled')
    assert.deepEqual(node.data.blocks,nativeChatBlocks(meta))
  }
})
test('direct queued reply checks the original route and rechecks authorization between parts',async()=>{
  const channel={id:'c',companionId:'a',enabled:true,accountId:'account',direct:{baseUrl:'https://example.test',targetId:'room'}}
  const source={routeId:'r',sessionId:'s',accountId:'account',baseUrl:'https://example.test',targetId:'room'}
  const state={channels:[channel],sessions:[{id:'r',sessionId:'s',companionId:'a',channelId:'c',userId:'u'}],pairings:[{channelId:'c',userId:'u',status:'approved'}]}
  const manager=new ChannelManager({logger:{warn(){}}},{snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false},{read:async()=>({})},{})
  let sent=0
  manager.sender=()=>({sendText:async()=>{sent++;state.pairings[0].status='blocked'},sendAttachment:async()=>{sent++}})
  const reply={text:'x',attachments:[],chatParts:meta.parts,directSource:source}
  await assert.rejects(manager.sendNotificationTarget('c','u',reply,async(_i,send)=>send()),/尚未批准/)
  assert.equal(sent,1)
  state.pairings[0].status='approved';channel.direct.targetId='new-room'
  assert.throws(()=>manager.checkChatSource('c','u',reply),/变更/)
})

test('DSH tool runtime commits terminal success and presentation metadata, but never concludes a rejected call',async t=>{
  const {Context}=await import('@deepseek-ai/cordis'),{ToolRuntime}=await import('@deepseek-ai/dsh-tools'),{createScope}=await import('@deepseek-ai/dsh-scope')
  const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(ctx)
  const card={enabled:true,segmentedReplies:true},store={snapshot:()=>({companions:[{id:'a',characterCard:card}],sessions:[{sessionId:'s',companionId:'a'}]}),isCompanionRemoving:()=>false}
  const agent={session:{id:'s',header:{},snapshotEvents:()=>[start,user]},options:{}}
  const scope=createScope(ctx,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
  scope.ctx.tools.register(chatTools('a',store,{}, {},ctx,'/partner-local/v1')[1])
  const invoke=()=>ctx.tools.execute({callId:'reply-call',name:'partner_chat_reply',arguments:{messages:[{text:'第一条'},{text:'第二条'}]},agent,signal:new AbortController().signal})
  const success=await invoke();assert.equal(success.isError,false);assert.equal(success.concludesTurn,true)
  assert.equal(success.meta.kind,'partner-chat-v1');assert.equal(success.meta.parts.length,2)
  card.enabled=false;const failure=await invoke();assert.equal(failure.isError,true);assert.equal(failure.concludesTurn,undefined)
})

test('memory observation receives structured spoken content without local attachment paths',async()=>{
  const {PartnerAgentRuntime}=await import('../lib/agent-runtime.js')
  const {createDefaultCompanion}=await import('../lib/domain.js')
  const companion=createDefaultCompanion();companion.automation.memory.enabled=true
  const route={id:'local',kind:'local',companionId:companion.id,channelId:'@local',userId:'owner',sessionId:'s'}
  const runtime=Object.create(PartnerAgentRuntime.prototype),seen=[]
  const state={companions:[companion],sessions:[route]}
  Object.assign(runtime,{store:{snapshot:()=>state,update:async fn=>fn(state)},reflection:{reflect:async(_companion,turn)=>{seen.push(turn);return[]}}})
  const ending={...end,time:123456,data:{turn:1,reason:{kind:'completed'}}}
  await runtime.processSessionEvent({id:'s',snapshotEvents:()=>[start,user,result,ending]},ending)
  assert.equal(seen.length,1);assert.match(seen[0].assistant,/你可算来了/);assert.match(seen[0].assistant,/表情：开心/)
  assert.doesNotMatch(seen[0].assistant,/snapshot\/image|partner-chat-v1/)
})

test('structured replies from browser or another channel cannot be forwarded by the original caller',async()=>{
  const state={sessions:[{id:'matrix',channelId:'mx',userId:'u',companionId:'a',sessionId:'s'}]}
  const manager=new ChannelManager({}, {snapshot:()=>state}, {}, {})
  for(const originRouteId of [null,'mattermost']){
    const response=await prepareChannelReply(channelReplyPartsAfter([start,user,{...result,data:{...result.data,meta:{...meta,originRouteId}}},end],0),'/unused')
    await assert.rejects(manager.sendChatReply({id:'mx',companionId:'a'},'u','event',response),/其他输入来源/)
  }
})


test('mixed provider speech belongs only to its exact terminal call, never reasoning or prior steps',()=>{
  const input=[{stickerId:'builtin-happy'}]
  const message={type:'assistant/message',seq:3,data:{message:{content:[{type:'reasoning',text:'private analysis'},{type:'text',text:'来了，给你留着呢。'},{type:'tool-call',id:'chat-1',name:'partner_chat_reply',arguments:'{}'}]}}}
  const events=[start,user,message]
  assert.deepEqual(withChatCompanionText(input,events,'chat-1'),[{text:'来了，给你留着呢。'},...input])
  for(const id of [undefined,'other-call'])assert.deepEqual(withChatCompanionText(input,events,id),input)
  assert.deepEqual(withChatCompanionText(input,[...events,{...start,seq:5}],'chat-1'),input)
  assert.deepEqual(withChatCompanionText(input,[...events,{...user,seq:5}],'chat-1'),input)
  assert.deepEqual(withChatCompanionText(input,[start,user,{...message,data:{...message.data,interrupted:true}}],'chat-1'),input)
  const mixed=structuredClone(message);mixed.data.message.content.push({type:'tool-call',id:'work',name:'exec',arguments:'{}'})
  assert.deepEqual(withChatCompanionText(input,[start,user,mixed],'chat-1'),input)
  const explicit=[{text:'来了，给你留着呢。'},...input]
  assert.deepEqual(withChatCompanionText(explicit,events,'chat-1'),explicit)
  const final=[{text:'另一句最终回复'},...input]
  assert.deepEqual(withChatCompanionText(final,events,'chat-1'),final)
  const split=[{text:'来了，'},{text:'给你留着呢。'},...input]
  assert.deepEqual(withChatCompanionText(split,events,'chat-1'),split)
})

test('QQ origin selects native emoji without dropping text or creating a default sticker attachment',async()=>{
 const {StickerAdapters}=await import('../lib/chat/sticker-adapter.js'),{qqStickerAdapter}=await import('../lib/channels/qq/sticker-adapter.js')
 const channel={id:'qq',platform:'qq',accountId:'12345678',companionId:'a',enabled:true}
 const route={id:'r',kind:'channel',channelId:'qq',userId:'22345678',sessionId:'s',companionId:'a',inboundMessageIds:['u']}
 const state={channels:[channel],sessions:[route],companions:[{id:'a',characterCard:{enabled:true,stickersEnabled:true,segmentedReplies:true}}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false},library={list:async()=>[],image:async()=>assert.fail('must not load a default bitmap')}
 const adapters=new StickerAdapters(library)
 adapters.register('qq',c=>qqStickerAdapter(c,adapters.fallback,async()=>[{id:'14',name:'微笑',category:'QQ'}]))
 let done=0
 const tool=chatTools('a',store,library,{}, {},'/partner-local/v1',adapters)[1]
 const outcome=await tool.execute({messages:[{text:'当然记得你'},{stickerId:'qq-face-14'}]},{signal:AbortSignal.timeout(2000),concludeTurn:()=>done++,agent:{session:{id:'s',snapshotEvents:()=>[start,user]}}})
 assert.equal(done,1);assert.equal(outcome.originRouteId,'r');assert.deepEqual(outcome.parts.map(p=>p.type),['text','emoji'])
 const projected=channelReplyPartsAfter([start,user,{...result,data:{...result.data,meta:outcome}},end],0)
 assert.match(projected.text,/当然记得你/);assert.equal(projected.chatParts[1].emoji.id,'14')
 assert.equal(nativeChatBlocks(outcome)[0].text,'当然记得你')
})

test('empty optional tool fields do not force a second model attempt; invalid mixed payloads stay rejected',()=>{
 assert.deepEqual(parseChatInput({messages:[{text:'好吧，被你抓到了。 ',stickerId:''},{text:'',stickerId:'qq-face-14'}]}),[{text:'好吧，被你抓到了。'},{stickerId:'qq-face-14'}])
 assert.deepEqual(parseChatInput({messages:[{text:'你好',stickerId:'  '}]}),[{text:'你好'}])
 for(const value of [{text:'',stickerId:''},{text:'你好',stickerId:'qq-face-14'},{text:'你好',unknown:''},{text:'你好',stickerId:3},{text:'你好',stickerId:null},{text:'a'.repeat(6001),stickerId:''}])assert.throws(()=>parseChatInput({messages:[value]}))
})

test('only a verified autonomous QQ group can conclude silently without a channel message',async()=>{
 const card={enabled:true,segmentedReplies:true,stickersEnabled:false}
 const route={id:'r',kind:'channel',sessionId:'s',companionId:'c',channelId:'qq',userId:'group:12345678:22345678',inboundMessageIds:['u']}
 const state={companions:[{id:'c',characterCard:card}],sessions:[route],channels:[{id:'qq',platform:'qq',qq:{groupReplies:true,groupIds:['12345678'],autonomousGroupIds:['12345678']}}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false}
 const tool=chatTools('c',store,{}, {},{},'/partner-local/v1').find(t=>t.name==='partner_chat_reply')
 let concluded=0
 const exec={signal:new AbortController().signal,agent:{session:{id:'s',snapshotEvents:()=>[start,user]}},concludeTurn:()=>concluded++}
 const value=await tool.execute({messages:[]},exec)
 assert.equal(value.silent,true);assert.deepEqual(value.parts,[]);assert.equal(concluded,1)
 const projected=channelReplyPartsAfter([start,user,{...result,data:{...result.data,meta:value}},end],0)
 assert.deepEqual(projected.chatParts,[]);assert.equal(projected.text,'')
 const outbound=await prepareChannelReply(projected,'/tmp');assert.deepEqual(outbound.chatParts,[]);assert.equal(outbound.text,'')
 for(const mode of ['private','not-whitelisted','unverified']){
  route.userId=mode==='private'?'22345678':'group:12345678:22345678'
  route.inboundMessageIds=mode==='unverified'?[]:['u']
  state.channels[0].qq.autonomousGroupIds=mode==='not-whitelisted'?[]:['12345678']
  await assert.rejects(tool.execute({messages:[]},exec),/只有自主群聊/)
 }
 assert.equal(concluded,1)
})

test('idle fallback preserves explicit parts, structured content and long form',()=>{
 const plain={text:'想到个事\n\n有点好笑',attachments:[]}
 assert.equal(segmentIdleChatReply(plain,false),plain)
 for(const text of ['只有一句','```js\na()\n\nb()\n```','说明\n\n- 项目','标题\n\n> 引用','表格\n\na | b','长'.repeat(601)+'\n\n结束','长'.repeat(201)+'\n\n结束',Array(9).fill('段').join('\n\n')]){
  const reply={text,attachments:[]};assert.equal(segmentIdleChatReply(reply,true),reply)
 }
 for(const extra of [{chatParts:[{type:'text',text:plain.text}]},{chatParts:[]},{attachments:[image.attachment]}]){
  const reply={...plain,...extra};assert.equal(segmentIdleChatReply(reply,true),reply)
 }
 assert.deepEqual(replyDeliveryParts(segmentIdleChatReply(plain,true)),[{type:'text',text:'想到个事'},{type:'text',text:'有点好笑'}])
})

test('single text chat tool normalizes latest real reply before metadata and delivery',async()=>{
 const card={enabled:true,segmentedReplies:true,stickersEnabled:true}
 const state={companions:[{id:'a',characterCard:card}],sessions:[{sessionId:'s',companionId:'a'}]}
 const tool=chatTools('a',{snapshot:()=>state,isCompanionRemoving:()=>false},{},{},{},'/partner-local/v1')[1]
 const exec={signal:new AbortController().signal,concludeTurn(){},agent:{session:{id:'s',snapshotEvents:()=>[start,user]}}}
 const text='啊 还是跑群里了 那这次私聊测试没过\n我用的确实是“回复当前对象”的语音入口 没填群号 现在还不知道是哪一步发错了 先不再试发'
 for(const enabled of [true,false]){
  card.segmentedReplies=enabled
  const meta=await tool.execute({messages:[{text}]},exec)
  const reply=await prepareChannelReply(channelReplyPartsAfter([start,user,{...result,data:{...result.data,meta}},end],0),'/unused')
  assert.deepEqual(replyDeliveryParts(reply), (enabled?text.split('\n'):[text]).map(text=>({type:'text',text})))
 }
 const code='说明\n\n```js\na()\n```';card.segmentedReplies=true
 assert.deepEqual((await tool.execute({messages:[{text:code}]},exec)).parts,[{type:'text',text:code}])
 const explicit=[{text:'第一条\n保持边界'},{text:'第二条'}]
 assert.deepEqual((await tool.execute({messages:explicit},exec)).parts,explicit.map(p=>({type:'text',...p})))
})

test('chat line normalization preserves sticker order and total part limit',()=>{
 const input=[{stickerId:'before'},{text:'第一段\r\n\r\n第二段'},{stickerId:'after'}]
 assert.deepEqual(segmentChatInput(input,true),[{stickerId:'before'},{text:'第一段'},{text:'第二段'},{stickerId:'after'}])
 const tooMany=[{text:Array(8).fill('一段').join('\n')},{stickerId:'after'}]
 assert.equal(segmentChatInput(tooMany,true),tooMany)
 assert.equal(segmentChatInput(input,false),input)
})

test('local Markdown image cannot conclude chat before explicit attachment delivery',async()=>{
 const state={companions:[{id:'a',characterCard:{enabled:true,segmentedReplies:true,stickersEnabled:true}}],sessions:[{sessionId:'s',companionId:'a'}]}
 const tool=chatTools('a',{snapshot:()=>state,isCompanionRemoving:()=>false},{},{},{},'/partner-local/v1')[1]
 let ended=0
 const exec={signal:new AbortController().signal,concludeTurn(){ended++},agent:{session:{id:'s',snapshotEvents:()=>[start,user]}}}
 for(const text of ['![梦里的拖鞋列车](</home/node/partners/companion-default/generated/result.png>)','给你看\n![图](generated/a.png)','![图](sandbox:/tmp/a.png)'])await assert.rejects(tool.execute({messages:[{text}]},exec),/partner_send_attachment/)
 assert.equal(ended,0)
 assert.deepEqual((await tool.execute({messages:[{text:'画好了 这车真没轮子'}]},exec)).parts,[{type:'text',text:'画好了 这车真没轮子'}]);assert.equal(ended,1)
 const code='写法示例：`![图](generated/a.png)`';assert.deepEqual((await tool.execute({messages:[{text:code}]},exec)).parts,[{type:'text',text:code}])
})
