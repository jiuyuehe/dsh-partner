import test from 'node:test'
import assert from 'node:assert/strict'
import {checkShortExpression as check} from '../lib/chat/short-expression.js'
const events=id=>[{type:'turn/start',seq:1},{type:'user/message',seq:2,data:{id,source:{kind:'user'}}}]
const long='这是一段需要重新按当前角色简短表达的说明文字。'
test('short advice is bounded per input and phase, never truncates and permits fallback',()=>{
 const agent={},ev=events('a'),texts=[long]
 assert.throws(()=>check(agent,ev,texts,'speech',true),/尚未发送/)
 assert.deepEqual(texts,[long])
 assert.doesNotThrow(()=>check(agent,ev,texts,'speech',true))
 assert.throws(()=>check(agent,ev,texts,'final',true),/尚未发送/)
 assert.doesNotThrow(()=>check(agent,ev,texts,'final',true))
 assert.throws(()=>check(agent,events('b'),texts,'speech',true))
 assert.throws(()=>check(agent,[{type:'turn/start',seq:9}],texts,'speech',true))
})
test('normal length and explicitly expanded replies bypass without consuming advice',()=>{
 for(const [enabled,expanded] of [[false,false],[true,true]]){
  const agent={};check(agent,events('a'),[long],'final',enabled,expanded)
  assert.throws(()=>check(agent,events('a'),[long],'final',true))
 }
})
test('unicode and total budget count actual codepoints across messages',()=>{
 const agent={};check(agent,[],['😀'.repeat(20)],'final',true)
 assert.throws(()=>check(agent,[],['😀'.repeat(21)],'final',true))
 assert.throws(()=>check({},[],['字'.repeat(17),'字'.repeat(17),'字'.repeat(15)],'final',true))
 assert.doesNotThrow(()=>check({},[],['字'.repeat(16),'字'.repeat(16),'字'.repeat(16)],'final',true))
})
