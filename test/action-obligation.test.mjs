import test from 'node:test'
import assert from 'node:assert/strict'
import {pendingActions} from '../lib/chat/action-obligation.js'
import {replyCompletionState,ReplyCompletionGuard} from '../lib/chat/reply-completion.js'
const start={type:'turn/start',seq:1}
const user=(id='u',seq=2)=>({type:'user/message',seq,data:{id,source:{kind:'user'}}})
const say=(tools=['generate_image','partner_send_attachment'])=>({type:'tool/result',seq:4,data:{message:{isError:false,content:[]},meta:{kind:'partner-chat-v1',parts:[],intermediate:true,taskPreamble:true,originRouteId:'r',delivered:true,inputMessageId:'u',expectedTools:tools}}})
const call=(name,id=name)=>({type:'tool/call',seq:5,data:{name:'partner_tools',callId:id,arguments:JSON.stringify({action:'call',name,argumentsJson:'{}'})}})
const result=(name,error=false)=>({type:'tool/result',seq:6,data:{message:{toolCallId:name,isError:error,content:[]}}})
const final={type:'assistant/message',seq:8,data:{message:{content:[{type:'text',text:'咔哒，开啦！这把钥匙果然对。'}]}}}
test('real failure pattern: spoken promise and nonempty final still leave both actions pending',()=>{
 const events=[start,user(),say(),final]
 assert.deepEqual(pendingActions(events),['generate_image','partner_send_attachment'])
 assert.equal(replyCompletionState(events).phase,'execute')
 const steered=[],agent={session:{snapshotEvents:()=>events},steer:m=>steered.push(m)},guard=new ReplyCompletionGuard(agent,()=>true)
 guard.stop({agent,signal:new AbortController().signal});assert.equal(steered.length,1)
 events.push(call('generate_image'),result('generate_image'),final)
 assert.deepEqual(pendingActions(events),['partner_send_attachment'])
 guard.stop({agent,signal:new AbortController().signal})
 assert.match(guard.deny('generate_image',{}),/不能重复/)
 assert.equal(guard.deny('partner_send_attachment',{}),undefined)
 events.push(call('partner_send_attachment'),result('partner_send_attachment'))
 assert.deepEqual(pendingActions(events),[])
})
test('directory, unrelated lookup and extra speech cannot satisfy named actions; in-flight work stays pending',()=>{
 const events=[start,user(),say(),{type:'tool/call',seq:5,data:{name:'partner_tools',arguments:'{"action":"describe","name":"generate_image"}',callId:'d'}},result('d'),call('partner_memory_recall'),result('partner_memory_recall')]
 assert.equal(pendingActions(events).length,2)
 events.push(call('generate_image'));assert.equal(pendingActions(events).length,2)
 events.push(result('generate_image'));assert.deepEqual(pendingActions(events),['partner_send_attachment'])
})
test('failed generation is not automatically retried; explicit blocked end, new user and new turn release obligations',()=>{
 const events=[start,user(),say(),call('generate_image'),result('generate_image',true)]
 assert.deepEqual(pendingActions(events),['partner_send_attachment'])
 assert.deepEqual(pendingActions([...events,{type:'tool/result',seq:7,data:{message:{isError:false},meta:{kind:'partner-chat-v1',parts:[{type:'text',text:'没画成，超时啦'}],taskDisposition:'blocked'}}}]),[])
 assert.deepEqual(pendingActions([...events,user('next',9)]),[])
 assert.deepEqual(pendingActions([...events,{type:'turn/start',seq:9}]),[])
 assert.deepEqual(pendingActions([start,user(),{...say(),data:{...say().data,message:{isError:true}}}]),[])
})

test('additional confirmed declarations merge; earlier unrelated work cannot discharge a newly declared tool',()=>{
 const events=[start,user(),say(['partner_memory_recall']),call('partner_memory_recall'),result('partner_memory_recall'),say(['generate_image','partner_send_attachment'])]
 assert.deepEqual(pendingActions(events),['generate_image','partner_send_attachment'])
 events.push(call('generate_image'),result('generate_image'),say(['generate_image','partner_send_attachment']))
 assert.deepEqual(pendingActions(events),['partner_send_attachment'])
 events.push(call('partner_send_attachment'),result('partner_send_attachment'))
 assert.deepEqual(pendingActions(events),[])
 assert.deepEqual(pendingActions([start,user(),say(['partner_memory_recall']),call('generate_image'),result('generate_image'),say(['generate_image'])]),['partner_memory_recall','generate_image'])
})

test('blocked exit cannot invent provider rejection, use an old error or quote a successful result',async()=>{
 const {validateTaskStop}=await import('../lib/chat/action-obligation.js')
 const events=[start,user(),say(),call('generate_image','real')]
 assert.throws(()=>validateTaskStop(events,undefined),/taskEvidence/)
 assert.throws(()=>validateTaskStop(events,{kind:'tool_error',callId:'invented',excerpt:'安全系统拒绝'}),/不存在/)
 assert.deepEqual(validateTaskStop(events,{kind:'not_executed'}),{kind:'not_executed'})
 const error={type:'tool/result',seq:6,data:{message:{toolCallId:'real',isError:true,content:[{type:'text',text:'Error: request timed out'}]}}}
 const proof={kind:'tool_error',callId:'real',excerpt:'request timed out'}
 assert.deepEqual(validateTaskStop([...events,error],proof),{...proof,toolName:'generate_image'})
 assert.throws(()=>validateTaskStop([...events,error],{...proof,excerpt:'安全系统拒绝'}),/不匹配/)
 assert.throws(()=>validateTaskStop([...events,error,user('new',8)],proof),/不存在/)
 assert.throws(()=>validateTaskStop([...events,{...error,data:{message:{toolCallId:'real',isError:false,content:[{type:'text',text:'success'}]}}}],{...proof,excerpt:'success'}),/不存在/)
})
