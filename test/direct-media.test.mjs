import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectTransport } from '../lib/channels/direct/transport.js'
import { DirectMediaTransfer } from '../lib/channels/direct/media.js'
import { matrixMessage } from '../lib/channels/direct/message.js'
import { ChannelManager } from '../lib/channels/manager.js'
import { pollDiscovered } from '../lib/channels/direct/discovery.js'

const fileId = 'a'.repeat(26), peer = '@peer:local', room = '!room:local'
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])
const signal = () => AbortSignal.timeout(5000)
async function server(t, media = () => ({})) {
  const requests = []
  const http = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const call = { path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) }; requests.push(call)
    let value
    if (req.url.endsWith('/whoami')) value = { user_id: '@bot:local' }
    else if (req.url.endsWith('/state')) value = ['@bot:local', peer].map(id => ({ type: 'm.room.member', state_key: id, content: { membership: 'join' } }))
    else if (req.url.endsWith('/users/me')) value = { id: 'bot' }
    else if (req.url.includes('/members')) value = [{ user_id: 'bot' }, { user_id: 'peer' }]
    else if (req.url === '/api/v4/channels/dm') value = { type: 'D' }
    else value = await media(call)
    res.statusCode = value?.status ?? 200
    for (const [k,v] of Object.entries(value?.headers ?? {})) res.setHeader(k,v)
    if (value?.raw !== undefined) res.end(value.raw)
    else { res.setHeader('content-type','application/json'); res.end(JSON.stringify(value?.json ?? value)) }
  })
  await new Promise(r => http.listen(0,'127.0.0.1',r))
  t.after(() => new Promise(r => { http.close(r); http.closeAllConnections() }))
  return { url:`http://127.0.0.1:${http.address().port}`, requests }
}
async function file(t, data = png, name = '图片.png') {
  const root = await mkdtemp(join(tmpdir(),'partner-media-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  const path = join(root,name); await writeFile(path,data)
  return { path,name,mediaType:'image/png',kind:'image' }
}

test('Matrix media parsing retains captions, skips edits and foreign senders', () => {
  const event = { type:'m.room.message', event_id:'event', sender:peer, content:{msgtype:'m.image',body:'请分析图片',filename:'图.png',url:'mxc://local/image',info:{size:12}} }
  const parsed = matrixMessage(event,peer,room)
  assert.equal(parsed.text,'请分析图片'); assert.equal(parsed.media[0].source,'mxc://local/image'); assert.equal(parsed.targetId,room)
  assert.equal(matrixMessage(event,'other'),undefined)
  event.content['m.relates_to']={rel_type:'m.replace'}; assert.equal(matrixMessage(event,peer),undefined)
})

test('automatic Matrix discovery keeps media references without downloading before approval',async()=>{
  const event={type:'m.room.message',event_id:'event',sender:peer,content:{msgtype:'m.audio',body:'voice.ogg',url:'mxc://local/voice'}}
  const batch=await pollDiscovered('matrix','@bot:local','before',signal(),async()=>({next_batch:'next',rooms:{join:{[room]:{timeline:{events:[event]}}}}}),()=>({validate:async()=>({accountId:'@bot:local',peerId:peer})}))
  assert.equal(batch.messages[0].targetId,room)
  assert.equal(batch.messages[0].media[0].source,'mxc://local/voice')
})

test('Matrix authenticated media download uses homeserver, sniffs images and never fetches remote URLs', async t => {
  const s = await server(t,() => ({raw:png}))
  const api = new DirectTransport({platform:'matrix',baseUrl:s.url,targetId:room},'secret')
  const message = {id:'event',sender:peer,media:[{source:'mxc://other-server/image',name:'../../图.png',mediaType:'text/html'}]}
  const result = await api.receiveAttachments(message,signal(),()=>true)
  assert.equal(result[0].kind,'image'); assert.equal(result[0].mediaType,'image/png'); assert.ok(!result[0].name.includes('/'))
  assert.ok(s.requests.some(r=>r.path==='/_matrix/client/v1/media/download/other-server/image'))
  assert.ok(s.requests.every(r=>r.headers.authorization==='Bearer secret'))
  for(const source of ['http://127.0.0.1/private','file:///etc/passwd','mxc://local/../../secret']) await assert.rejects(api.receiveAttachments({...message,media:[{source}]},signal(),()=>true),/mxc/)
  await assert.rejects(api.receiveAttachments(message,signal(),()=>false),/撤销/)
  await assert.rejects(api.receiveAttachments({...message,sender:'other'},signal(),()=>true),/不匹配/)
  await assert.rejects(api.receiveAttachments({...message,media:[{source:'mxc://local/id',encrypted:true}]},signal(),()=>true),/加密/)
})

test('attachment counts, declared sizes, streamed sizes, redirects and abort are bounded', async t => {
  const s = await server(t,()=>({raw:Buffer.alloc(20)}))
  const transfer = new DirectMediaTransfer({platform:'matrix',baseUrl:s.url,targetId:room},'secret',async()=>{})
  await assert.rejects(transfer.receive('event',Array(9).fill({source:'mxc://local/id'}),signal()),/8/)
  await assert.rejects(transfer.receive('event',[{source:'mxc://local/id',size:64*1024*1024+1}],signal()),/64 MB/)
  // Exercise the same streamed reader with a small limit to avoid a 64 MB fixture.
  await assert.rejects(transfer.bytes('/large',signal(),10),/大小限制/)
  const redirect = await server(t,()=>({status:302,headers:{location:s.url+'/leak'}}))
  const other = new DirectMediaTransfer({platform:'matrix',baseUrl:redirect.url,targetId:room},'secret',async()=>{})
  await assert.rejects(other.receive('event',[{source:'mxc://local/id'}],signal()))
  assert.equal(s.requests.some(r=>r.path==='/leak'),false)
  await assert.rejects(transfer.receive('event',[{source:'mxc://local/id'}],AbortSignal.abort()))
})

test('Mattermost preserves attachment captions and checks file ownership before downloading', async t => {
  let wrong = false
  const s = await server(t,r => r.path.includes('/posts?') ? {order:['post'],posts:{post:{id:'post',user_id:'peer',message:'看附件',file_ids:[fileId],create_at:100}}} : r.path.endsWith('/info') ? {id:fileId,post_id:wrong?'other':'post',channel_id:'dm',name:'voice.ogg',mime_type:'audio/ogg',size:5} : {raw:Buffer.from('audio')})
  const api = new DirectTransport({platform:'mattermost',baseUrl:s.url,targetId:'dm'},'secret')
  const [message] = (await api.poll('1',signal())).messages
  assert.equal(message.text,'看附件'); assert.equal(message.media.length,1)
  const [attachment] = await api.receiveAttachments(message,signal(),()=>true)
  assert.equal(attachment.kind,'file'); assert.equal(attachment.mediaType,'audio/ogg')
  wrong=true; const before=s.requests.filter(r=>r.path===`/api/v4/files/${fileId}`).length
  await assert.rejects(api.receiveAttachments(message,signal(),()=>true),/不属于/)
  assert.equal(s.requests.filter(r=>r.path===`/api/v4/files/${fileId}`).length,before)
})

for(const [mediaType,msgtype] of [['image/png','m.image'],['audio/ogg','m.audio'],['video/mp4','m.video'],['application/pdf','m.file']]) test(`Matrix uploads then sends ${msgtype}`,async t=>{
  const s=await server(t,r=>r.path.includes('/upload')?{content_uri:'mxc://local/uploaded'}:{event_id:'sent'})
  const api=new DirectTransport({platform:'matrix',baseUrl:s.url,targetId:room},'secret')
  const f=await file(t,msgtype==='m.image'?png:Buffer.from('content'));f.mediaType=mediaType
  await api.sendAttachment(peer,f,undefined,signal())
  const sent=JSON.parse(s.requests.find(r=>r.path.includes('/send/')).body)
  assert.equal(sent.msgtype,msgtype);assert.equal(sent.url,'mxc://local/uploaded');assert.equal(sent.info.size,msgtype==='m.image'?png.length:7)
})

test('Mattermost multipart upload is followed by a file_ids post',async t=>{
  const s=await server(t,r=>r.path==='/api/v4/files'?{file_infos:[{id:fileId}]}:{id:'sent'})
  const api=new DirectTransport({platform:'mattermost',baseUrl:s.url,targetId:'dm'},'secret')
  await api.sendAttachment('peer',await file(t),undefined,signal())
  const upload=s.requests.find(r=>r.path==='/api/v4/files')
  assert.match(upload.headers['content-type'],/multipart\/form-data/)
  assert.ok(upload.body.includes(png))
  assert.deepEqual(JSON.parse(s.requests.find(r=>r.path==='/api/v4/posts').body).file_ids,[fileId])
})

test('revocation after upload prevents sending; symlinks and unacknowledged sends fail',async t=>{
  let allowed=true
  const s=await server(t,r=>{if(r.path.includes('/upload')){allowed=false;return {content_uri:'mxc://local/file'}}return {}})
  const api=new DirectTransport({platform:'matrix',baseUrl:s.url,targetId:room},'secret')
  const f=await file(t)
  await assert.rejects(api.sendAttachment(peer,f,undefined,signal(),()=>allowed),/撤销/)
  assert.equal(s.requests.some(r=>r.path.includes('/send/')),false)
  try {
    await symlink(f.path,f.path+'.link')
    await assert.rejects(api.sendAttachment(peer,{...f,path:f.path+'.link'},undefined,signal()))
  } catch (error) {
    // Windows 未授予符号链接权限时，仅跳过无法创建的链接样例，继续验证发送回执。
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error
  }
  const s2=await server(t,r=>r.path.includes('/upload')?{content_uri:'mxc://local/file'}:{})
  await assert.rejects(new DirectTransport({platform:'matrix',baseUrl:s2.url,targetId:room},'secret').sendAttachment(peer,f,undefined,signal()),/未确认/)
})

test('manager hands off attachment-only input, delivers output, and bad media does not execute agent',async()=>{
  const channel={id:'c',platform:'matrix',enabled:true,companionId:'p',accountId:'bot',direct:{targetId:room}}
  const state={channels:[channel],companions:[{id:'p'}],pairings:[{channelId:'c',userId:peer,status:'approved',directTargetId:room}],recentReceipts:[]}
  let received, sent=0, fail=false
  const output={path:'/unused',name:'file',mediaType:'text/plain',kind:'file'}
  const manager=new ChannelManager({}, {snapshot:()=>structuredClone(state),update:async fn=>fn(state)}, {},{reply:async(...args)=>{received=args[3];return {text:'完成',attachments:[output]}}},'/tmp')
  const api={receiveAttachments:async()=>{if(fail)throw Error('bad media');return [{name:'image.png',data:png,kind:'image'}]},sendText:async()=>{},sendAttachment:async(_peer,file)=>{assert.equal(file,output);sent++}}
  await manager.handleDirect(channel,api,{id:'event',sender:peer,text:'',media:[{source:'mxc://local/image'}]},signal())
  assert.equal(received.attachments.length,1);assert.equal(sent,1)
  fail=true;received=undefined
  await manager.handleDirect(channel,api,{id:'bad',sender:peer,text:'caption',media:[{source:'mxc://local/image'}]},signal())
  assert.equal(received,undefined)
  assert.ok(state.recentReceipts.includes('c:bad'))
  fail=false;state.pairings[0].status='pending'
  api.receiveAttachments=async()=>assert.fail('unapproved download')
  await manager.handleDirect(channel,api,{id:'unapproved',sender:peer,text:'',media:[{source:'mxc://local/image'}]},signal())
  assert.equal(received,undefined)
})
