import test from 'node:test'
import assert from 'node:assert/strict'
import {ReplyCompletionGuard,replyCompletionState,INCOMPLETE_REPLY} from '../lib/chat/reply-completion.js'
import {attachmentDeliveryMeta} from '../lib/attachments/delivery-receipt.js'
import {channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
import {prepareChannelReply} from '../lib/channels/outbound-media.js'
const start=()=>({type:'turn/start',seq:1,data:{turn:1}})
const user=(id='u')=>({type:'user/message',seq:2,data:{id,source:{kind:'user'}}})
const answer=text=>({type:'assistant/message',seq:5,data:{message:{content:[{type:'text',text}]}}})
const call=(name,args,id='c')=>({type:'tool/call',seq:3,data:{name,arguments:JSON.stringify(args),callId:id}})
const result=(value,id='c',isError=false)=>({type:'tool/result',seq:4,data:{message:{toolCallId:id,isError,content:[{type:'text',text:JSON.stringify(value)}]}}})
const discover=()=>call('partner_tools',{action:'describe',name:'generate_image'})
const generated=()=>[call('partner_tools',{action:'call',name:'generate_image',argumentsJson:'{}'}),result({files:[{path:'/generated/a.png'}]})]
const receipt=()=>({...result({}),data:{message:{isError:false,content:[]},meta:attachmentDeliveryMeta(JSON.stringify({channel:'sent',conversation:'attachment_recorded',originRouteId:'r'}))}})
const end={type:'turn/end',seq:7,data:{reason:{kind:'completed'}}}
function fixture(events){const sent=[],agent={session:{snapshotEvents:()=>events},steer:m=>sent.push(m)};let active=true;const guard=new ReplyCompletionGuard(agent,()=>active);return {guard,agent,sent,stop:()=>guard.stop({agent,signal:new AbortController().signal}),inactive:()=>active=false}}
test('a blank normal model stop is not a completed reply, even without discovery',()=>{
 for(const es of [[start(),user(),answer('')],[start(),user(),discover(),answer('')]])assert.equal(replyCompletionState(es).phase,'execute')
 assert.equal(replyCompletionState([start(),user(),...generated(),answer('')]).phase,'settle')
 for(const es of [[start(),answer('')],[start(),user(),start(),answer('')],[start(),user(),{type:'user/message',data:{source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴闲时主动联系'}}},answer('')]])assert.equal(replyCompletionState(es),undefined)
})
test('normal final text, explicit silence, voice and confirmed attachments are complete',()=>{
 for(const extra of [answer('好了'),{...result({}),data:{message:{isError:false},meta:{kind:'partner-chat-v1',parts:[],silent:true}}},{...result({}),data:{message:{isError:false},meta:{kind:'partner-chat-v1',parts:[],delivered:true,originRouteId:'r'}}},receipt()])assert.equal(replyCompletionState([start(),user(),answer(''),extra]).phase,'complete')
 for(const value of [{channel:'failed'},{channel:'none'},{channel:'sent'},{channel:'unknown',originRouteId:'r',conversation:'attachment_recorded'}])assert.equal(attachmentDeliveryMeta(value),null)
})
test('same user stays in original turn: discover → execute → deliver, never replay completed work',()=>{
 const events=[start(),user(),discover(),answer('')],f=fixture(events)
 f.stop();assert.equal(f.sent.length,1);assert.equal(f.guard.deny('generate_image',{}),undefined)
 events.push(...generated(),answer(''));f.stop();assert.equal(f.sent.length,2)
 assert.match(f.guard.deny('generate_image',{}),/不能重复/)
 assert.match(f.guard.deny('partner_tools',{action:'call',name:'generate_image',argumentsJson:'{}'}),/不能重复/)
 assert.equal(f.guard.deny('partner_tools',{action:'describe',name:'partner_send_attachment'}),undefined)
 assert.equal(f.guard.deny('partner_send_attachment',{path:'/generated/a.png'}),undefined)
 assert.match(f.guard.deny('partner_send_attachment',{path:'/private/wrong.png'}),/不能重复/)
 events.push(receipt(),answer(''));f.stop();assert.equal(f.sent.length,2);assert.equal(f.guard.failed,false)
})
test('unknown work outcome can only settle, failed attachments retry their original delivery ID',()=>{
 const events=[start(),user(),call('send_email',{}),result({},'c',true),answer('')],f=fixture(events);f.stop()
 assert.match(f.guard.deny('send_email',{}),/不能重复/)
 assert.equal(f.guard.deny('partner_chat_reply',{messages:[{text:'发送状态不明'}]}),undefined)
 events.push(call('partner_send_attachment',{},'a'),result({deliveryId:'receipt',channel:'failed'},'a'),answer(''))
 assert.equal(f.guard.deny('partner_send_attachment',{deliveryId:'receipt'}),undefined)
 assert.match(f.guard.deny('partner_send_attachment',{deliveryId:'wrong'}),/不能重复/)
})
test('bounded empty recovery fails explicitly instead of completing, no autonomous followup',()=>{
 const f=fixture([start(),user(),discover(),answer('')]);f.stop();f.stop();assert.throws(f.stop,new RegExp(INCOMPLETE_REPLY));assert.equal(f.guard.failed,true);assert.equal(f.sent.length,2)
})
test('cancellation, foreign agent, changed audience and new user do not inherit recovery restrictions',()=>{
 const events=[start(),user(),...generated(),answer('')],f=fixture(events)
 f.guard.stop({agent:f.agent,signal:AbortSignal.abort()});f.guard.stop({agent:{},signal:new AbortController().signal});assert.equal(f.sent.length,0)
 f.stop();events.push(user('new'),answer(''));assert.equal(f.guard.deny('generate_image',{}),undefined);f.stop();assert.equal(f.sent.length,2)
 f.inactive();f.stop();assert.equal(f.sent.length,2)
})
test('a confirmed file with no prose suppresses fallback and does not swallow later conclusion',async()=>{
 const base=[start(),user(),receipt(),answer('')]
 const empty=await prepareChannelReply(channelReplyPartsAfter([...base,end],0),'/unused')
 assert.equal(empty.text,'');assert.equal(empty.alreadyDelivered,true)
 const final=await prepareChannelReply(channelReplyPartsAfter([...base,answer('画好了'),end],0),'/unused')
 assert.equal(final.text,'画好了')
 const failed={...receipt(),data:{...receipt().data,message:{isError:true}}}
 assert.match((await prepareChannelReply(channelReplyPartsAfter([start(),user(),failed,end],0),'/unused')).text,/未生成/)
})

test('reasoning plus empty text after action acknowledgement still recovers in the same user turn',()=>{
 for(const content of [[{type:'reasoning',text:''},{type:'text',text:''}],[{type:'reasoning',text:''}],[{type:'reasoning',text:'internal'},{type:'text',text:'  '}]]){
  const empty={...answer(''),data:{message:{content}}}
  for(const name of ['partner_chat_progress','partner_chat_say']){
   const events=[start(),user(),call(name,{text:'我来画',beforeTools:true}),result({delivered:true}),empty]
   const f=fixture(events);assert.equal(replyCompletionState(events).phase,'execute')
   f.stop();assert.equal(f.sent.length,1);assert.equal(f.guard.deny('generate_image',{}),undefined)
   f.stop();assert.throws(f.stop,new RegExp(INCOMPLETE_REPLY));assert.equal(f.sent.length,2)
  }
 }
})
test('reasoning-only stop after submitted work settles without re-executing it; live calls and interruption stay untouched',()=>{
 const empty={...answer(''),data:{message:{content:[{type:'reasoning',text:''},{type:'text',text:''}]}}}
 const events=[start(),user(),...generated(),empty],f=fixture(events)
 f.stop();assert.equal(f.sent.length,1);assert.equal(replyCompletionState(events).phase,'settle')
 assert.match(f.guard.deny('generate_image',{}),/不能重复/)
 assert.equal(f.guard.deny('partner_send_attachment',{path:'/generated/a.png'}),undefined)
 for(const last of [{...empty,data:{...empty.data,interrupted:true}},{...empty,data:{message:{content:[{type:'reasoning',text:''},{type:'tool-call',name:'generate_image'}]}}}])assert.equal(replyCompletionState([start(),user(),last]),undefined)
 const complete={...empty,data:{message:{content:[{type:'reasoning',text:''},{type:'text',text:'好了'}]}}}
 assert.equal(replyCompletionState([start(),user(),complete]).phase,'complete')
})

test('rejected empty end and directory calls are reply control, not submitted work',()=>{
 const events=[start(),user(),call('partner_chat_say',{text:'我来画',beforeTools:true}),result({delivered:true}),call('partner_chat_reply',{messages:[]},'end'),result({},'end',true),call('partner_tools',{action:'list'}),answer('')]
 const f=fixture(events);assert.equal(replyCompletionState(events).phase,'execute');f.stop()
 assert.equal(f.guard.deny('partner_tools',{action:'call',name:'generate_image',argumentsJson:'{}'}),undefined)
 events.push(...generated(),answer(''));f.stop()
 assert.match(f.guard.deny('generate_image',{}),/不能重复/)
 assert.equal(f.guard.deny('partner_chat_say',{text:'画出来啦'}),undefined)
 assert.match(f.guard.deny('partner_chat_say',{text:'再画一次',beforeTools:true}),/不能重复/)
 for(const name of ['partner_agreement','partner_channel_access','partner_stickers'])assert.equal(replyCompletionState([start(),user(),call(name,{action:'list'}),answer('')]).phase,'execute')
})
