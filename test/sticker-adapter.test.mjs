import test from 'node:test'
import assert from 'node:assert/strict'
import {StickerAdapters,validNativeEmoji} from '../lib/chat/sticker-adapter.js'
import {qqStickerAdapter} from '../lib/channels/qq/sticker-adapter.js'
import {qqCustomCatalog} from '../lib/channels/qq/catalog.js'
import {chatReplyFromEvent,replyDeliveryParts} from '../lib/chat/protocol.js'
const item={id:'builtin-happy',name:'开心',tags:['微笑'],mediaType:'image/png',size:1},data=Buffer.from([1])
const library={list:async()=>[item],image:async()=>({item,data})}
const channel={id:'qq',platform:'qq',enabled:true,companionId:'c',accountId:'12345678'}
const faces=[{id:'14',name:'/微笑',category:'经典',image:'https://qzonestyle.gtimg.cn/qzone/em/e100.gif'}]
const signal=AbortSignal.timeout(5000)
test('default stays unchanged; only a known QQ origin uses channel-specific stickers',async()=>{
 const registry=new StickerAdapters(library)
 registry.register('qq',c=>qqStickerAdapter(c,registry.fallback,async()=>faces))
 assert.equal((await registry.forRoute(undefined,[channel]).resolve('c',item.id,signal)).data,data)
 const adapter=registry.forRoute({channelId:'qq',companionId:'c'},[channel])
 assert.equal((await adapter.list('c','微笑',signal))[0].id,'qq-face-14')
 assert.equal((await adapter.resolve('c','qq-face-14',signal)).native.id,'14')
 await assert.rejects(adapter.resolve('c','builtin-happy',signal),/当前使用 QQ 表情库/)
 assert.equal((await registry.forRoute({channelId:'qq',companionId:'other'},[channel]).resolve('c',item.id,signal)).data,data)
})
test('explicit default preference works; offline QQ never substitutes defaults and custom IDs remain bound to their account',async()=>{
 const fallback=new StickerAdapters(library).fallback
 assert.equal((await qqStickerAdapter({...channel,qq:{stickerSource:'default'}},fallback,async()=>faces).resolve('c',item.id,signal)).data,data)
 const offline=qqStickerAdapter(channel,fallback,async()=>{throw Error('offline')})
 assert.deepEqual(await offline.list('c','',signal),[])
 await assert.rejects(offline.resolve('c',item.id,signal),/当前使用 QQ 表情库/)
 const custom=qqCustomCatalog([{emoji_id:'favorite-full-id',desc:'得意',url:'https://gchat.qpic.cn/favorite.gif'}])
 const adapter=qqStickerAdapter(channel,fallback,async()=>custom),list=await adapter.list('c','得意',signal)
 const result=await adapter.resolve('c',list[0].id,signal)
 assert.equal(result.native.provider,'qq-custom');assert.equal(result.native.id,'favorite-full-id');assert.equal(result.native.accountId,channel.accountId)
 assert.equal(validNativeEmoji(result.native),true)
 assert.equal(validNativeEmoji({...result.native,previewUrl:'https://evil.example/x'}),false)
})
test('native emoji replies preserve text order and survive transcript and notification projection',()=>{
 const emoji={provider:'qq',id:'14',channelId:'qq',accountId:'12345678',label:'微笑'}
 const parts=[{type:'text',text:'你好'},{type:'emoji',emoji}]
 const event={type:'tool/result',data:{message:{},meta:{kind:'partner-chat-v1',parts}}}
 assert.deepEqual(chatReplyFromEvent(event).parts,parts)
 assert.deepEqual(replyDeliveryParts({text:'你好',attachments:[],chatParts:parts}),parts)
 assert.deepEqual(replyDeliveryParts({text:'你好',attachments:[],chatParts:parts,attachmentPolicy:'text-only'}),[{type:'text',text:'你好'},{type:'text',text:''}])
})

test('autonomous inspection of a builtin keeps its real bitmap despite a matching QQ face',async()=>{
 const {chatTools}=await import('../lib/chat/tools.js')
 const {StickerLibrary}=await import('../lib/chat/stickers.js')
 const real=new StickerLibrary(()=>'/unused'),adapters=new StickerAdapters(real)
 adapters.register('qq',c=>qqStickerAdapter(c,adapters.fallback,async()=>[{id:'371',name:'/冒泡',category:'QQ',image:'https://qzonestyle.gtimg.cn/qzone/em/e10371.gif'}]))
 const route={id:'r',channelId:'qq',kind:'channel',companionId:'c',sessionId:'s',inboundMessageIds:['u']}
 const state={channels:[{...channel,qq:{stickerSource:'default'}}],sessions:[route],companions:[{id:'c',characterCard:{enabled:true,stickersEnabled:true}}]}
 const events=[{type:'user/message',seq:1,data:{id:'u',source:{kind:'user'}}},{type:'turn/start',seq:2},{type:'user/message',seq:3,data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:'伙伴闲时主动联系'}}}]
 const expected=await real.image('c','builtin-fox-peek');let saved
 const tool=chatTools('c',{snapshot:()=>state,isCompanionRemoving:()=>false},real,{}, {attachments:{saveImage:async value=>{saved=value;return {kind:'image',path:'local'}}}},'',adapters)[0]
 const result=await tool.execute({action:'inspect',id:'builtin-fox-peek'},{signal:new AbortController().signal,agent:{session:{id:'s',snapshotEvents:()=>events}}})
 assert.deepEqual(saved.data,expected.data);assert.equal(result.content[1].type,'image')
 assert.equal((await adapters.forRoute(route,state.channels).resolve('c','builtin-fox-peek',signal)).native,undefined)
})

test('QQ searches never introduce builtins and empty-query browsing keeps collections first',async()=>{
 const fallback={list:async()=>assert.fail('must not query builtin library'),resolve:async()=>assert.fail('must not read builtin library')}
 const custom=qqCustomCatalog([{emoji_id:'favorite',desc:'猫咪 无语'}])
 const adapter=qqStickerAdapter(channel,fallback,async()=>[...custom,...faces])
 assert.deepEqual(await adapter.list('c','抱抱',signal),[])
 const list=await adapter.list('c','',signal)
 assert.equal(list[0].id.startsWith('qq-custom-'),true);assert.equal(list[1].id,'qq-face-14')
 await assert.rejects(adapter.resolve('c','builtin-care',signal),/不使用内置表情替代/)
})

test('image lookup excludes QQ faces and all-mode ranks collections before faces',async()=>{
 const custom=qqCustomCatalog([{emoji_id:'favorite',desc:'得意'}])
 const adapter=qqStickerAdapter(channel,new StickerAdapters(library).fallback,async()=>[{id:'14',name:'得意 开心',category:'QQ'},...custom])
 const images=await adapter.list('c','得意',signal,'image')
 assert.equal(images.length,1);assert.ok(images[0].id.startsWith('qq-custom-'))
 assert.deepEqual(await adapter.list('c','开心',signal,'image'),[])
 const all=await adapter.list('c','得意 开心',signal,'all')
 assert.ok(all[0].id.startsWith('qq-custom-'));assert.equal(all[1].id,'qq-face-14')
 const disabled=qqStickerAdapter({...channel,qq:{...channel.qq,imagesEnabled:false}},new StickerAdapters(library).fallback,async()=>custom)
 assert.deepEqual(await disabled.list('c','',signal,'image'),[])
})

test('sticker tool defaults to image search, preserves explicit all and honors disabled setting',async()=>{
 const {chatTools}=await import('../lib/chat/tools.js');let kind
 const state={companions:[{id:'c',characterCard:{enabled:true,stickersEnabled:true}}],channels:[],sessions:[]}
 const adapters={forRoute:()=>({list:async(_owner,_query,_signal,value)=>{kind=value;return []}})}
 const tool=chatTools('c',{snapshot:()=>state,isCompanionRemoving:()=>false},library,{}, {},'',adapters)[0]
 const exec={signal,agent:{session:{id:'s',snapshotEvents:()=>[]}}}
 await tool.execute({action:'list'},exec);assert.equal(kind,'image')
 await tool.execute({action:'list',kind:'all'},exec);assert.equal(kind,'all')
 state.companions[0].characterCard.stickersEnabled=false
 await assert.rejects(tool.execute({action:'list'},exec),/未开启/)
})
