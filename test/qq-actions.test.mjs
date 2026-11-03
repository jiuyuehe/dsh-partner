import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,symlink,rm,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {qqActionTools,validateQqParams,qqLocalMedia} from '../lib/channels/qq/actions.js'
import {QQ_ACTIONS,QQ_ACTION_MAP} from '../lib/channels/qq/action-catalog.js'
import {parseQqSettings,qqSettings} from '../lib/channels/qq/settings.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
const signal=()=>AbortSignal.timeout(10000)
function fixture(){
 const channel={id:'qq',platform:'qq',companionId:'c',accountId:'12345678',enabled:true,updatedAt:1,qq:qqSettings({autonomousActions:true,enabledActions:QQ_ACTIONS.map(a=>a.id),groupReplies:true,groupIds:['493531768']})}
 const state={companions:[{id:'c'}],channels:[channel],sessions:[{sessionId:'s',companionId:'c',cwd:'/tmp'}],pairings:[{channelId:'qq',userId:'834426963',status:'approved',directTargetId:'834426963'}]}
 const store={subscribe:()=>()=>{},snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)},requests=[]
 let response={tid:'new',token:'do-not-return',html:'<script>bad</script>'}
 const call=async(id,action,params,signal,guard)=>{guard();requests.push({id,action,params});return response}
 const tool=qqActionTools('c',store,call)[0],exec={signal:signal(),callId:'call',agent:{session:{id:'s'}}}
 return {state,store,channel,requests,tool,exec,setResponse:r=>{response=r},call:(operation,params={})=>tool.execute({action:'call',operation,params},exec)}
}
test('QQ capabilities default off and reject unknown operations/options',()=>{
 assert.equal(qqSettings().autonomousActions,false)
 assert.equal(qqSettings().qzoneVisibility,4)
 assert.throws(()=>parseQqSettings({...qqSettings(),enabledActions:['get_cookies']}))
 assert.throws(()=>parseQqSettings({...qqSettings(),qzoneVisibility:'4'}))
 assert.equal(new Set(QQ_ACTIONS.map(a=>a.id)).size,QQ_ACTIONS.length)
 for(const forbidden of ['get_cookies','get_credentials','send_packet','bot_exit'])assert.equal(QQ_ACTION_MAP.has(forbidden),false)
 assert.throws(()=>validateQqParams(QQ_ACTION_MAP.get('send_qzone_msg').schema,{content:'hello',evil:'x'}))
 assert.throws(()=>validateQqParams(QQ_ACTION_MAP.get('get_msg').schema,{message_id:0}))
 validateQqParams(QQ_ACTION_MAP.get('get_msg').schema,{message_id:-123})
 validateQqParams(QQ_ACTION_MAP.get('set_group_member_invite_policy').schema,{group_id:493531768,policy:'require_approval'})
})
test('Qzone default visibility, redacted results and persistent duplicate claim',async()=>{
 const f=fixture();const result=await f.call('send_qzone_msg',{content:'hello'})
 assert.equal(f.requests[0].params.ugc_right,4);assert.deepEqual(result.result,{tid:'new'})
 assert.equal(f.channel.qqActivity[0].status,'confirmed')
 assert.equal((await f.call('send_qzone_msg',{content:'hello'})).duplicate,true)
 const reopened=qqActionTools('c',f.store,()=>{throw Error('duplicate sent')})[0]
 assert.equal((await reopened.execute({action:'call',operation:'send_qzone_msg',params:{content:'hello'}},f.exec)).duplicate,true)
 assert.equal(f.requests.length,1)
})
test('owner, global capability, operation and target scopes are all required',async()=>{
 for(const mutate of [f=>{f.exec.agent.session.id='other'},f=>{f.channel.qq.autonomousActions=false},f=>{f.channel.enabled=false},f=>{f.channel.qq.enabledActions=[]},f=>{f.channel.companionId='other'}]){
  const f=fixture();mutate(f);await assert.rejects(f.call('send_qzone_msg',{content:'x'}));assert.equal(f.requests.length,0)
 }
 const f=fixture()
 await assert.rejects(f.call('send_group_ai_record',{group_id:99999999,character:'v',text:'hello'}),/范围/)
 await assert.rejects(f.call('send_like',{user_id:99999999}),/授权/)
 await f.call('send_like',{user_id:834426963});assert.equal(f.requests.length,1)
})
test('message IDs resolve target scope before reaction and reject group mismatch',async()=>{
 const f=fixture();f.setResponse({message_type:'group',group_id:99999999})
 await assert.rejects(f.call('set_msg_emoji_like',{message_id:-3,emoji_id:'14'}),/范围/)
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].action,'get_msg')
 f.setResponse({message_type:'group',group_id:493531768});f.requests.length=0
 await f.call('set_msg_emoji_like',{message_id:-3,emoji_id:'14'});assert.equal(f.requests[1].params.message_id,-3)
 const g=fixture();g.channel.qq.groupIds.push('99887766');g.setResponse({message_type:'group',group_id:99887766})
 await assert.rejects(g.call('set_group_todo',{group_id:493531768,message_id:-3}),/不属于/)
})
test('revocation during target resolution prevents external mutation',async()=>{
 const f=fixture(),tool=qqActionTools('c',f.store,async(id,action)=>{assert.equal(action,'get_msg');f.channel.qq.enabledActions=[];return {message_type:'group',group_id:493531768}})[0]
 await assert.rejects(tool.execute({action:'call',operation:'delete_msg',params:{message_id:-1}},f.exec),/关闭/)
 assert.equal(f.channel.qqActivity,undefined)
})
test('unacknowledged external mutation is recorded and not retried after tool recreation',async()=>{
 const f=fixture();let calls=0
 const tool=qqActionTools('c',f.store,async()=>{calls++;throw Error('network token=secret')})[0]
 await assert.rejects(tool.execute({action:'call',operation:'send_qzone_msg',params:{content:'x'}},f.exec),e=>!e.message.includes('secret')&&e.message.includes('勿自动'))
 assert.equal(f.channel.qqActivity[0].status,'unknown')
 await tool.execute({action:'call',operation:'send_qzone_msg',params:{content:'x'}},f.exec);assert.equal(calls,1)
})
test('media confines canonical and descriptor path; voice uses native record segment',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-capabilities-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 await writeFile(join(dir,'voice.mp3'),'ID3test');await mkdir(join(dir,'.partner'));await writeFile(join(dir,'.partner','secret'),'secret');await symlink('/etc/passwd',join(dir,'outside'));await symlink(join(dir,'.partner'),join(dir,'hidden'))
 for(const path of ['../etc/passwd','/etc/passwd','outside','hidden/secret','.partner/secret','base64://abc','http://a'])await assert.rejects(qqLocalMedia(dir,path,signal()))
 const f=fixture();f.state.sessions[0].cwd=dir
 await f.call('send_voice',{user_id:834426963,file:'voice.mp3'})
 assert.equal(f.requests[0].action,'send_private_msg');assert.equal(f.requests[0].params.message[0].type,'record');assert.match(f.requests[0].params.message[0].data.file,/^base64:\/\//)
 const g=fixture();await assert.rejects(g.call('send_voice',{user_id:834426963,group_id:493531768,file:'x'}),/只选择/)
})
test('group voice selects saved character and discovery does not send',async()=>{
 const f=fixture();f.channel.qq.voiceCharacter='voice-a'
 await f.tool.execute({action:'describe',operation:'send_group_ai_record'},f.exec);assert.equal(f.requests.length,0)
 await f.call('send_group_ai_record',{group_id:493531768,text:'hello'});assert.equal(f.requests[0].params.character,'voice-a')
})
test('background memory does not prevent a real group autonomy decision',async()=>{
 const f=fixture();f.state.recentReceipts=[];f.state.pairings=[{channelId:'qq',userId:'group:493531768:834426963',status:'approved'}]
 let judgments=0
 const manager=new ChannelManager({},f.store,{}, {isCompanionBusy:()=>true},'/tmp')
 manager.groupAutonomy={status:()=>undefined,replied(){},observe(){},shouldReply:async()=>{judgments++;return false},record:()=>{throw Error('busy should not suppress decision')}}
 f.state.companions=[{id:'c'}];manager.rememberReceipts=async()=>{}
 await manager.handleDirect(f.channel,{}, {id:'e',sender:'group:493531768:834426963',text:'hello',qqGroup:{groupId:'493531768',autonomous:true,mentioned:false}},signal())
 assert.equal(judgments,1)
})
test('busy diagnostics distinguish memory, setup, observation and actual sessions',()=>{
 const f=fixture();const runtime=new PartnerAgentRuntime({agents:{get:()=>({status:'running'})}},f.store,'/tmp',undefined,{isRunning:()=>true})
 runtime.observationJobs.set('c',1);runtime.agentSetupJobs.set('c',1)
 const rows=runtime.companionActivity('c');assert.deepEqual(rows.map(r=>r.kind),['memory','observation','setup','conversation']);assert.equal(rows[3].sessionId,'s')
})

test('AI discovers and edits enabled profile operations through the same entry',async()=>{
 const f=fixture()
 const listed=await f.tool.execute({action:'list',category:'profile'},f.exec)
 assert.ok(listed.channels[0].actions.some(a=>a.id==='set_qq_profile'))
 const described=await f.tool.execute({action:'describe',operation:'set_qq_profile'},f.exec)
 assert.ok(described.parameters.properties.nickname)
 await f.call('set_qq_profile',{nickname:'新的昵称',personal_note:'新的资料'})
 assert.equal(f.requests[0].action,'set_qq_profile');assert.equal(f.requests[0].params.nickname,'新的昵称')
 const g=fixture();g.channel.qq.enabledActions=g.channel.qq.enabledActions.filter(a=>a!=='set_qq_profile')
 await assert.rejects(g.call('set_qq_profile',{nickname:'不应修改'}));assert.equal(g.requests.length,0)
})


test('single QQ entry discovers categories before bounded operation lists and individual schemas',async()=>{
 const f=fixture(),tools=qqActionTools('c',f.store,async()=>{})
 assert.equal(tools.length,1)
 const initial=await f.tool.execute({action:'list'},f.exec)
 assert.equal(initial.channels[0].actions,undefined)
 assert.equal(initial.channels[0].categories.length,11)
 assert.doesNotMatch(JSON.stringify(initial),/set_qq_profile|parameters/)
 const detail=await f.tool.execute({action:'list',category:'profile'},f.exec)
 assert.ok(detail.channels[0].actions.some(a=>a.id==='set_qq_profile'))
 assert.equal(detail.channels[0].actions[0].schema,undefined)
 const search=await f.tool.execute({action:'list',query:'语音'},f.exec)
 assert.ok(search.channels[0].actions.length>0);assert.ok(search.channels[0].actions.length<=20)
 const page=await f.tool.execute({action:'list',query:'get',offset:20},f.exec)
 assert.ok(page.channels[0].actions.length<=20)
 assert.equal(f.requests.length,0)
})

test('QQ discovery and empty API acknowledgements satisfy DSH canonical JSON output contracts',async t=>{
 const {Context}=await import('@deepseek-ai/cordis'),{ToolRuntime}=await import('@deepseek-ai/dsh-tools'),{createScope}=await import('@deepseek-ai/dsh-scope')
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const f=fixture();f.channel.name='QQ';const agent={session:{id:'s',header:{}},options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 scope.ctx.tools.register(qqActionTools('c',f.store,async()=>undefined)[0])
 let n=0
 for(const args of [{action:'list'},{action:'list',category:'profile'},{action:'describe',operation:'send_qzone_msg'},{action:'describe',operation:'send_voice'},{action:'call',operation:'set_qq_profile',params:{nickname:'测试昵称'}}]){
  const result=await root.tools.execute({callId:'qq-'+(++n),name:'partner_qq',arguments:args,agent,signal:signal()})
  assert.equal(result.isError,false,JSON.stringify(result));if(args.action==='call')assert.equal(result.value.result,null)
 }
})

test('QQ sticker collection validates image, checks MD5 and refreshes after mutation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-stickers-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const data=Buffer.from('GIF89a\x01\x00\x01\x00');await writeFile(join(dir,'happy.gif'),data);await writeFile(join(dir,'bad.txt'),'not image')
 const f=fixture();f.state.sessions[0].cwd=dir;let existing=[],changed=0;const calls=[]
 const tool=qqActionTools('c',f.store,async(id,name,params,signal,guard)=>{guard();calls.push({name,params});return name==='fetch_custom_face_detail'?existing:{emoji_id:'new-sticker'}},()=>changed++)[0]
 const run=(file,callId)=>tool.execute({action:'call',operation:'add_custom_face',params:{file}},{...f.exec,callId})
 await assert.rejects(run('bad.txt','bad'),/只支持/);assert.equal(calls.length,0)
 const added=await run('happy.gif','add');assert.equal(added.result.emoji_id,'new-sticker');assert.equal(changed,1)
 const {qqCustomCatalog}=await import('../lib/channels/qq/catalog.js')
 assert.equal(added.stickerId,'qq-custom-'+qqCustomCatalog([{emoji_id:added.result.emoji_id}])[0].id);assert.match(added.next,/modify_custom_face/)
 assert.deepEqual(calls.map(c=>c.name),['fetch_custom_face_detail','add_custom_face']);assert.equal(calls[1].params.file,'base64://'+data.toString('base64'))
 existing=[{emoji_id:'new-sticker',md5:(await import('node:crypto')).createHash('md5').update(data).digest('hex')}]
 const duplicate=await run('happy.gif','another');assert.equal(duplicate.alreadyCollected,true);assert.equal(duplicate.stickerId,added.stickerId);assert.equal(changed,1);assert.equal(calls.filter(c=>c.name==='add_custom_face').length,1)
 await tool.execute({action:'call',operation:'modify_custom_face',params:{emoji_id:'new-sticker',desc:'开心 得意'}},{...f.exec,callId:'rename'});assert.equal(changed,2)
 f.channel.qq.enabledActions=[];await assert.rejects(run('happy.gif','revoked'),/关闭|当前会话可用/)
})
test('failed sticker mutation invalidates cache without retrying unknown result',async()=>{
 const f=fixture();let changed=0,calls=0
 const tool=qqActionTools('c',f.store,async()=>{calls++;throw Error('offline')},()=>changed++)[0]
 const args={action:'call',operation:'move_custom_face_to_front',params:{emoji_id:'known'}}
 await assert.rejects(tool.execute(args,f.exec),/勿自动/);assert.equal(changed,1)
 assert.equal((await tool.execute(args,f.exec)).duplicate,true);assert.equal(calls,1)
})

test('guest collection works without private capabilities but cannot access other channels or private APIs',async t=>{
 const f=fixture(),dir=await mkdtemp(join(tmpdir(),'qq-public-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 await writeFile(join(dir,'face.gif'),Buffer.from('GIF89a\x01\x00\x01\x00'))
 const route=f.state.sessions[0];Object.assign(route,{id:'route',kind:'channel',channelId:'qq',userId:'834426963',inboundMessageIds:['u'],cwd:dir})
 f.channel.qq.identityBinding={enabled:true,qqIds:['12345678']};f.channel.qq.autonomousActions=false
 f.exec.agent.session.snapshotEvents=()=>[{type:'user/message',data:{id:'u',source:{kind:'user'},content:[]}}]
 f.state.channels.push({...f.channel,id:'other',qq:{...f.channel.qq,autonomousActions:true}})
 const calls=[]
 const tool=qqActionTools('c',f.store,async(id,name,params,_signal,guard)=>{guard();calls.push({id,name,params});return name==='fetch_custom_face_detail'?[]:{emoji_id:'new-public'}})[0]
 const invoke=args=>tool.execute(args,{...f.exec,callId:JSON.stringify(args)})
 const listed=await invoke({action:'list',category:'stickers'})
 assert.equal(listed.channels.length,1);assert.equal(listed.channels[0].id,'qq')
 assert.deepEqual(listed.channels[0].actions.map(a=>a.id).sort(),['fetch_custom_face_detail','add_custom_face','modify_custom_face','move_custom_face_to_front','delete_custom_face'].sort())
 const add=await invoke({action:'call',operation:'add_custom_face',params:{file:'face.gif'}})
 assert.match(add.stickerId,/^qq-custom-/)
 await invoke({action:'call',operation:'modify_custom_face',params:{emoji_id:'new-public',desc:'开心'}})
 await invoke({action:'call',operation:'delete_custom_face',params:{emoji_id:'new-public'}})
 assert.equal(calls.at(-1).name,'delete_custom_face')
 const count=calls.length
 for(const args of [
  {action:'call',operation:'send_qzone_msg',params:{content:'no'}},
  {action:'describe',operation:'set_qq_profile'},
  {action:'call',channelId:'other',operation:'fetch_custom_face_detail'},
 ])await assert.rejects(invoke(args))
 assert.equal(calls.length,count)
 f.channel.qq.enabledActions=[];await assert.rejects(invoke({action:'call',operation:'fetch_custom_face_detail'}))
 f.channel.qq.enabledActions=['fetch_custom_face_detail'];f.state.pairings[0].status='blocked'
 await assert.rejects(invoke({action:'call',operation:'fetch_custom_face_detail'}));assert.equal(calls.length,count)
})

function publicConversation(group=true){
 const f=fixture(),route=f.state.sessions[0]
 Object.assign(route,{id:'current',kind:'channel',channelId:'qq',userId:group?'group:493531768:834426963':'834426963',inboundMessageIds:['u']})
 f.channel.qq.identityBinding={enabled:true,qqIds:['12345678']};f.channel.qq.autonomousActions=false
 f.channel.qq.groupIds.push('99887766');f.channel.qq.autonomousGroupIds=['493531768','99887766']
 f.exec.agent.session.snapshotEvents=()=>[{type:'user/message',data:{id:'u',source:{kind:'user'},content:[]}}]
 return f
}
test('public group queries work without private switch and cannot read another allowed group',async()=>{
 const f=publicConversation()
 const listed=await f.tool.execute({action:'list',category:'groups'},f.exec)
 assert.deepEqual(listed.channels[0].actions.map(a=>a.id).sort(),['get_group_info','get_group_member_info','get_group_member_list'].sort())
 const described=await f.tool.execute({action:'describe',operation:'get_group_member_list'},f.exec)
 assert.deepEqual(described.targets.groups,['493531768']);assert.deepEqual(described.targets.privatePeers,[])
 await f.call('get_group_member_list',{group_id:493531768});assert.equal(f.requests.length,1)
 await assert.rejects(f.call('get_group_member_list',{group_id:99887766}),/仅限当前会话/);assert.equal(f.requests.length,1)
 await assert.rejects(f.call('set_group_card',{group_id:493531768,user_id:834426963,card:'x'}));assert.equal(f.requests.length,1)
 f.channel.qq.enabledActions=[];await assert.rejects(f.call('get_group_info',{group_id:493531768}));assert.equal(f.requests.length,1)
})
test('public reactions resolve real message peer and deny another group even when both groups are allowed',async()=>{
 const f=publicConversation();f.setResponse({message_type:'group',group_id:99887766})
 await assert.rejects(f.call('set_msg_emoji_like',{message_id:1,emoji_id:'14'}),/仅限当前会话/)
 assert.deepEqual(f.requests.map(r=>r.action),['get_msg']);assert.equal(f.channel.qqActivity,undefined)
 f.requests.length=0;f.setResponse({message_type:'group',group_id:493531768})
 await f.call('set_msg_emoji_like',{message_id:1,emoji_id:'14'})
 assert.deepEqual(f.requests.map(r=>r.action),['get_msg','set_msg_emoji_like'])
 await f.call('set_msg_emoji_like',{message_id:1,emoji_id:'14'});assert.equal(f.requests.filter(r=>r.action==='set_msg_emoji_like').length,1)
})
test('public private-chat reactions cannot cross peers or obtain group query targets',async()=>{
 const f=publicConversation(false);f.state.pairings.push({channelId:'qq',userId:'99887766',status:'approved'})
 f.setResponse({message_type:'private',sender:{user_id:'99887766'}})
 await assert.rejects(f.call('get_msg_emoji_likes',{message_id:1}),/仅限当前会话/)
 f.setResponse({message_type:'private',sender:{user_id:'12345678'},target_id:'834426963'})
 await f.call('get_msg_emoji_likes',{message_id:1})
 await assert.rejects(f.tool.execute({action:'describe',operation:'get_group_info'},f.exec))
})
test('public reaction revocation during message lookup prevents external write',async()=>{
 const f=publicConversation(),calls=[]
 const tool=qqActionTools('c',f.store,async(_id,name)=>{calls.push(name);f.channel.qq.enabledActions=[];return {message_type:'group',group_id:493531768}})[0]
 await assert.rejects(tool.execute({action:'call',operation:'set_msg_emoji_like',params:{message_id:1,emoji_id:'14'}},f.exec))
 assert.deepEqual(calls,['get_msg']);assert.equal(f.channel.qqActivity,undefined)
})

test('group poke defaults to the actual source group and never requires private approval of its member',async()=>{
 const f=fixture(),route={id:'r',sessionId:'s',companionId:'c',kind:'channel',channelId:'qq',userId:'group:493531768:834426963',inboundMessageIds:['u']}
 f.state.sessions=[route]
 f.channel.qq.identityBinding={enabled:true,qqIds:['834426963']}
 f.exec.agent.session.snapshotEvents=()=>[{type:'user/message',data:{id:'u',source:{kind:'user'}}}]
 await f.call('send_poke',{user_id:33445566})
 assert.deepEqual(f.requests[0].params,{group_id:493531768,user_id:33445566})
 const p=fixture();await assert.rejects(p.call('send_poke',{user_id:33445566}),/私聊对象尚未授权/)
})
