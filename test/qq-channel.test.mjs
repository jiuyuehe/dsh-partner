import {parseQqSettings} from '../lib/channels/qq/settings.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OneBotConnection } from '../lib/channels/qq/connection.js'
import { oneBotMessage } from '../lib/channels/qq/message.js'
import { qqMediaUrl } from '../lib/channels/qq/transport.js'
import { DirectTransport, directConfig } from '../lib/channels/direct/transport.js'
const bot='12345678', peer='87654321'
const event=(extra={})=>({post_type:'message',message_type:'private',sub_type:'friend',self_id:Number(bot),user_id:Number(peer),message_id:-123,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'你好'}}],...extra})
async function server(t,handler) {
  const wss=new WebSocketServer({host:'127.0.0.1',port:0});await once(wss,'listening')
  const requests=[],connections=[]
  wss.on('connection',(ws,req)=>{
    connections.push({ws,token:new URL(req.url,'http://local').searchParams.get('access_token')})
    ws.on('message',async data=>{
      const r=JSON.parse(data);requests.push(r)
      const value=handler?await handler(r,ws):undefined
      if(value===false)return
      const response=value??(r.action==='get_login_info'?{user_id:Number(bot)}:r.action==='get_status'?{online:true,good:true}:r.action==='get_friend_list'?[{user_id:Number(peer)}]:r.action==='upload_private_file'?{file_id:'f1'}:{message_id:-456})
      if(ws.readyState===1)ws.send(JSON.stringify({status:'ok',retcode:0,data:response,echo:r.echo}))
    })
  })
  t.after(async()=>{for(const c of wss.clients)c.terminate();await new Promise(resolve=>wss.close(resolve))})
  return {url:`ws://127.0.0.1:${wss.address().port}`,requests,connections,wss}
}
test('QQ requires forward WS, separate token and valid target',()=>{
  assert.equal(directConfig({platform:'qq',baseUrl:'ws://snowluma:3001'}).baseUrl,'ws://snowluma:3001')
  for(const baseUrl of ['http://snowluma:3000','ws://user:secret@host','ws://host?access_token=secret','file:///tmp'])assert.throws(()=>directConfig({platform:'qq',baseUrl}))
  assert.throws(()=>directConfig({platform:'qq',baseUrl:'ws://host',targetId:'group:1'}))
})
test('private events preserve signed IDs and mixed text/media; ignore groups, strangers and self echoes',()=>{
  const m=oneBotMessage(event({message:[{type:'text',data:{text:'看看'}},{type:'image',data:{url:'https://gchat.qpic.cn/x'}}]}),bot)
  assert.equal(m.id,`qq:${bot}:${peer}:-123`);assert.equal(m.text,'看看');assert.equal(m.media.length,1)
  for(const extra of [{message_type:'group'},{post_type:'message_sent'},{user_id:Number(bot)},{self_id:999999},{sub_type:'group'},{sub_type:'other'}])assert.equal(oneBotMessage(event(extra),bot),undefined)
  assert.equal(oneBotMessage(event(),bot,'999999'),undefined)
})
test('one WS receives events and routes literal text replies without CQ execution',async t=>{
  const s=await server(t),api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:''},'ws-secret',{accountId:bot,peerId:''});t.after(()=>api.close())
  assert.equal((await api.validate()).accountId,bot)
  s.connections[0].ws.send(JSON.stringify(event()))
  const batch=await api.poll(undefined,AbortSignal.timeout(3000),100)
  assert.equal(batch.messages[0].text,'你好')
  const target=api.forTarget(peer,{accountId:bot,peerId:peer})
  assert.equal(target.progress(peer),undefined)
  await target.sendText(peer,'[CQ:at,qq=all] 原样发送',undefined)
  assert.equal(s.connections.length,1);assert.equal(s.connections[0].token,'ws-secret')
  assert.deepEqual(s.requests.at(-1).params.message,[{type:'text',data:{text:'[CQ:at,qq=all] 原样发送'}}])
  await assert.rejects(target.sendText('999999','wrong target',undefined),/不匹配/)
})
test('echo correlates concurrent responses arriving out of order',async t=>{
  const s=await server(t,async r=>{if(r.action==='slow')await new Promise(resolve=>setTimeout(resolve,40));return r.action})
  const c=new OneBotConnection(s.url,'secret');t.after(()=>c.close())
  assert.deepEqual(await Promise.all([c.call('slow',{}),c.call('fast',{})]),['slow','fast'])
})
test('disconnect rejects unacknowledged send without replay; next read reconnects',async t=>{
  const s=await server(t,(r,ws)=>{if(r.action==='send_private_msg'){ws.close();return false}})
  const c=new OneBotConnection(s.url,'secret');t.after(()=>c.close())
  await assert.rejects(c.call('send_private_msg',{}),/断开/)
  await c.call('get_status',{})
  assert.equal(s.requests.filter(r=>r.action==='send_private_msg').length,1);assert.equal(s.connections.length,2)
})
test('account change, offline account and missing friend fail before sending',async t=>{
  let mode='switch'
  const s=await server(t,r=>r.action==='get_login_info'?{user_id:mode==='switch'?999999:Number(bot)}:r.action==='get_status'?{online:mode!=='offline',good:true}:r.action==='get_friend_list'?[]:undefined)
  const api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:peer},'secret',{accountId:bot,peerId:peer});t.after(()=>api.close())
  await assert.rejects(api.sendText(peer,'hello',undefined),/账号/)
  mode='offline';await assert.rejects(api.sendText(peer,'hello',undefined),/尚未上线/)
  mode='friend';await assert.rejects(api.sendText(peer,'hello',undefined),/好友/)
  assert.equal(s.requests.filter(r=>r.action==='send_private_msg').length,0)
})
test('text plus sticker both send; attachments carry bytes across container boundaries',async t=>{
  const s=await server(t),api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:peer},'secret',{accountId:bot,peerId:peer});t.after(()=>api.close())
  const dir=await mkdtemp(join(tmpdir(),'qq-channel-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const path=join(dir,'sticker.png');await writeFile(path,Buffer.from([137,80,78,71,13,10,26,10,0]))
  await api.sendText(peer,'先发文字',undefined)
  await api.sendAttachment(peer,{path,name:'sticker.png',mediaType:'image/png',kind:'image'},undefined)
  const sent=s.requests.filter(r=>r.action==='send_private_msg');assert.equal(sent.length,2)
  assert.equal(sent[0].params.message[0].type,'text');assert.equal(sent[1].params.message[0].type,'image');assert.match(sent[1].params.message[0].data.file,/^base64:\/\//)
  const txt=join(dir,'note.txt');await writeFile(txt,'文件内容')
  await api.sendAttachment(peer,{path:txt,name:'note.txt',mediaType:'text/plain',kind:'file'},undefined)
  assert.equal(s.requests.at(-1).action,'upload_private_file');assert.match(s.requests.at(-1).params.file,/^base64:\/\//)
})
test('API failure is not delivery; cancellation stops idle receive',async t=>{
  const s=await server(t,(r,ws)=>{if(r.action==='send_private_msg'){ws.send(JSON.stringify({echo:r.echo,status:'failed',retcode:100}));return false}})
  const c=new OneBotConnection(s.url,'secret');t.after(()=>c.close())
  await assert.rejects(c.call('send_private_msg',{}),/retcode 100/)
  await assert.rejects(c.read(AbortSignal.timeout(30),20000))
})
test('media URLs reject arbitrary hosts, credentials and local files',()=>{
  assert.equal(qqMediaUrl('https://multimedia.nt.qq.com/x').hostname,'multimedia.nt.qq.com')
  assert.equal(qqMediaUrl('https://multimedia.nt.qq.com.cn/x').hostname,'multimedia.nt.qq.com.cn')
  for(const url of ['https://multimedia.nt.qq.com.cn.evil.example/x','https://evil.qq.com.cn/x'])assert.throws(()=>qqMediaUrl(url))
  for(const url of ['file:///etc/passwd','http://127.0.0.1:5099/x','https://gchat.qpic.cn.evil.example/x','https://u:p@gchat.qpic.cn/x','https://qq.com/x'])assert.throws(()=>qqMediaUrl(url))
})

const group='99887766', groupUser=`group:${group}:${peer}`
const groupEvent=(extra={})=>event({message_type:'group',sub_type:'normal',group_id:Number(group),message:[{type:'at',data:{qq:bot}},{type:'text',data:{text:'你好'}}],...extra})
const groupSettings={replyVoiceEnabled:false,replyVoiceGroupId:'',identityBinding:{enabled:false,qqIds:[]},autonomousActions:false,enabledActions:[],qzoneVisibility:4,voiceCharacter:'',mainSessionPeers:[],autonomousGroupIds:[],stickerSource:'channel',privateReplies:true,groupReplies:true,groupIds:[group],groupTrigger:'mention',mentionSender:true,facesEnabled:true,imagesEnabled:true}
test('group scoring cues trust structured mentions and replies, never literal CQ strings',()=>{
 const policy={...groupSettings,autonomousGroupIds:[group]}
 const parse=message=>oneBotMessage(event({message_type:'group',group_id:Number(group),message}),bot,'',policy)
 const quoted=parse([{type:'at',data:{qq:peer}},{type:'reply',data:{id:7}},{type:'text',data:{text:'你怎么看'}}])
 assert.equal(quoted.qqGroup.otherMention,true);assert.equal(quoted.qqGroup.hasReply,true);assert.equal(quoted.qqGroup.mentioned,false)
 const direct=parse([{type:'at',data:{qq:bot}},{type:'text',data:{text:'你好'}}])
 assert.equal(direct.qqGroup.mentioned,true);assert.equal(direct.qqGroup.otherMention,undefined)
 const literal=parse(`[CQ:at,qq=${bot}][CQ:reply,id=7]`)
 assert.equal(literal.qqGroup.mentioned,false);assert.equal(literal.qqGroup.hasReply,undefined);assert.equal(literal.qqGroup.otherMention,undefined)
})
test('group intake is opt-in, allowlisted, requires real bot mention and rejects anonymous messages',()=>{
  assert.equal(oneBotMessage(groupEvent(),bot),undefined)
  const parsed=oneBotMessage(groupEvent(),bot,'',groupSettings)
  assert.equal(parsed.sender,groupUser);assert.equal(parsed.targetId,`group:${group}`)
  assert.notEqual(parsed.id,oneBotMessage(event(),bot).id)
  for(const patch of [{group_id:11223344},{anonymous:{id:1}},{message:[{type:'at',data:{qq:'all'}}]},{message:'[CQ:at,qq='+bot+']'}, {message:[{type:'text',data:{text:'@'+bot}}]}])assert.equal(oneBotMessage(groupEvent(patch),bot,'',groupSettings),undefined)
  assert.ok(oneBotMessage(groupEvent({message:'没有 @'}),bot,'',{...groupSettings,groupTrigger:'all'}))
  assert.equal(oneBotMessage(event(),bot,'',{...groupSettings,privateReplies:false}),undefined)
  assert.equal(oneBotMessage(groupEvent(),bot,peer,groupSettings),undefined)
})
test('group text, image and native face use group API; member and group permissions checked before send',async t=>{
  let joined=true,member=true
  const s=await server(t,r=>r.action==='get_group_list'?(joined?[{group_id:Number(group)}]:[]):r.action==='get_group_member_info'?{group_id:Number(group),user_id:member?Number(peer):999999}:undefined)
  const api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:'',qq:groupSettings},'secret',{accountId:bot,peerId:''});t.after(()=>api.close())
  const target=api.forTarget(`group:${group}`,{accountId:bot,peerId:groupUser})
  await target.sendText(groupUser,'群回复',undefined)
  let sent=s.requests.at(-1);assert.equal(sent.action,'send_group_msg');assert.equal(sent.params.group_id,Number(group));assert.equal(sent.params.user_id,undefined)
  assert.deepEqual(sent.params.message[0],{type:'at',data:{qq:peer}})
  await target.onebot.sendFace(groupUser,'14',AbortSignal.timeout(2000),()=>{})
  assert.deepEqual(s.requests.at(-1).params.message.at(-1),{type:'face',data:{id:'14'}})
  const dir=await mkdtemp(join(tmpdir(),'qq-group-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const path=join(dir,'face.png');await writeFile(path,Buffer.from([137,80,78,71,13,10,26,10,0]))
  await target.sendAttachment(groupUser,{path,name:'face.png',mediaType:'image/png',kind:'image'},undefined)
  assert.equal(s.requests.at(-1).action,'send_group_msg');assert.equal(s.requests.at(-1).params.message[0].type,'image')
  const count=s.requests.filter(r=>r.action==='send_group_msg').length
  member=false;await assert.rejects(target.sendText(groupUser,'no',undefined),/成员/)
  member=true;joined=false;await assert.rejects(target.sendText(groupUser,'no',undefined),/不在目标群/)
  assert.equal(s.requests.filter(r=>r.action==='send_group_msg').length,count)
})
test('media and private reply switches block sends and revoked authorization blocks after identity lookup',async t=>{
  const s=await server(t)
  const create=qq=>{const api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:peer,qq},'secret',{accountId:bot,peerId:peer});t.after(()=>api.close());return api}
  await assert.rejects(create({...groupSettings,privateReplies:false}).sendText(peer,'no',undefined),/私聊回复已关闭/)
  await assert.rejects(create({...groupSettings,facesEnabled:false}).onebot.sendFace(peer,'14',AbortSignal.timeout(2000),()=>{}),/表情发送已关闭/)
  const dir=await mkdtemp(join(tmpdir(),'qq-policy-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const path=join(dir,'face.png');await writeFile(path,Buffer.from([137,80,78,71,13,10,26,10,0]))
  await assert.rejects(create({...groupSettings,imagesEnabled:false}).sendAttachment(peer,{path,name:'face.png',mediaType:'image/png',kind:'image'},undefined),/图片与表情包发送已关闭/)
  await assert.rejects(create(groupSettings).onebot.sendText(peer,'no',AbortSignal.timeout(2000),()=>{throw Error('revoked')}),/revoked/)
  assert.equal(s.requests.filter(r=>r.action.startsWith('send_')).length,0)
})
test('settings reject malformed switches and IDs, deduplicate groups, discard unknown fields',async()=>{
  const {parseQqSettings,qqSettings}=await import('../lib/channels/qq/settings.js')
  assert.equal(qqSettings().groupReplies,false);assert.equal(qqSettings().privateReplies,true)
  assert.deepEqual(parseQqSettings({...groupSettings,groupIds:[group,group],unknown:'x'}),groupSettings)
  for(const patch of [{groupIds:['x']},{groupIds:Array(101).fill(group)},{groupTrigger:'random'},{privateReplies:'true'}])assert.throws(()=>parseQqSettings({...groupSettings,...patch}))
})
test('face catalog uses actual QQ image URLs, replaces ZIP previews with catalog CDN codes and excludes invalid entries',async()=>{
 const {qqFaceCatalog}=await import('../lib/channels/qq/catalog.js')
 const faces=qqFaceCatalog({packs:[{pack_name:'经典表情',emojis:[{q_sid:'14',q_des:'/微笑',em_code:'100',url:'https://wa.qq.com/qgif/14.zip'},{q_sid:'14',em_code:'999'},{q_sid:'1',url:'https://gchat.qpic.cn/1.png'},{q_sid:'2',url:'https://evil.example/secret.png'},{q_sid:'3',url:'https://user:secret@gchat.qpic.cn/1.png'},{q_sid:'😀',q_des:'unicode'}]}]})
 assert.equal(faces.length,4)
 assert.equal(faces[0].image,'https://qzonestyle.gtimg.cn/qzone/em/e100.gif')
 assert.equal(faces[1].image,'https://gchat.qpic.cn/1.png')
 assert.equal(faces[2].image,undefined);assert.equal(faces[3].image,undefined)
 assert.deepEqual(qqFaceCatalog(null),[])
})
test('QQ settings commit restarts only the affected enabled channel and stale edits are rejected',async()=>{
 const {ChannelManager}=await import('../lib/channels/manager.js')
 let state={channels:[{id:'qq',platform:'qq',enabled:true,updatedAt:1}]},stops=0,starts=0
 const store={snapshot:()=>structuredClone(state),update:async fn=>{const draft=structuredClone(state);fn(draft);state=draft}}
 const manager=new ChannelManager({},store,{}, {},'/tmp')
 manager.stop=async()=>{stops++};manager.start=async()=>{starts++}
 await manager.updateQq('qq',groupSettings,1)
 assert.deepEqual(state.channels[0].qq,groupSettings);assert.equal(stops,1);assert.equal(starts,1)
 await assert.rejects(manager.updateQq('qq',groupSettings,1),/配置已变化/)
 assert.equal(stops,1)
 state.channels[0].enabled=false
 await manager.updateQq('qq',{...groupSettings,groupReplies:false},state.channels[0].updatedAt)
 assert.equal(starts,1)
})
test('QQ connection validation preserves token, checks identity and rolls credentials back when saving fails',async t=>{
 const {ChannelManager}=await import('../lib/channels/manager.js')
 const s=await server(t)
 const state={channels:[{id:'qq',platform:'qq',enabled:true,accountId:bot,updatedAt:1,direct:{baseUrl:'ws://old:3001',targetId:''}}]}
 let credential={baseUrl:'ws://old:3001',botToken:'original'},writes=0,starts=0
 const manager=new ChannelManager({}, {snapshot:()=>structuredClone(state),update:async()=>{throw Error('disk full')}},{read:async()=>({...credential}),write:async(id,value)=>{credential={...value};writes++}}, {},'/tmp')
 manager.stop=async()=>{};manager.start=async()=>{starts++}
 await manager.updateQqConnection('qq',{baseUrl:s.url,botToken:'',testOnly:true,expectedUpdatedAt:1})
 assert.equal(writes,0);assert.equal(s.connections[0].token,'original')
 await assert.rejects(manager.updateQqConnection('qq',{baseUrl:s.url,botToken:'new',testOnly:false,expectedUpdatedAt:1}),/disk full/)
 assert.equal(credential.botToken,'original');assert.equal(credential.baseUrl,'ws://old:3001');assert.equal(starts,1)
})

test('autonomous group whitelist receives unmentioned group messages without expanding other groups',()=>{
 const policy={...groupSettings,autonomousGroupIds:[group]}
 const message=oneBotMessage(groupEvent({message:[{type:'text',data:{text:'今天好累'}}]}),bot,'',policy)
 assert.equal(message.qqGroup.autonomous,true);assert.equal(message.qqGroup.mentioned,false)
 assert.equal(oneBotMessage(groupEvent({group_id:88776655,message:'hello'}),bot,'',policy),undefined)
})
test('native custom stickers use the QQ favorite API and never turn a failed send into a second message',async t=>{
 const s=await server(t),api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:peer,qq:groupSettings},'secret',{accountId:bot,peerId:peer});t.after(()=>api.close())
 await api.onebot.sendCustomFace(peer,'favorite-id',AbortSignal.timeout(2000),()=>{})
 assert.equal(s.requests.at(-1).action,'send_custom_face');assert.deepEqual(s.requests.at(-1).params,{user_id:Number(peer),emoji_id:'favorite-id'})
 await assert.rejects(api.onebot.sendCustomFace(peer,'favorite-id',AbortSignal.timeout(2000),()=>{throw Error('revoked')}),/revoked/)
 assert.equal(s.requests.filter(r=>r.action==='send_custom_face').length,1)
})


test('main-session selections accept private/group IDs, default off and reject malformed peers',()=>{
 assert.deepEqual(parseQqSettings({...groupSettings,mainSessionPeers:undefined}).mainSessionPeers,[])
 assert.deepEqual(parseQqSettings({...groupSettings,mainSessionPeers:['private:12345678','group:99887766','private:12345678']}).mainSessionPeers,['private:12345678','group:99887766'])
 for(const peers of [['12345678'],['group:99887766:12345678'],['private:abc'],Array(101).fill('private:12345678')])assert.throws(()=>parseQqSettings({...groupSettings,mainSessionPeers:peers}),/主会话对象/)
})

test('action authorization is rechecked after websocket connection before writing',async t=>{
 const s=await server(t),connection=new OneBotConnection(s.url,'secret');t.after(()=>connection.close())
 await assert.rejects(connection.call('send_group_msg',{group_id:99887766,message:[]},AbortSignal.timeout(2000),()=>{throw Error('revoked after connect')}),/revoked/)
 assert.equal(s.requests.length,0)
})

test('independent QQ validation calls overlap while all identity checks remain mandatory',async()=>{
 const {OneBotTransport}=await import('../lib/channels/qq/transport.js')
 const calls=[],waiters=new Map()
 const api=new OneBotTransport({baseUrl:'ws://local',targetId:'group:99887766',qq:{groupReplies:true,groupIds:['99887766']}},'',{accountId:'12345678',peerId:'group:99887766:22345678'},{call(action){calls.push(action);return new Promise(resolve=>waiters.set(action,resolve))}})
 const validation=api.validate()
 assert.deepEqual(calls,['get_login_info','get_status'])
 waiters.get('get_login_info')({user_id:12345678});waiters.get('get_status')({online:true,good:true})
 await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(calls.slice(2),['get_group_list','get_group_member_info'])
 waiters.get('get_group_list')([{group_id:99887766}]);waiters.get('get_group_member_info')({group_id:99887766,user_id:22345678})
 assert.deepEqual(await validation,{accountId:'12345678',peerId:'group:99887766:22345678'})
})

test('quoted reply routing uses confirmed same-group message authors, never untrusted quote metadata',async t=>{
 const s=await server(t,r=>r.action==='send_group_msg'?{message_id:7654321}:undefined)
 const c=new OneBotConnection(s.url,'secret');t.after(()=>c.close())
 await c.call('send_group_msg',{group_id:Number(group),message:[]})
 assert.equal(c.quotedTarget(group,'7654321',bot),'self')
 assert.equal(c.quotedTarget('11223344','7654321',bot),undefined)
 s.connections[0].ws.send(JSON.stringify(groupEvent({message_id:333,user_id:Number(peer)})))
 await c.read(AbortSignal.timeout(2000),200)
 assert.equal(c.quotedTarget(group,'333',bot),'other')
 assert.equal(c.quotedTarget(group,'unknown',bot),undefined)
 const raw=oneBotMessage(groupEvent({message:[{type:'reply',data:{id:333,qq:bot}},{type:'at',data:{qq:bot}}]}),bot,'',groupSettings)
 assert.equal(raw.qqGroup.replyToId,'333');assert.equal(raw.qqGroup.replyTo,undefined)
})

const pokeEvent=(extra={})=>({post_type:'notice',notice_type:'notify',sub_type:'poke',self_id:Number(bot),user_id:Number(peer),target_id:Number(bot),time:1793697000,...extra})
test('poke notices use ordinary permission routing and explicit bot mentions survive without text',()=>{
 const raw=pokeEvent({group_id:Number(group)})
 const m=oneBotMessage(raw,bot,'',groupSettings)
 assert.equal(m.sender,groupUser);assert.equal(m.qqGroup.mentioned,true);assert.match(m.text,/戳了戳你/)
 assert.equal(oneBotMessage(raw,bot,'',groupSettings).id,m.id)
 for(const extra of [{target_id:33445566},{self_id:33445566},{user_id:Number(bot)},{group_id:33445566},{time:undefined}])assert.equal(oneBotMessage({...raw,...extra},bot,'',groupSettings),undefined)
 assert.equal(oneBotMessage(pokeEvent(),bot,'',{...groupSettings,privateReplies:false}),undefined)
 assert.match(oneBotMessage(groupEvent({message:[{type:'at',data:{qq:bot}}]}),bot,'',groupSettings).text,/@ 了你/)
})
test('forward WS delivers poke notices through the same poll path as chat',async t=>{
 const s=await server(t),api=new DirectTransport({platform:'qq',baseUrl:s.url,targetId:'',qq:groupSettings},'',{accountId:bot,peerId:''});t.after(()=>api.close())
 await api.validate()
 s.connections[0].ws.send(JSON.stringify(pokeEvent({group_id:Number(group)})))
 const batch=await api.poll(undefined,AbortSignal.timeout(3000),100)
 assert.equal(batch.messages.length,1);assert.match(batch.messages[0].text,/戳了戳你/)
})

test('API failure preserves safe protocol diagnostics and does not reflect server secrets',async t=>{
 const s=await server(t,(r,ws)=>{ws.send(JSON.stringify({echo:r.echo,status:'failed',retcode:1200,wording:'OIDB error 1002 on 0xed3_1: Process_Nudge failed token=secret https://private.invalid'}));return false})
 const c=new OneBotConnection(s.url,'');t.after(()=>c.close())
 await assert.rejects(c.call('send_poke',{}),error=>{assert.match(error.message,/OIDB 1002.*0xed3_1.*Process_Nudge failed/);assert.ok(!/secret|private.invalid/.test(error.message));return true})
})
