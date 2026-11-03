import test from 'node:test'
import assert from 'node:assert/strict'
import {renderConversationTurn, renderChatDeliveryGuidance} from '../lib/character/conversation-behavior.js'
import {chatTools} from '../lib/chat/tools.js'

test('short expression is a preference; normal direct reply has no mandatory pre-speech round trip',()=>{
 const card={enabled:true,length:'short',segmentedReplies:true}
 const text=renderConversationTurn(card,1)
 assert.match(text,/简短/);assert.doesNotMatch(text,/20字|48字/)
 assert.match(renderChatDeliveryGuidance(card),/直接回答可用 partner_chat_reply/)
 assert.doesNotMatch(renderChatDeliveryGuidance(card),/普通短句私聊先用/)
})
test('ordinary short reply over twenty characters preserves facts and finishes without rewrite or model call',async()=>{
 const card={enabled:true,length:'short',segmentedReplies:true,stickersEnabled:false}
 const state={companions:[{id:'a',characterCard:card}],sessions:[{sessionId:'s',companionId:'a'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false}
 let concluded=0
 const events=[{type:'turn/start',seq:1,data:{turn:1}},{type:'user/message',seq:2,data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'处理好了没有'}]}}]
 const exec={signal:new AbortController().signal,concludeTurn:()=>concluded++,agent:{session:{id:'s',snapshotEvents:()=>events}}}
 const tool=chatTools('a',store,{}, {}, {llm:{stream(){throw Error('No second model call for direct replies')}}},'/unused')[1]
 const text='文件保存好了，在 /Backup/CaseA.csv；没上传，原文件也没删。'
 const out=await tool.execute({messages:[{text}]},exec)
 assert.equal(out.parts[0].text,text);assert.equal(concluded,1)
 await assert.rejects(tool.execute({messages:[{text:'字'.repeat(181)}]},exec),/180/)
 assert.equal(concluded,1,'long-content delivery guard still enforced')
})
