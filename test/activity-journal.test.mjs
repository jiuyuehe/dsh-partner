import test from 'node:test'
import assert from 'node:assert/strict'
import {collectActivityJournal,mergeActivityJournal,activityJournalRecall,renderActivityJournal} from '../lib/character/activity-journal.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
const events=()=>[
 {type:'turn/start',seq:1,data:{turn:1}},
 {type:'user/message',seq:2,data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}},
 {type:'tool/call',seq:3,data:{callId:'w',name:'write',arguments:JSON.stringify({file_path:'activities/puzzle.md',content:'PRIVATE CONTENT'})}},
 {type:'tool/result',seq:4,data:{message:{toolCallId:'w',isError:false}}},
 {type:'tool/call',seq:5,data:{callId:'b',name:'bash',arguments:'{"command":"secret"}'}},
 {type:'tool/result',seq:6,data:{message:{toolCallId:'b',isError:true}}},
 {type:'tool/ptc-dispatch',seq:7,data:{name:'partner_activity_finish',arguments:'{}',isError:false,meta:{kind:'partner-activity-silent-v1',reason:'做了一道搭桥题，留着以后玩'}}},
 {type:'turn/end',seq:8,time:1234,data:{turn:1,reason:{kind:'completed'}}},
]
test('silent activities retain evidence and artifacts without archiving tool contents or reasoning',()=>{
 const rows=collectActivityJournal('s',events());assert.equal(rows.length,1)
 assert.equal(rows[0].silent,true);assert.deepEqual(rows[0].artifacts,['activities/puzzle.md'])
 assert.deepEqual(rows[0].tools,[{name:'write',ok:true},{name:'bash',ok:false}])
 assert.ok(!JSON.stringify(rows).includes('PRIVATE CONTENT'));assert.ok(!JSON.stringify(rows).includes('secret'))
 assert.match(renderActivityJournal(rows),/安静结束不代表没做过/)
})
test('journal excludes user turns, failed turns and spoofed notices',()=>{
 for(const mutate of [e=>e.splice(2,0,{type:'user/message',data:{source:{kind:'user'}}}),e=>e.at(-1).data.reason.kind='failed',e=>e[1].data.source.kind='user']){
  const e=events();mutate(e);assert.deepEqual(collectActivityJournal('s',e),[])
 }
})
test('durable journal is bounded, deduplicated and restricted to an eligible source session',()=>{
 const c={};const rows=collectActivityJournal('s',events());assert.equal(mergeActivityJournal(c,rows),true);assert.equal(mergeActivityJournal(c,rows),false)
 assert.equal(activityJournalRecall(c,'s',true).length,1);assert.deepEqual(activityJournalRecall(c,'s',false),[]);assert.deepEqual(activityJournalRecall(c,'other',true),[])
 for(let i=0;i<50;i++)mergeActivityJournal(c,[{...rows[0],id:String(i),at:2000+i}])
 assert.equal(c.activityJournal.length,40)
})
test('journal repairs recent missing records from completed raw session events without inventing events',()=>{
 const c={};assert.equal(activityJournalRecall(c,'s',true,events()).length,1);assert.equal(c.activityJournal,undefined)
})

test('activity journal survives durable storage without changing identity revision',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {PartnerStore}=await import('../lib/store.js')
 const root=await mkdtemp(join(tmpdir(),'activity-journal-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const file=join(root,'state.json'),store=await PartnerStore.open(file)
 const before=store.snapshot().companions[0].updatedAt
 await store.update(s=>mergeActivityJournal(s.companions[0],collectActivityJournal('s',events())))
 const reopened=await PartnerStore.open(file),c=reopened.snapshot().companions[0]
 assert.equal(c.updatedAt,before);assert.equal(c.activityJournal[0].summary,'做了一道搭桥题，留着以后玩')
})
