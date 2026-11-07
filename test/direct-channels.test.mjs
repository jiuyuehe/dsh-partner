import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {DirectTransport,directConfig} from '../lib/channels/direct/transport.js'
import {notificationRoute} from '../lib/channels/notification-route.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {directLogin, discardDirectLogin} from '../lib/channels/direct/login.js'

async function server(t,handler) {
  const requests=[]
  const http=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    requests.push({path:req.url,method:req.method,authorization:req.headers.authorization,body})
    res.setHeader('content-type','application/json')
    const reply=handler(req,body)
    res.statusCode=reply.status??200
    if(reply.location)res.setHeader('location',reply.location)
    if(reply.headers)for(const [key,value] of Object.entries(reply.headers))res.setHeader(key,value)
    res.end(JSON.stringify(reply.data??reply))
  })
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>{http.close(resolve);http.closeAllConnections()}))
  return {url:`http://127.0.0.1:${http.address().port}`,requests}
}
const members=[{type:'m.room.member',state_key:'@bot:local',content:{membership:'join'}},{type:'m.room.member',state_key:'@user:local',content:{membership:'join'}}]
test('Matrix progress uses rich replacement events and accepts empty typing responses',async t=>{
  const s=await server(t,req=>req.url.includes('/typing/')?{status:204}: {data:matrix(req.url)})
  const api=new DirectTransport({platform:'matrix',baseUrl:s.url,targetId:'!room:local'},'test-token')
  const progress=api.progress('@user:local'),signal=new AbortController().signal
  await progress.typing(true,signal)
  const id=await progress.create('正在处理…',signal)
  await progress.edit(id,'**完成**',signal)
  await progress.typing(false,signal)
  const edits=s.requests.filter(r=>r.method==='PUT'&&r.path.includes('/send/')).map(r=>JSON.parse(r.body))
  assert.equal(edits[1]['m.relates_to'].rel_type,'m.replace')
  assert.equal(edits[1]['m.relates_to'].event_id,'sent')
  assert.match(edits[1]['m.new_content'].formatted_body,/<strong>完成<\/strong>/)
})
function matrix(path,states=members) {
  if(path.includes('whoami'))return {user_id:'@bot:local'}
  if(path.endsWith('/state'))return states
  if(path.includes('/sync'))return {next_batch:'next',rooms:{join:{'!room:local':{timeline:{events:[{type:'m.room.message',event_id:'event',sender:'@user:local',content:{msgtype:'m.text',body:'hello'}}]}}}}}
  return {event_id:'sent'}
}
test('Matrix uses authenticated API, ignores first-sync history, then reads and replies to pinned peer',async t=>{
  const s=await server(t,req=>({data:matrix(req.url)}))
  const api=new DirectTransport({platform:'matrix',baseUrl:s.url,targetId:'!room:local'},'test-token')
  assert.equal((await api.validate()).accountId,'@bot:local')
  assert.deepEqual((await api.poll(undefined,new AbortController().signal)).messages,[])
  assert.equal((await api.poll('old',new AbortController().signal)).messages[0].text,'hello')
  await api.sendText('@user:local','reply',undefined)
  assert.ok(s.requests.every(r=>r.authorization==='Bearer test-token'))
  assert.ok(s.requests.some(r=>r.method==='PUT'&&JSON.parse(r.body).body==='reply'))
  await api.sendText('@user:local','**bold**\n\n```js\na < b\n```',undefined)
  const rich=JSON.parse(s.requests.filter(r=>r.method==='PUT').at(-1).body)
  assert.equal(rich.format,'org.matrix.custom.html')
  assert.match(rich.formatted_body,/<strong>bold<\/strong>/)
  assert.match(rich.formatted_body,/a &lt; b/)
  assert.match(rich.body,/\*\*bold\*\*/)
  await assert.rejects(api.sendText('@intruder:local','secret',undefined),/不匹配/)
  await assert.rejects(api.sendAttachment('@intruder:local', {path:'/unused',name:'file',mediaType:'text/plain',kind:'file'},undefined),/不匹配/)
})
for(const scenario of ['encrypted','group','changed-peer'])test(`Matrix rejects ${scenario}`,async t=>{
  const state=scenario==='encrypted'?[...members,{type:'m.room.encryption'}]:scenario==='group'?[...members,{type:'m.room.member',state_key:'@other:local',content:{membership:'join'}}]:members
  const s=await server(t,req=>({data:matrix(req.url,state)}))
  const api=new DirectTransport({platform:'matrix',baseUrl:s.url,targetId:'!room:local'},'test-token',scenario==='changed-peer'?{accountId:'@bot:local',peerId:'@other:local'}:undefined)
  await assert.rejects(api.validate())
  assert.ok(!s.requests.some(r=>r.method==='PUT'))
})
test('Mattermost preserves verified DM routing and exposes thread roots for replies',async t=>{
  let roomType='D'
  const s=await server(t,req=>{
    if(req.url==='/api/v4/users/me')return {id:'bot'}
    if(req.url.includes('/members'))return {data:[{user_id:'bot'},{user_id:'user'}]}
    if(req.url.includes('/posts?'))return {order:['a','b'],posts:{a:{id:'a',user_id:'user',message:'hello',create_at:100},b:{id:'b',user_id:'user',message:'thread',root_id:'a',create_at:101}}}
    if(req.method==='POST')return {id:'sent'}
    return {type:roomType}
  })
  const api=new DirectTransport({platform:'mattermost',baseUrl:s.url,targetId:'dm'},'test-token')
  assert.deepEqual((await api.poll(undefined,new AbortController().signal)).messages,[])
  const posts=(await api.poll('50',new AbortController().signal)).messages
  assert.deepEqual(posts.map(({id,sender,text,targetId,rootId})=>({id,sender,text,targetId,rootId})),[
    {id:'a',sender:'user',text:'hello',targetId:'dm',rootId:undefined},
    {id:'b',sender:'user',text:'thread',targetId:'dm',rootId:'a'},
  ])
  await api.sendText('user','reply',undefined)
  assert.ok(s.requests.some(r=>r.method==='POST'&&JSON.parse(r.body).channel_id==='dm'))
  await api.sendText('user','**bold**',undefined)
  assert.equal(JSON.parse(s.requests.filter(r=>r.method==='POST').at(-1).body).message,'**bold**')
  roomType='O';await assert.rejects(api.validate(),/双人 DM/)
})
test('server redirects are not followed with credentials; bad config is rejected',async t=>{
  const s=await server(t,()=>({status:302,location:'http://localhost:1/secret'}))
  await assert.rejects(new DirectTransport({platform:'matrix',baseUrl:s.url,targetId:'room'},'secret').validate())
  for(const baseUrl of ['file:///tmp','https://user:pass@example.com','https://example.com?token=secret'])assert.throws(()=>directConfig({platform:'matrix',baseUrl,targetId:'room'}))
})

for(const platform of ['matrix','mattermost'])test(`${platform} password login exchanges credentials and revokes temporary sessions`,async t=>{
  const s=await server(t,req=>req.url.endsWith('/logout')?{data:{}}:{data:{access_token:'session-token'},headers:{Token:'session-token'}})
  const config={platform,baseUrl:s.url,targetId:'room'}
  const token=await directLogin(config,{username:'alice',password:'test-password',mfaToken:'123456'})
  assert.equal(token,'session-token')
  const payload=JSON.parse(s.requests[0].body)
  assert.equal(payload.password,'test-password')
  assert.equal(s.requests[0].authorization,undefined)
  if(platform==='matrix')assert.equal(payload.identifier.user,'alice')
  else {assert.equal(payload.login_id,'alice');assert.equal(payload.token,'123456')}
  await discardDirectLogin(config,token)
  assert.equal(s.requests[1].authorization,'Bearer session-token')
  assert.ok(!s.requests[1].body.includes('test-password'))
})
test('password login errors do not expose server response or follow redirects',async t=>{
  const s=await server(t,()=>({status:401,data:{error:'test-password'}}))
  await assert.rejects(directLogin({platform:'matrix',baseUrl:s.url,targetId:'room'},{username:'alice',password:'test-password'}),e=>!e.message.includes('test-password')&&e.message.includes('401'))
  const redirect=await server(t,()=>({status:302,location:s.url}))
  await assert.rejects(directLogin({platform:'mattermost',baseUrl:redirect.url,targetId:'room'},{username:'alice',password:'test-password'}))
  assert.equal(s.requests.length,1)
})

function routingState() {
  return {channels:[{id:'wx',enabled:true,companionId:'c'},{id:'mx',enabled:true,companionId:'c'},{id:'mm',enabled:true,companionId:'c'}],
    pairings:[{id:'a',channelId:'wx',userId:'a',status:'approved',contactKey:'owner',lastInboundAt:10},{id:'b',channelId:'mx',userId:'b',status:'approved',contactKey:'owner',lastInboundAt:20},{id:'stranger',channelId:'mm',userId:'stranger',status:'approved',lastInboundAt:100}],sessions:[]}
}

test('Matrix 429 reads retry_after_ms and suppresses repeated authentication during cooldown',async t=>{
 const s=await server(t,()=>({status:429,data:{errcode:'M_LIMIT_EXCEEDED',retry_after_ms:12000}}))
 const config={platform:'matrix',baseUrl:s.url,targetId:''},input={username:'test',password:'hidden'}
 await assert.rejects(directLogin(config,input),e=>e.status===429&&e.retryAfterMs===12000&&!e.message.includes('hidden'))
 await assert.rejects(directLogin(config,input),e=>e.status===429&&e.retryAfterMs>0)
 assert.equal(s.requests.length,1)
})

test('account-only configuration validates without any room lookup',async t=>{
  const s=await server(t,()=>({user_id:'@bot:local'}))
  const config=directConfig({platform:'matrix',baseUrl:s.url})
  assert.equal(config.targetId,'')
  const api=new DirectTransport(config,'token')
  assert.deepEqual(await api.validate(),{accountId:'@bot:local',peerId:''})
  assert.equal(s.requests.length,1)
  await assert.rejects(api.sendText('@user:local','secret',undefined),/尚未配对/)
})
test('Matrix discovers private rooms, skips encrypted rooms and ignores initial history',async t=>{
  const s=await server(t,req=>{
    if(req.url.includes('whoami'))return {user_id:'@bot:local'}
    if(req.url.includes('/state'))return {data:req.url.includes('encrypted')?[...members,{type:'m.room.encryption'}]:members}
    return {next_batch:'next',rooms:{join:{'!room:local':{timeline:{events:[{type:'m.room.message',event_id:'hello',sender:'@user:local',content:{msgtype:'m.text',body:'pair'}}]}},'!encrypted:local':{timeline:{events:[{type:'m.room.message',event_id:'secret',sender:'@user:local',content:{msgtype:'m.text',body:'secret'}}]}}}}}
  })
  const api=new DirectTransport({platform:'matrix',baseUrl:s.url,targetId:''},'token')
  assert.deepEqual((await api.poll(undefined,new AbortController().signal)).messages,[])
  assert.deepEqual((await api.poll('old',new AbortController().signal)).messages,[{id:'hello',sender:'@user:local',targetId:'!room:local',text:'pair'}])
})
test('Matrix accepts only explicit unencrypted two-member DM invitations',async t=>{
  const invite={invite_state:{events:[members[1],{type:'m.room.member',state_key:'@bot:local',sender:'@user:local',content:{membership:'invite',is_direct:true}}]}}
  const s=await server(t,req=>{
    if(req.url.includes('whoami'))return {user_id:'@bot:local'}
    if(req.url.includes('/join/'))return {room_id:'!safe:local'}
    return {next_batch:'next',rooms:{invite:{'!safe:local':invite,'!unsafe:local':{invite_state:{events:[...invite.invite_state.events,{type:'m.room.encryption'}]}}}}}
  })
  await new DirectTransport({platform:'matrix',baseUrl:s.url,targetId:''},'token').poll('old',new AbortController().signal)
  assert.equal(s.requests.filter(r=>r.method==='POST').length,1)
  assert.ok(s.requests.find(r=>r.method==='POST').path.includes('safe'))
})
test('Mattermost discovers only DM rooms and preserves room routing metadata',async t=>{
  const s=await server(t,req=>{
    if(req.url==='/api/v4/users/me')return {id:'bot'}
    if(req.url==='/api/v4/users/bot/channels')return {data:[{id:'dm',type:'D'},{id:'public',type:'O'}]}
    if(req.url.includes('/members'))return {data:[{user_id:'bot'},{user_id:'user'}]}
    if(req.url.includes('/posts?'))return {order:['a'],posts:{a:{id:'a',user_id:'user',message:'pair',create_at:100}}}
    return {type:'D'}
  })
  const api=new DirectTransport({platform:'mattermost',baseUrl:s.url,targetId:''},'token')
  assert.deepEqual((await api.poll(undefined,new AbortController().signal)).messages,[])
  const [message]=(await api.poll('50',new AbortController().signal)).messages
  assert.equal(message.id,'a');assert.equal(message.sender,'user');assert.equal(message.text,'pair');assert.equal(message.targetId,'dm');assert.equal(message.timestamp,100)
  assert.equal(message.isBotMentioned,false);assert.equal(message.updateAt,100)
  assert.ok(!s.requests.some(r=>r.path.includes('/channels/public')))
})
test('discovered contact must pair before model execution; another room cannot inherit approval',async()=>{
  const state={recentReceipts:[],companions:[{id:'c'}],channels:[{id:'mx',enabled:true,companionId:'c',direct:{targetId:''}}],pairings:[]}
  let runs=0;const sent=[]
  const manager=new ChannelManager({}, {snapshot:()=>state,update:async fn=>fn(state)}, {}, {reply:async()=>{runs++;return {text:'done',attachments:[]}}},'/tmp')
  const api={sendText:async(_,text)=>sent.push(text)}
  const event={id:'pair',sender:'u',text:'hello',targetId:'room-a'}
  await manager.handleDirect(state.channels[0],api,event,new AbortController().signal)
  assert.equal(runs,0);assert.equal(state.pairings[0].status,'pending')
  assert.match(state.pairings[0].pairingCode,/^[A-F0-9]{8}$/)
  assert.ok(sent[0].includes(state.pairings[0].pairingCode))
  state.pairings[0].status='approved'
  await manager.handleDirect(state.channels[0],api,{...event,id:'intruder',targetId:'room-b'},new AbortController().signal)
  assert.equal(runs,0)
  await manager.handleDirect(state.channels[0],api,{...event,id:'approved'},new AbortController().signal)
  assert.equal(runs,1)
})
test('shared companion routing follows latest inbound across channels without contact linking',()=>{
  const s=routingState();s.sessions.push({channelId:'wx',userId:'a',lastMessageAt:999999})
  assert.deepEqual(notificationRoute(s,'wx','a'),{channelId:'mm',userId:'stranger'})
  delete s.pairings[0].contactKey
  assert.deepEqual(notificationRoute(s,'wx','a'),{channelId:'mm',userId:'stranger'})
})
test('explicit route wins and unavailable latest target never falls back',()=>{
  const s=routingState();s.pairings[0].deliveryTarget={channelId:'wx',userId:'a'}
  assert.deepEqual(notificationRoute(s,'wx','a'),{channelId:'wx',userId:'a'})
  delete s.pairings[0].deliveryTarget;s.channels[2].enabled=false
  assert.throws(()=>notificationRoute(s,'wx','a'),/不可用/)
  s.channels[1].enabled=true;s.pairings[0].deliveryTarget={channelId:'mx',userId:'b'};s.pairings[1].status='blocked'
  assert.throws(()=>notificationRoute(s,'wx','a'),/不可用/)
})
test('direct connector never re-executes agent command after failed send',async()=>{
  const state={recentReceipts:[],companions:[{id:'c'}],channels:[{id:'mx',enabled:true,companionId:'c'}],pairings:[{id:'p',channelId:'mx',userId:'u',status:'approved'}]}
  let runs=0
  const manager=new ChannelManager({}, {snapshot:()=>state,update:async fn=>fn(state)}, {}, {reply:async()=>{runs++;return {text:'done',attachments:[]}}},'/tmp')
  const api={sendText:async()=>{throw Error('timeout')}}
  const event={id:'event',sender:'u',text:'run'}
  await assert.rejects(manager.handleDirect(state.channels[0],api,event,new AbortController().signal))
  await manager.handleDirect(state.channels[0],api,event,new AbortController().signal)
  assert.equal(runs,1)
})
test('revoking authorization during a direct agent turn cancels its reply',async()=>{
  const state={recentReceipts:[],companions:[{id:'c'}],channels:[{id:'mx',enabled:true,companionId:'c'}],pairings:[{id:'p',channelId:'mx',userId:'u',status:'approved'}]}
  const manager=new ChannelManager({}, {snapshot:()=>state,update:async fn=>fn(state)}, {}, {reply:async()=>{state.pairings[0].status='blocked';return {text:'secret',attachments:[]}}},'/tmp')
  let sent=false
  await assert.rejects(manager.handleDirect(state.channels[0],{sendText:async()=>{sent=true}},{id:'event',sender:'u',text:'run'},new AbortController().signal),/撤销/)
  assert.equal(sent,false)
})
