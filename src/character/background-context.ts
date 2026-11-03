import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export const HEARTBEAT_CONTEXT_SUMMARY='后台关注检查记录（已结束）'
const LEGACY_SUMMARY='伙伴正在进行低打扰心跳检查'
/** Only plugin-owned audit receipts; user quotes and other notices are never reclassified. */
function backgroundRecord(e:SessionEvent):boolean {
 return e.type==='user/message'&&e.data.source.kind==='plugin:@lemoncat7/dsh-partner'&&e.data.source.form==='notice'&&[LEGACY_SUMMARY,HEARTBEAT_CONTEXT_SUMMARY].includes(e.data.source.summary)
}
export function compactHeartbeatContext(raw:string,at:number):string {
 const lines=raw.split('\n')
 const recordedAt=raw.match(/^记录时间：([^。；]+)/m)?.[1]
 const time=recordedAt&&Number.isFinite(Date.parse(recordedAt))?recordedAt:new Date(at).toISOString()
 const fields=lines.filter(line=>/^(状态：|本轮挂念：|用时：|受阻事项：|检查结果：|记录同步：)/.test(line)).slice(0,8).map(line=>line.slice(0,220))
 return ['【系统后台记录 · 非用户发言】',`记录时间：${time}。这轮检查已经结束；下列状态描述当时结果，不代表现在仍在执行。`,...fields,'这不是对方贴来的内容，也不是新的请求。仅在当前话题相关时参考，不将记录改写为用户说过的话或当前行动；完整检查过程保留在活动记录中。'].join('\n')
}
/** Log-preserving, source-citing replacement of legacy audit text, never of user or system heads. */
export function normalizeBackgroundContext(session:Session):number {
 if(!session.surface?.nodes)return 0
 const visible=new Set(session.surface.nodes)
 const old=session.snapshotEvents().filter(e=>visible.has(e.seq)&&backgroundRecord(e))
 for(const e of old){
  if(e.type!=='user/message')continue
  const raw=e.data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
  session.append('user/message',createUserMessage({content:[{type:'text',text:compactHeartbeatContext(raw,e.time)}],source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'recall'}}),{surfaceOp:{op:'replace',startSeq:e.seq,endSeq:e.seq},sourceEventSeqs:[e.seq]})
 }
 return old.length
}
