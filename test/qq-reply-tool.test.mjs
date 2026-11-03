import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {qqReplyTool} from '../lib/channels/qq/reply-tool.js'
import {qqSettings} from '../lib/channels/qq/settings.js'

function fixture(privateChat=false){
 const session=Session.create('voice'),message=createUserMessage({content:[{type:'text',text:'用语音说你好'}],source:{kind:'user'}})
 session.append('user/message',message,{surfaceOp:'append'})
 const route={id:'r',kind:'channel',companionId:'c',sessionId:session.id,channelId:'qq',userId:privateChat?'22345678':'group:99887766:22345678',inboundMessageIds:[message.id]}
 const channel={id:'qq',companionId:'c',platform:'qq',enabled:true,updatedAt:1,qq:qqSettings({replyVoiceEnabled:true,replyVoiceGroupId:'99887766',groupReplies:true,groupIds:['99887766'],autonomousGroupIds:['99887766'],voiceCharacter:'test-voice'})}
 const state={sessions:[route],channels:[channel],pairings:[{channelId:'qq',userId:route.userId,status:'approved'}]}
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>{const next=structuredClone(state);fn(next);Object.assign(state,next)}}
 const requests=[];let conclude=0
 const call=async(id,action,params,signal,guard)=>{guard();requests.push({id,action,params});if(action==='get_ai_record')return 'https://gchat.qpic.cn/voice/test.amr';if(action==='get_ai_characters')return [{characters:[{character_id:'test-voice',character_name:'测试音色'}]}];return {message_id:-23}}
 const exec={agent:{session},callId:'voice-1',signal:new AbortController().signal,concludeTurn:()=>conclude++}
 const tool=qqReplyTool('c',store,call)
 return {tool,exec,requests,state,concluded:()=>conclude,store,call}
}
test('guest group voice replies only to the current group without enabling private API powers',async()=>{
 const f=fixture();f.state.pairings=[];assert.equal(f.state.channels[0].qq.autonomousActions,false)
 const result=await f.tool.execute({action:'voice',text:'你好'},f.exec)
 assert.equal(result.status,'confirmed');assert.equal(f.concluded(),1)
 assert.deepEqual(f.requests[0].params,{group_id:99887766,character:'test-voice',text:'你好',chat_type:1})
 assert.equal(f.requests[0].action,'send_group_ai_record')
 await f.tool.execute({action:'voice',text:'重复'},f.exec);assert.equal(f.requests.length,1)
})
test('private voice uses synthesized media only and never sends to the source group',async()=>{
 const f=fixture(true)
 await f.tool.execute({action:'voice',text:'你好'},f.exec)
 assert.deepEqual(f.requests.map(x=>x.action),['get_ai_record','send_private_msg'])
 assert.equal(f.requests[1].params.user_id,22345678)
 assert.deepEqual(f.requests[1].params.message,[{type:'record',data:{file:'https://gchat.qpic.cn/voice/test.amr'}}])
 for(const args of [{action:'voice',text:'x',file:'/etc/passwd'},{action:'voice',text:'x',user_id:12345678},{action:'call',operation:'send_qzone_msg'}])await assert.rejects(f.tool.execute(args,f.exec))
})
test('chat voice revocation, unknown origins and off-switch fail before any API call',async()=>{
 for(const edit of [f=>f.state.channels[0].qq.replyVoiceEnabled=false,f=>f.state.pairings[0].status='blocked',f=>f.state.sessions[0].inboundMessageIds=[]]){
  const f=fixture();edit(f);await assert.rejects(f.tool.execute({action:'voice',text:'x'},f.exec));assert.equal(f.requests.length,0)
 }
})
test('generation failure cannot substitute local files and is not reported as an uncertain send',async()=>{
 const f=fixture(true),tool=qqReplyTool('c',f.store,async(...args)=>{if(args[1]==='get_ai_record')return 'file:///etc/passwd';return f.call(...args)})
 await assert.rejects(tool.execute({action:'voice',text:'x'},f.exec))
 assert.equal(f.requests.length,0);assert.equal(f.state.channels[0].qqActivity.length,0)
 await assert.rejects(tool.execute({action:'voice',text:'x'},f.exec),/尚未发送消息/)
})

test('SnowLuma current QQ media domain can be delivered privately; uncertain sends are never repeated',async()=>{
 const f=fixture(true);let sends=0
 const tool=qqReplyTool('c',f.store,async(...args)=>{
  args[4]()
  if(args[1]==='get_ai_record')return 'https://multimedia.nt.qq.com.cn/download?voice=test'
  if(args[1]==='send_private_msg'){sends++;assert.equal(args[2].message[0].data.file,'https://multimedia.nt.qq.com.cn/download?voice=test');throw Error('connection lost')}
  return f.call(...args)
 })
 await assert.rejects(tool.execute({action:'voice',text:'x'},f.exec),/未确认发送/)
 assert.equal(f.state.channels[0].qqActivity[0].status,'unknown')
 const retry=await tool.execute({action:'voice',text:'x'},f.exec)
 assert.equal(retry.resent,false);assert.equal(sends,1)
})

test('confirmed voice projects as delivered, including unified dispatch and duplicate receipt, never empty-text fallback',async()=>{
 const {channelReplyPartsAfter}=await import('../lib/channels/delivery-policy.js')
 const {prepareChannelReply}=await import('../lib/channels/outbound-media.js')
 const {completedActivityDidWork}=await import('../lib/character/post-reply.js')
 for(const type of ['tool/result','tool/ptc-dispatch']){
  const f=fixture(),args={action:'voice',text:'你好'}
  const value=await f.tool.execute(args,f.exec),meta=f.tool.output.presentationMeta(args,value)
  const start={type:'turn/start',seq:1,data:{turn:1}},user={type:'user/message',seq:2,data:{id:'u',source:{kind:'user'}}}
  const result={type,seq:3,data:type==='tool/result'?{message:{isError:false,content:[]},meta}:{name:'partner_qq_reply',arguments:JSON.stringify(args),isError:false,meta}}
  const events=[start,user,result,{type:'turn/end',seq:4,data:{reason:{kind:'completed'}}}]
  const reply=await prepareChannelReply(channelReplyPartsAfter(events,0),'/tmp')
  assert.equal(reply.alreadyDelivered,true);assert.equal(reply.text,'');assert.deepEqual(reply.chatParts,[]);assert.equal(reply.chatOriginRouteId,'r')
  const {nativeChatBlocks}=await import('../lib/chat/conversation.js');assert.match(nativeChatBlocks(meta)[0].text,/语音已发送.*你好/)
  assert.equal(completedActivityDidWork(events),true)
  const duplicate=await f.tool.execute(args,f.exec);assert.equal(f.tool.output.presentationMeta(args,duplicate).delivered,true);assert.equal(f.requests.length,1)
  assert.equal(f.tool.output.presentationMeta({action:'voices'},{voices:[]}),null)
  assert.equal(f.tool.output.presentationMeta(args,{status:'unknown',originRouteId:'r'}),null)
  result.data.meta=undefined
  assert.match((await prepareChannelReply(channelReplyPartsAfter(events,0),'/tmp')).text,/未生成/)
 }
})

test('real unified voice call persists delivery metadata for channel projection',async t=>{
 const {Context}=await import('@deepseek-ai/cordis'),{ToolRuntime}=await import('@deepseek-ai/dsh-tools'),{createScope}=await import('@deepseek-ai/dsh-scope')
 const {installToolDiscovery}=await import('../lib/collaboration/tool-discovery.js')
 const {channelReplyPartsAfter}=await import('../lib/channels/delivery-policy.js')
 const {prepareChannelReply}=await import('../lib/channels/outbound-media.js')
 const f=fixture(),root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 f.state.companions=[{id:'c',toolDiscovery:true}]
 const agent=f.exec.agent;agent.options={};const scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 t.after(installToolDiscovery(scope.ctx.tools,'c',f.store,[{tool:f.tool,allowed:()=>true}]))
 const result=await root.tools.execute({name:'partner_tools',arguments:{action:'call',name:'partner_qq_reply',argumentsJson:JSON.stringify({action:'voice',text:'你好'})},agent,signal:new AbortController().signal,callId:'unified-voice'})
 assert.equal(result.isError,false);assert.equal(result.concludesTurn,true);assert.equal(f.requests.length,1)
 const projected=await prepareChannelReply(channelReplyPartsAfter(agent.session.snapshotEvents(),-1),'/tmp')
 assert.equal(projected.alreadyDelivered,true);assert.equal(projected.text,'');assert.deepEqual(projected.chatParts,[])
})

test('real group mentions send structured at segments, stay in the room and do not end the turn',async()=>{
 const f=fixture();f.state.channels[0].qq.replyVoiceEnabled=false
 const call=async(...args)=>args[1]==='get_group_member_info'?(args[4](),{group_id:99887766,user_id:33445566}):f.call(...args)
 const tool=qqReplyTool('c',f.store,call)
 const value=await tool.execute({action:'mention',userId:'33445566',text:'来一下'},f.exec)
 assert.deepEqual(f.requests[0].params,{group_id:99887766,message:[{type:'at',data:{qq:'33445566'}},{type:'text',data:{text:' 来一下'}}]})
 assert.equal(f.concluded(),0)
 const meta=tool.output.presentationMeta({},value)
 assert.equal(meta.intermediate,true);assert.equal(meta.delivered,true);assert.match(meta.parts[0].text,/@33445566/)
 await tool.execute({action:'mention',userId:'33445566'},f.exec);assert.equal(f.requests.length,1)
 await assert.rejects(qqReplyTool('c',f.store,async()=>({user_id:99,group_id:99887766})).execute({action:'mention',userId:'33445566'},f.exec),/群成员/)
 await assert.rejects(fixture(true).tool.execute({action:'mention',userId:'33445566'},fixture(true).exec))
})
test('poke is current-conversation only, requires enabled action and never replays an uncertain send',async()=>{
 const f=fixture(true);f.state.channels[0].qq.replyVoiceEnabled=false
 await assert.rejects(f.tool.execute({action:'poke'},f.exec),/尚未开启/)
 f.state.channels[0].qq.enabledActions.push('send_poke')
 await assert.rejects(f.tool.execute({action:'poke',userId:'33445566'},f.exec),/其他私聊/)
 let attempts=0
 const tool=qqReplyTool('c',f.store,async(...args)=>{args[4]();attempts++;assert.equal(args[1],'send_poke');assert.deepEqual(args[2],{user_id:22345678});throw Error('timeout')})
 await assert.rejects(tool.execute({action:'poke'},f.exec),/未确认发送/)
 assert.equal((await tool.execute({action:'poke'},f.exec)).status,'unknown');assert.equal(attempts,1)
})
test('poke accepts successful empty OneBot data and produces a visible interaction receipt',async()=>{
 const f=fixture(true);f.state.channels[0].qq.enabledActions.push('send_poke')
 const tool=qqReplyTool('c',f.store,async(...args)=>{args[4]();return null})
 const result=await tool.execute({action:'poke'},f.exec)
 assert.equal(result.status,'confirmed');assert.match(tool.output.presentationMeta({},result).parts[0].text,/戳了戳/)
 f.state.pairings[0].status='blocked'
 await assert.rejects(tool.execute({action:'poke'},f.exec),/撤回/)
})

test('group poke can target a different member without that members private approval',async()=>{
 const f=fixture();f.state.channels[0].qq.enabledActions.push('send_poke');f.state.channels[0].qq.replyVoiceEnabled=false
 const tool=qqReplyTool('c',f.store,async(...args)=>args[1]==='get_group_member_info'?(args[4](),{group_id:99887766,user_id:33445566}):f.call(...args))
 const result=await tool.execute({action:'poke',userId:'33445566'},f.exec)
 assert.equal(result.status,'confirmed');assert.equal(f.requests[0].action,'send_poke')
 assert.deepEqual(f.requests[0].params,{user_id:33445566,group_id:99887766})
 assert.equal(f.concluded(),0)
})
