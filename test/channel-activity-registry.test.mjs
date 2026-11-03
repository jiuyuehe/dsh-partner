import test from 'node:test'
import assert from 'node:assert/strict'
import { ChannelActivityRegistry } from '../lib/channels/activity-registry.js'
import { createChannelActivities } from '../lib/channels/activity-defaults.js'
import { idleActivityPrompt } from '../lib/character/idle-contact.js'

const activity={id:'read',title:'浏览频道',tool:'matrix_tools',visibility:'public',description:'先查询可浏览频道，再决定是否读取。'}
const fixture=()=>({companions:[{id:'c'}],channels:[{id:'m',platform:'matrix',companionId:'c',enabled:true},{id:'q',platform:'qq',companionId:'c',enabled:true},{id:'foreign',platform:'matrix',companionId:'other',enabled:true},{id:'off',platform:'matrix',companionId:'c',enabled:false}],sessions:[],pairings:[]})

test('providers register per platform, refresh live, dispose safely and stay isolated between plugin instances',()=>{
 const r=new ChannelActivityRegistry(),s=fixture();let enabled=true,calls=0
 const dispose=r.register({id:'matrix.read',platform:'matrix',discover:({channel})=>{calls++;assert.equal(channel.id,'m');channel.name='mutated';return enabled?[activity]:[]}})
 const before=structuredClone(s)
 assert.deepEqual(r.describe(s,'c'),[{channelId:'m',platform:'matrix',provider:'matrix.read',activities:[activity]}])
 assert.deepEqual(s,before);assert.equal(calls,1)
 assert.deepEqual(new ChannelActivityRegistry().describe(s,'c'),[])
 enabled=false;assert.deepEqual(r.describe(s,'c'),[])
 enabled=true;s.channels[0].enabled=false;assert.deepEqual(r.describe(s,'c'),[])
 s.channels[0].enabled=true;dispose();assert.deepEqual(r.describe(s,'c'),[])
 const next=r.register({id:'matrix.read',platform:'matrix',discover:()=>[activity]});dispose();assert.equal(r.describe(s,'c').length,1);next()
})

test('bad provider does not suppress other channels; duplicate registration and invalid metadata are rejected',()=>{
 const errors=[],r=new ChannelActivityRegistry((id)=>errors.push(id)),s=fixture()
 r.register({id:'broken',platform:'qq',discover:()=>{throw Error('broken')}})
 r.register({id:'invalid',platform:'matrix',discover:()=>[{...activity,tool:'not a tool'}]})
 r.register({id:'good',platform:'matrix',discover:()=>[activity]})
 assert.throws(()=>r.register({id:'good',platform:'qq',discover:()=>[]}),/already registered/)
 assert.deepEqual(r.describe(s,'c').map(x=>x.provider),['good']);assert.deepEqual(errors.sort(),['broken','invalid'])
})

test('all existing channels inherit conversation discovery only for approved targets',()=>{
 const r=createChannelActivities(),s=fixture()
 s.channels=s.channels.filter(c=>c.id==='m')
 s.sessions=[{id:'route',kind:'channel',companionId:'c',channelId:'m',sessionId:'s',userId:'peer'}]
 assert.deepEqual(r.describe(s,'c'),[])
 s.pairings=[{channelId:'m',userId:'peer',status:'approved'}]
 assert.equal(r.describe(s,'c')[0].activities[0].tool,'partner_chat_reply')
 s.pairings[0].status='blocked';assert.deepEqual(r.describe(s,'c'),[])
})

test('QQ adapter filters private switches, keeps enabled public collection and reflects revocation',()=>{
 const r=createChannelActivities(),s=fixture(),q=s.channels.find(c=>c.id==='q')
 q.qq={autonomousActions:false,enabledActions:['send_qzone_msg','add_custom_face','unknown']}
 let list=r.describe(s,'c');assert.deepEqual(list.flatMap(x=>x.activities.flatMap(a=>a.operations??[])),['add_custom_face'])
 q.qq.autonomousActions=true;list=r.describe(s,'c')
 assert.equal(list[0].activities.find(a=>a.operations.includes('send_qzone_msg')).visibility,'private')
 q.qq.enabledActions=[];assert.deepEqual(r.describe(s,'c'),[])
})

test('registered non-QQ capabilities reach activity prompt without changing scheduler or wrapping external tools',()=>{
 const r=new ChannelActivityRegistry(),s=fixture(),c={id:'c'}
 const baseline=idleActivityPrompt(s,c,[],undefined,r)
 assert.ok(!baseline.includes('matrix_tools'))
 const dispose=r.register({id:'matrix.read',platform:'matrix',discover:()=>[activity]})
 const prompt=idleActivityPrompt(s,c,[],undefined,r)
 assert.match(prompt,/matrix_tools/);assert.match(prompt,/渠道活动目录/);assert.match(prompt,/实际执行仍由所属渠道和工具核验权限/)
 assert.doesNotMatch(prompt,/QQ 自主能力摘要/)
 dispose();assert.ok(!idleActivityPrompt(s,c,[],undefined,r).includes('matrix_tools'))
})

 test('disposing an old registration cannot remove a re-registered provider object',()=>{
 const r=new ChannelActivityRegistry(),provider={id:'same',platform:'matrix',discover:()=>[activity]}
 const old=r.register(provider);old();const current=r.register(provider);old()
 assert.equal(r.describe(fixture(),'c').length,1);current();assert.deepEqual(r.describe(fixture(),'c'),[])
})
