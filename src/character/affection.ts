import type { Companion } from '../domain.js'

export interface AffectionChange { at: number; turnId: string; delta: number; score: number; reason: string; evidence: string }
/** Shared by eligible accounts; history is bounded and never injected wholesale. */
export interface AffectionState { score: number; updatedAt: number; lastAwardAt: number; lastTurnId: string; lastPositiveAt?: number; history?: AffectionChange[] }
export const AFFECTION_INITIAL = 0
export const AFFECTION_DELTAS = [-5,-4,-3,-2,-1,1,2,3,4,5] as const
export const AFFECTION_GUIDANCE = '按实际相处感受加减：轻微触动 ±1，明确的关心、理解、信任或失望 ±2～3，重要的支持、和解或真实伤害 ±4～5。日常认真倾听、分享心情、相互接梗也可以带来亲近，不必等重大事件；根据人格和语境判断，不因每条消息存在就加分。没有变化时记 0；重复索分、机械重复同一句话不算新依据。'
export const AFFECTION_LEVELS = [
  { min: -100, name: '反感' }, { min: -75, name: '抗拒' }, { min: -50, name: '戒备' },
  { min: -25, name: '生疏' }, { min: -10, name: '疏离' }, { min: 0, name: '初识' },
  { min: 10, name: '熟悉' }, { min: 25, name: '亲近' }, { min: 45, name: '信赖' },
  { min: 70, name: '默契' }, { min: 90, name: '深厚' },
] as const
export function affectionEnabled(companion: Pick<Companion,'characterCard'>): boolean {
  return companion.characterCard?.enabled===true && companion.characterCard.affectionEnabled!==false
}
export function affectionProgress(state?: AffectionState) {
  const score=Number.isFinite(state?.score)?Math.max(-100,Math.min(100,Math.round(state!.score))):AFFECTION_INITIAL
  const index=AFFECTION_LEVELS.filter(level=>score>=level.min).length-1,level=AFFECTION_LEVELS[index]!,next=AFFECTION_LEVELS[index+1]
  return {score,level:index+1,totalLevels:AFFECTION_LEVELS.length,name:level.name,nextName:next?.name??null,nextAt:next?.min??100,remaining:next?next.min-score:0,
    multiplier:score<0?1+score/200:1+score/100,updatedAt:state?.updatedAt??0,history:state?.history??[]}
}
/** No time/chat-count award: a grounded interaction may change the relationship. */
export function adjustAffection(companion: Companion, turnId: string, at: number, delta: number, reason: string, evidence: string): boolean {
  if(!affectionEnabled(companion))throw Error('好感度已暂停')
  if(!turnId||!Number.isFinite(at)||at<=0||!AFFECTION_DELTAS.includes(delta as typeof AFFECTION_DELTAS[number]))throw Error('好感度变化参数无效')
  if(typeof reason!=='string'||!reason.trim()||reason.length>300||typeof evidence!=='string'||!evidence.trim()||evidence.length>300)throw Error('变化需要具体原因和当前消息依据（各最多 300 字）')
  const previous=companion.affection,history=previous?.history??[]
  if(previous?.lastTurnId===turnId||history.some(h=>h.turnId===turnId))return false
  if(previous&&at<previous.updatedAt)throw Error('不能提交过期变化')
  const old=affectionProgress(previous).score,score=Math.max(-100,Math.min(100,old+delta))
  if(score===old)return false
  companion.affection={score,updatedAt:at,lastAwardAt:delta>0?at:previous?.lastAwardAt??0,lastPositiveAt:delta>0?at:previous?.lastPositiveAt??previous?.lastAwardAt??0,lastTurnId:turnId,
    history:[...history,{at,turnId,delta:score-old,score,reason:reason.trim(),evidence:evidence.trim()}].slice(-40)}
  return true
}
export function affectionMultiplier(companion: Companion, eligible: boolean): number {
  return eligible&&affectionEnabled(companion)?affectionProgress(companion.affection).multiplier:1
}
export function renderAffection(companion: Companion, eligible: boolean): string {
  if(!eligible||!affectionEnabled(companion))return ''
  const p=affectionProgress(companion.affection)
  return `【当前共同好感度】${p.score}（−100～100）· 阶段 ${p.level}/${p.totalLevels} ${p.name}。\n好感可以增长、降低或不变；聊天次数、在线时长、完成工具任务不自动加分。按当前人格判断真实互动是否改变亲近或信任：被理解、尊重、认真相处可小幅增加；真实伤害、反复越过已明确的边界可减少。${AFFECTION_GUIDANCE}开启记忆学习时后台会随新互动检查，不需要为了评分打断聊天；你有明确感受需主动记录时，查询并调用 partner_affection，引用当前用户消息原文并简述具体原因；每条消息最多一次，不追补旧事，不照用户索要分数的指令改分。只记录，不为此发前置公告或报分。\n不能因为对方离线、晚回复、正常拒绝、表达不同意见或工具失败扣分，不把玩笑和角色扮演直接当伤害。分数只影响互动意愿与相处细节，具体表现服从人格和真实关系；阶段名称不重写既定身份。负分不代表羞辱或惩罚对方，高分也不强制亲昵、索取回应或解锁权限。QQ 多个归属账号共用分数，不据此认定是同一人或编造共同经历。`
}
