import test from 'node:test'
import assert from 'node:assert/strict'
import {TaskPreambleGate,installTaskPreamble,needsTaskPreamble} from '../lib/execution/task-preamble.js'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {installToolDiscovery} from '../lib/collaboration/tool-discovery.js'
const user=id=>({type:'user/message',data:{id,source:{kind:'user'}}})
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
test('silent tool-only task is blocked until persona-authored acknowledgement is delivered',async()=>{
 const events=[{type:'turn/start'},user('u')],sent=[],delivery=gate()
 const g=new TaskPreambleGate(()=>events,async text=>{sent.push(text);await delivery.promise})
 assert.match(await g.before('generate_image',{}),/尚未执行/)
 const ack=g.acknowledge('醒啦，我这就画给你。')
 let released=false;const work=g.before('generate_image',{}).then(result=>{assert.equal(result,undefined);released=true})
 await new Promise(r=>setImmediate(r));assert.equal(released,false)
 delivery.resolve();await Promise.all([ack,work]);assert.equal(released,true)
 await g.acknowledge('不应该再发一条');assert.deepEqual(sent,['醒啦，我这就画给你。'])
 assert.equal(await g.before('web_search',{}),undefined)
 events.push(user('u2'));assert.match(await g.before('generate_image',{}),/尚未执行/)
})
test('visible tool preamble is sent and awaited; failed or revoked delivery never releases work',async()=>{
 const events=[{type:'turn/start'},user('u'),{type:'assistant/message',data:{message:{content:[{type:'text',text:'我去核实一下。'},{type:'tool-call',name:'web_search'}]}}}]
 const sent=[],g=new TaskPreambleGate(()=>events,async text=>{sent.push(text)})
 assert.equal(await g.before('web_search',{}),undefined);assert.deepEqual(sent,['我去核实一下。'])
 let attempts=0;const failed=new TaskPreambleGate(()=>events,async()=>{attempts++;throw Error('unknown send')})
 assert.match(await failed.before('web_search',{}),/未确认送达/)
 assert.match(await failed.before('web_search',{}),/发送失败/);assert.equal(attempts,1)
})
test('discovery and ordinary chat stay immediate; autonomous/internal turns never require an acknowledgement',async()=>{
 for(const name of ['partner_chat_reply','partner_stickers','partner_tools','partner_chat_progress'])assert.equal(needsTaskPreamble(name,{}),false)
 assert.equal(needsTaskPreamble('ssh',{action:'describe'}),false)
 const events=[{type:'turn/start'},{type:'user/message',data:{id:'notice',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice'}}}]
 const g=new TaskPreambleGate(()=>events,async()=>assert.fail('must not send'))
 assert.equal(await g.before('generate_image',{}),undefined);await assert.rejects(g.acknowledge('hello'))
})
test('native entry blocks image execution, delivers progress without concluding, then executes exactly once',async t=>{
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('preamble'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx
 t.after(()=>scope.dispose())
 const state={companions:[{id:'c',toolDiscovery:true}],channels:[],sessions:[{id:'local',kind:'local',companionId:'c',sessionId:agent.session.id}]}
 t.after(installToolDiscovery(scope.ctx.tools,'c',{snapshot:()=>state,isCompanionRemoving:()=>false},[]))
 let executions=0;const sent=[]
 t.after(scope.ctx.tools.register({name:'generate_image',description:'generate',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},execute:async()=>{executions++;return {files:['real.png']}}}))
 const dispose=installTaskPreamble(agent,async text=>sent.push(text));t.after(dispose)
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'画张图'}]}),{surfaceOp:'append'})
 let seq=0
 const call=async(name,args={})=>{const request={name,arguments:args,agent,signal:new AbortController().signal,callId:'call-'+seq++};agent.session.append('tool/call',{name,arguments:JSON.stringify(args),callId:request.callId});const result=await root.tools.execute(request);agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{id:request.callId,role:'tool',source:{kind:'tool',callId:request.callId},toolCallId:request.callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'});return result}
 let collected=0
 t.after(scope.ctx.tools.register({name:'partner_qq',description:'QQ',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>{collected++;return {ok:true}}}))
 const sticker=await call('partner_qq',{action:'call',operation:'add_custom_face'});assert.equal(sticker.isError,true);assert.equal(collected,0);assert.deepEqual(sent,[])
 const deny=scope.ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='partner_qq'?{kind:'deny',reason:'permission denied'}:next())
 const denied=await call('partner_qq',{action:'call',operation:'add_custom_face'});assert.equal(denied.isError,true);assert.equal(collected,0);deny()
 const blocked=await call('generate_image');assert.equal(blocked.isError,true);assert.equal(executions,0)
 const ack=await call('partner_chat_progress',{text:'等着，我来画。'});assert.equal(ack.isError,false);assert.ok(!ack.concludesTurn);assert.deepEqual(sent,['等着，我来画。'])
 const collection=await call('partner_qq',{action:'call',operation:'add_custom_face'});assert.equal(collection.isError,false);assert.equal(collected,1);assert.equal(sent.length,1)
 const image=await call('generate_image');assert.equal(image.isError,false);assert.equal(executions,1)
 dispose();assert.equal(scope.ctx.tools.get('partner_chat_progress',agent),undefined)
})

test('a shared-session input from another route cannot send through the previous channel',async()=>{
 const events=[{type:'turn/start'},user('u')];let active=true
 const delivery=gate(),sent=[]
 const g=new TaskPreambleGate(()=>events,async text=>{sent.push(text);await delivery.promise},()=>active)
 const ack=g.acknowledge('我先去看看。');active=false;delivery.resolve()
 await assert.rejects(ack,/输入/)
 await assert.rejects(g.acknowledge('不能发到旧会话'))
 assert.equal(await g.before('generate_image',{}),undefined)
 assert.deepEqual(sent,['我先去看看。'])
})

test('sticker mutations share one persona preamble while discovery and autonomous housekeeping remain silent',async()=>{
 const events=[{type:'turn/start'},user('u')],sent=[]
 const g=new TaskPreambleGate(()=>events,async text=>sent.push(text))
 assert.equal(await g.before('partner_qq',{action:'call',operation:'fetch_custom_face_detail'}),undefined)
 for(const operation of ['add_custom_face','modify_custom_face','move_custom_face_to_front','delete_custom_face','send_group_msg','unknown'])assert.match(await g.before('partner_qq',{action:'call',operation}),/尚未执行/)
 await g.acknowledge('这张我喜欢！我收起来，再记个名字～')
 for(const operation of ['add_custom_face','modify_custom_face','move_custom_face_to_front','delete_custom_face'])assert.equal(await g.before('partner_qq',{action:'call',operation}),undefined)
 assert.equal(sent.length,1)
 events.push({type:'turn/start'},{type:'user/message',data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:'伙伴闲时主动联系'}}})
 assert.equal(await g.before('partner_qq',{action:'call',operation:'add_custom_face'}),undefined)
 assert.equal(sent.length,1)
})

test('short rhythm preamble rejects a report without sending and preserves the authored short action',async()=>{
 const sent=[],events=[{type:'turn/start'},user('u')]
 const g=new TaskPreambleGate(()=>events,async text=>sent.push(text),()=>true,()=>true)
 await assert.rejects(g.acknowledge('先查接口\n再核对输入方式'),/尚未发送/)
 assert.deepEqual(sent,[])
 await g.acknowledge('我去翻翻接口。');assert.deepEqual(sent,['我去翻翻接口。'])
 await g.acknowledge('我去查一下');assert.equal(sent.length,1)
})

test('lightweight message reaction does not demand a separate task announcement',()=>{
 assert.equal(needsTaskPreamble('partner_qq',{action:'call',operation:'set_msg_emoji_like'}),false)
 assert.equal(needsTaskPreamble('partner_qq',{action:'call',operation:'get_msg_emoji_likes'}),false)
 assert.equal(needsTaskPreamble('partner_qq',{action:'call',operation:'add_custom_face'}),true)
})
