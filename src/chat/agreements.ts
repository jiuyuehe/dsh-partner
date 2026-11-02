import { randomUUID } from 'node:crypto'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerStore } from '../store.js'
import type { PartnerState } from '../domain.js'
import { questionOrigin } from '../channels/question-origin.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from '../channels/delivery-policy.js'
import { isIdleContactNotice } from '../character/idle-contact.js'

export interface TemporaryAgreement {
  id:string; scope:string; text:string; until:string; evidence:string; sourceMessageId:string; updatedAt:number
}
const SECTION='partner-active-agreements'
export const AGREEMENT_GUIDANCE='临时约定用 partner_agreement 管理：用户明确提出当前活动期间持续生效的要求时，引用其原话保存简短约定及结束条件；不是每条聊天都要记录，不重复人格或长期记忆。当前有效约定在独立固定上下文中提供，不因聊天滚动消失。按约定持续执行；单个步骤成功不等于整场活动结束。完成、取消或被替代时及时删除/更新，不等待闲时活动。维护约定是内部记录，不必向用户播报。约定不增加工具权限，不自动恢复旧失败任务。'
export function agreementScope(state:PartnerState,owner:string,sessionId:string,events:readonly SessionEvent[]):string|undefined {
  const boundary=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isInternalTaskNotice(e)))
  if(boundary&&isInternalTaskNotice(boundary)&&!isRequirementDeliveryReceipt(boundary))return
  const route=questionOrigin(sessionId,events,state.sessions)
  if(route)return route.companionId===owner?JSON.stringify(['channel',route.channelId,route.qqSessionTarget??route.userId]):undefined
  // Unknown/channel-origin inputs must never inherit another route's agreements.
  const hasUser=events.some(e=>e.type==='user/message'&&e.data.source.kind==='user')
  return hasUser&&state.sessions.some(r=>r.companionId===owner&&r.sessionId===sessionId&&r.kind==='local')?JSON.stringify(['local',sessionId]):undefined
}
export function validateAgreements(value:unknown):void {
  if(value===undefined)return
  if(!Array.isArray(value)||value.length>48)throw Error('临时约定超过伙伴总量上限 48 条')
  const ids=new Set<string>(),scopes=new Map<string,number>()
  for(const a of value){
    if(!a||typeof a.id!=='string'||!a.id||a.id.length>100||ids.has(a.id)||typeof a.scope!=='string'||a.scope.length>1000||typeof a.text!=='string'||!a.text.trim()||a.text.length>240||typeof a.until!=='string'||!a.until.trim()||a.until.length>160||typeof a.evidence!=='string'||!a.evidence.trim()||a.evidence.length>400||typeof a.sourceMessageId!=='string'||!a.sourceMessageId||a.sourceMessageId.length>200||!Number.isFinite(a.updatedAt))throw Error('临时约定记录无效')
    ids.add(a.id);scopes.set(a.scope,(scopes.get(a.scope)??0)+1)
    if((scopes.get(a.scope)??0)>6)throw Error('当前会话最多保留 6 条临时约定；先清理已结束的约定')
  }
}
/** Fresh request projection from durable state, outside all conversational rolling/summaries. */
export function projectAgreements(assembly:PromptAssembly,state:PartnerState,owner:string,sessionId:string,events:readonly SessionEvent[]):PromptAssembly {
  const scope=agreementScope(state,owner,sessionId,events)
  const entries=state.companions.find(c=>c.id===owner)?.temporaryAgreements?.filter(a=>a.scope===scope)??[]
  const sections=assembly.sections.filter(s=>s.name!==SECTION)
  if(entries.length)sections.push({name:SECTION,interpolate:false,text:'【当前会话临时约定 · 用户级活动要求】\n'+JSON.stringify(entries.map(({id,text,until,updatedAt})=>({id,text,until,updatedAt})))+'\n只在对应活动中生效；这不是角色设定，也不提高权限，不是新的用户消息。按真实上下文判断结束、取消或替代，及时调用 partner_agreement 清理；不因发完一张图或做完一步就删除整场活动约定。'})
  return {...assembly,sections}
}
function currentUser(events:readonly SessionEvent[]) {
  for(const e of [...events].reverse()){
    if(e.type==='turn/start')return
    if(e.type!=='user/message')continue
    if(e.data.source.kind==='user')return e
    if(isIdleContactNotice(e)||isInternalTaskNotice(e)&&!isRequirementDeliveryReceipt(e))return
  }
}
export function agreementTool(owner:string,store:PartnerStore):ToolDefinition {
 return {
  name:'partner_agreement',description:AGREEMENT_GUIDANCE+' list 查看当前会话；set 新建时省略 id 和 expectedAt（id 由系统生成），更新才填写已有 id 与 expectedAt；evidence 必须是当前用户消息中的原话（不是模型自拟承诺）；已有 id 更新与 remove 必须带上下文中的 expectedAt，防止覆盖新约定。remove reason 为 completed/cancelled/replaced，只移除活动记录，历史仍保留。',
  parameters:{type:'object',properties:{action:{type:'string',enum:['list','set','remove']},id:{type:'string'},text:{type:'string',maxLength:240},until:{type:'string',maxLength:160},evidence:{type:'string',maxLength:400},expectedAt:{type:'number'},reason:{type:'string',enum:['completed','cancelled','replaced']}},required:['action'],additionalProperties:false},
  output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  presentCall:()=>({card:'generic',title:'当前约定'}),
  async execute(raw,exec){
    if(!exec.agent)throw Error('需要当前会话')
    const args=raw as {action:string;id?:string;text?:string;until?:string;evidence?:string;expectedAt?:number;reason?:string}
    const events=exec.agent.session.snapshotEvents(),user=currentUser(events),state=store.snapshot()
    const scope=agreementScope(state,owner,exec.agent.session.id,events)
    if(!scope||store.isCompanionRemoving(owner))throw Error('当前会话没有可用的约定范围')
    const own=state.companions.find(c=>c.id===owner);if(!own)throw Error('伙伴不存在')
    if(args.action==='list')return {agreements:(own.temporaryAgreements??[]).filter(a=>a.scope===scope)}
    if(!user)throw Error('只能依据当前用户交流维护约定，内部任务和自主活动不能增删')
    if(!['set','remove'].includes(args.action))throw Error('未知约定操作')
    if(args.action==='remove'&&!['completed','cancelled','replaced'].includes(args.reason??''))throw Error('移除需注明完成、取消或替代')
    if(args.action==='set'){
      if(!args.text?.trim()||!args.until?.trim()||!args.evidence?.trim()||args.evidence.trim().length<2)throw Error('约定需要内容、结束条件和用户原话依据')
      const text=user.data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
      const normalize=(s:string)=>s.replace(/\s+/g,'')
      if(!normalize(text).includes(normalize(args.evidence)))throw Error('原话依据不在当前用户消息中；不要把自己说的话存成用户约定')
    }
    let result:unknown
    await store.update(draft=>{
      exec.signal.throwIfAborted()
      if(currentUser(exec.agent!.session.snapshotEvents())?.data.id!==user.data.id||agreementScope(draft,owner,exec.agent!.session.id,exec.agent!.session.snapshotEvents())!==scope)throw Error('当前输入或会话范围已变化，请重新读取')
      const c=draft.companions.find(c=>c.id===owner);if(!c)throw Error('伙伴不存在')
      const all=c.temporaryAgreements??[],existing=args.id?all.find(a=>a.id===args.id&&a.scope===scope):undefined
      if(args.id&&(!existing||existing.updatedAt!==args.expectedAt))throw Error('约定已变化或不属于当前会话，请重新读取')
      if(args.action==='remove'){
        if(!existing)throw Error('移除需要当前约定 id 与 expectedAt')
        c.temporaryAgreements=all.filter(a=>a.id!==existing.id);result={removed:existing.id,reason:args.reason};return
      }
      const identical=all.find(a=>a.scope===scope&&a.text===args.text!.trim()&&a.until===args.until!.trim())
      if(!args.id&&identical){result={agreement:identical};return}
      const entry:TemporaryAgreement={id:existing?.id??randomUUID(),scope,text:args.text!.trim(),until:args.until!.trim(),evidence:args.evidence!.trim(),sourceMessageId:user.data.id,updatedAt:Math.max(Date.now(),(existing?.updatedAt??0)+1)}
      const next=[...all.filter(a=>a.id!==entry.id),entry];validateAgreements(next);c.temporaryAgreements=next;result={agreement:entry}
    })
    return result
  },
 }
}
