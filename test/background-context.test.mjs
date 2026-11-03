import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage,createSystemMessage} from '@deepseek-ai/dsh-llm'
import {normalizeBackgroundContext} from '../lib/character/background-context.js'

test('background audit is compact and source-labelled; original log, user quotes and system head survive replay',()=>{
 const s=Session.create('background');s.append('system/message',{turn:0,step:0,message:createSystemMessage('protected')},{surfaceOp:'append'})
 const head=s.surface.nodes[0],raw='状态：检查受阻\n本轮挂念：版本更新\n1. tool trace\n结果：UNRELATED_LONG_TOOL_TEXT\n受阻事项：版本更新；未挂载'
 const source={kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴正在进行低打扰心跳检查'}
 const original=s.append('user/message',createUserMessage({source,content:[{type:'text',text:raw}]}),{surfaceOp:'append'})
 s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'你现在在做什么'}]}),{surfaceOp:'append'})
 assert.equal(normalizeBackgroundContext(s),1)
 const text=JSON.stringify(s.deriveMessages())
 assert.match(text,/非用户发言/);assert.match(text,/不代表现在仍在执行/);assert.match(text,/你现在在做什么/);assert.doesNotMatch(text,/UNRELATED_LONG_TOOL_TEXT/)
 assert.ok(s.surface.nodes.includes(head));assert.ok(s.snapshotEvents().some(e=>e.seq===original.seq&&JSON.stringify(e).includes('UNRELATED_LONG_TOOL_TEXT')))
 assert.equal(s.snapshotEvents().at(-1).data.source.form,'recall');
 assert.equal(normalizeBackgroundContext(s),0);assert.deepEqual(Session.create('replayed',s.snapshotEvents()).deriveMessages(),s.deriveMessages())
})
test('a user quoting a background report is never rewritten',()=>{
 const s=Session.create('quotes');s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'状态：检查受阻\n这是我贴的记录'}]}),{surfaceOp:'append'})
 const before=s.snapshotEvents();assert.equal(normalizeBackgroundContext(s),0);assert.deepEqual(s.snapshotEvents(),before)
})

test('background normalization during autonomous work is context, not a new admitted instruction',async()=>{
 const {canFinishIdleActivity}=await import('../lib/character/activity-tool.js')
 const {IDLE_CONTACT_NOTICE}=await import('../lib/character/idle-contact.js')
 const s=Session.create('active');const u=s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]}),{surfaceOp:'append'})
 s.append('user/message',createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴正在进行低打扰心跳检查'},content:[{type:'text',text:'状态：检查受阻'}]}),{surfaceOp:'append'})
 s.append('turn/start',{turn:1});const notice=s.append('user/message',createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE},content:[{type:'text',text:'activity'}]}),{surfaceOp:'append'})
 normalizeBackgroundContext(s)
 const state={companions:[{id:'c',idleContact:{enabled:true,routeId:'r'}}],sessions:[{id:'r',kind:'local',companionId:'c',sessionId:s.id,idleContactState:{messageId:notice.data.id,userMessageId:u.data.id}}],channels:[]}
 assert.equal(canFinishIdleActivity('c',state,s.id,s.snapshotEvents()),true)
})
