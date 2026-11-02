import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerStore } from '../store.js'
import type { PartnerState } from '../domain.js'
import { record } from '../core/validation.js'
import { affectionTurnEligible } from './affection-context.js'
import { adjustAffection, affectionEnabled, affectionProgress, type AffectionState } from './affection.js'
function currentTurn(events:readonly SessionEvent[]) {
  let start=-1
  for(let i=events.length-1;i>=0;i--)if(events[i]!.type==='turn/start'){start=i;break}
  return events.slice(start+1)
}
function toolProgress(state?:AffectionState) {
  const {history,...progress}=affectionProgress(state)
  return {...progress,recentChanges:history.slice(-3).map(({at,delta,reason})=>({at,delta,reason:reason.slice(0,150)}))}
}
export function affectionTool(owner:string,store:PartnerStore):ToolDefinition {
  return {
    name:'partner_affection',description:'根据当前真实互动记录自己的好感变化，不自动报分或发送消息。普通聊天可不变。增加仅 +1；降低 -1 至 -3，原因须符合当前人格和事实，不能因离线、正常拒绝或工具失败扣分。每条用户消息只记一次，30 分钟内不重复变化，加分至少间隔 4 小时，滚动 24 小时最多 +2 / -6。inspect 查看当前进度；adjust 提交当前用户原文 evidence 与 reason。系统活动、陌生 QQ 账号不能改分。',
    parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['inspect','adjust']},delta:{type:'integer',enum:[-3,-2,-1,1]},reason:{type:'string',maxLength:300},evidence:{type:'string',maxLength:300}}},
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    presentCall:()=>({card:'generic',title:'记录相处感受'}),
    async execute(raw,exec){
      if(!exec.agent)throw Error('只能在伙伴聊天中使用')
      const input=record(raw),agent=exec.agent
      const origin=currentTurn(agent.session.snapshotEvents()).filter(e=>e.type==='user/message'&&e.data.source.kind==='user').at(-1)
      if(origin?.type!=='user/message')throw Error('当前没有可记录的用户互动')
      let result:unknown
      const evaluate=(state:PartnerState)=>{
        exec.signal.throwIfAborted()
        const companion=state.companions.find(c=>c.id===owner),events=currentTurn(agent.session.snapshotEvents())
        if(!companion||store.isCompanionRemoving(owner)||!affectionEnabled(companion))throw Error('好感度不可用或已暂停')
        if(!affectionTurnEligible(state,owner,agent.session.id,events))throw Error('当前会话不能修改此伙伴好感度')
        const latest=events.filter(e=>e.type==='user/message'&&e.data.source.kind==='user').at(-1)
        if(latest?.type!=='user/message'||latest.data.id!==origin.data.id)throw Error('用户消息已变化，请重新判断')
        if(input.action==='inspect'){result=toolProgress(companion.affection);return}
        if(input.action!=='adjust')throw Error('好感度 action 无效')
        const text=latest.data.content.flatMap(b=>b.type==='text'?[b.text]:[]).join('\n')
        if(typeof input.evidence!=='string'||!input.evidence.trim()||!text.includes(input.evidence.trim()))throw Error('依据必须是当前用户消息的原文，不能引用自己的话或编造互动')
        const applied=adjustAffection(companion,`${agent.session.id}:${latest.data.id}`,Date.now(),input.delta as number,input.reason as string,input.evidence)
        result={applied,...toolProgress(companion.affection),...(!applied?{note:'重复消息、频率/24小时预算限制或已到边界，本次保持不变；不要为加减分重试。'}:{})}
      }
      if(input.action==='inspect')evaluate(store.snapshot())
      else await store.update(evaluate)
      return result
    },
  }
}
