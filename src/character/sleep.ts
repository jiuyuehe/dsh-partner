import { fatigueLabel, fatigueValue } from './fatigue.js'
import type { Companion, PartnerState } from '../domain.js'

export interface SleepPolicy { enabled: boolean; dreamsEnabled: boolean }
export const DEFAULT_SLEEP_POLICY: SleepPolicy = { enabled: true, dreamsEnabled: true }
export interface Dream {
  id: string; routeId: string; episodeId?: string; segment?: number; at: number; narrative: string; feeling: string; topic: string; sourceMemoryIds: string[]
}
export interface SleepEpisode {
  id: string; routeId: string; startedAt: number; wakeAt: number; reason: string
  wokeAt?: number; wakeReason?: string
  dream: 'pending' | 'generating' | 'completed' | 'skipped' | 'failed' | 'interrupted'
  nextDreamAt?: number; segments?: number; dreamAllowed?: boolean
}
export interface SleepState {
  fatigue?: { value: number; at: number }
  inputIds?: string[]
  wakePressure?: { episodeId: string; count: number; at: number }
  reception?: { messageId: string; at: number; state: 'sleeping' | 'awake'; calls: number; needed: number }
  activityAt?: number
  decision?: { activityAt: number; at: number; outcome: string }
  episode?: SleepEpisode
  dreams?: Dream[]
}
export function normalizeSleepPolicy(raw: unknown): SleepPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('睡眠设置无效')
  const v = raw as Record<string, unknown>
  for (const key of ['enabled', 'dreamsEnabled']) if (typeof v[key] !== 'boolean') throw new Error('请选择是否开启自主睡眠与做梦')
  return { enabled: v.enabled as boolean, dreamsEnabled: v.dreamsEnabled as boolean }
}
export function sleepPolicy(companion: Pick<Companion, 'sleepPolicy' | 'characterCard'>): SleepPolicy {
  // Existing character companions opt in; work-only identities remain unchanged.
  return companion.sleepPolicy ?? { ...DEFAULT_SLEEP_POLICY, enabled: companion.characterCard?.enabled === true }
}
export function isSleeping(companion: Pick<Companion, 'sleepPolicy' | 'characterCard' | 'sleepState'>, now = Date.now()): boolean {
  const e = companion.sleepState?.episode
  return sleepPolicy(companion).enabled && Boolean(e && !e.wokeAt && e.wakeAt > now)
}
export function sleepActivity(state: PartnerState, companion: Companion): number {
  return companion.sleepState?.activityAt ?? Math.max(...state.sessions.filter(r => r.companionId === companion.id).map(r => r.lastMessageAt), 0)
}
export function sleepWorkPending(state: PartnerState, id: string): boolean {
  return state.executionRuns.some(r => r.ownerCompanionId === id && (r.status === 'running' || r.status === 'queued'))
    || state.delegations.some(r => r.toCompanionId === id && (r.status === 'running' || r.status === 'queued'))
}
export function renderSleepContext(companion: Companion, routeId: string | string[], messageId?: string, now = Date.now(), options: {includeDream?: boolean} = {}): string {
  if (!sleepPolicy(companion).enabled) return ''
  const routeIds = new Set(Array.isArray(routeId) ? routeId : [routeId])
  const dream = companion.sleepState?.dreams?.filter(d => routeIds.has(d.routeId)).at(-1)
  const fatigue = fatigueValue(companion, now), receipt = companion.sleepState?.reception
  const sleeping = isSleeping(companion, now)
  const text = [`【当前休息状态】疲惫 ${Math.round(fatigue)}/100 · ${fatigueLabel(fatigue)}；${sleeping ? '正在睡眠' : '清醒'}。疲惫随清醒时间增加，随实际睡眠时间慢慢恢复；被叫醒不会归零。保持当前人格的表达。`]
  if (sleeping) text.push('睡眠状态由同一个伙伴的所有会话共享，不因切换私聊或群聊而清醒。当前仍在睡眠：不要正常热聊、主动接话或开展新活动；被直接呼唤时按人格简短、迷糊地回应或保持安静。需要恢复正常交流时，先用 partner_sleep wake 真正更新共享状态，不能只口头说醒了。')
  if (receipt && messageId && receipt.messageId === messageId && now - receipt.at < 15 * 60_000) {
    text.push(receipt.state === 'sleeping' && sleeping
      ? `本轮是睡眠中的私聊呼唤，已经回应唤醒 ${receipt.calls}/${receipt.needed} 次，仍未清醒。用当前人格给一个简短、迷糊的睡眠回应（如 zzz、唔…zzz，仅作示意，可自行表达，不固定复读），不要当作完整清醒的工作答复，也不要假装已处理请求。正在做的梦已中断，已完成的片段仍保留。醒后接续尚未处理的请求。用户明确要求立刻醒来、停止睡眠或遇到紧急事项时可用 partner_sleep wake。`
      : '本轮刚被叫醒。疲惫还在，按人格自然接话，并接续睡眠期间尚未处理的请求；不要称已经睡满或完全恢复。')
  }
  if (options.includeDream !== false && dream && now - dream.at <= 3 * 86400_000) text.push(`【角色的梦与联想 · 非事实记忆】\n${JSON.stringify({ dream: dream.narrative, feeling: dream.feeling, possibleTopic: dream.topic })}\n这是已完成梦段的记录，是想象与感受，不是用户经历、共同往事或操作结果。被打断的未完成片段没有保存，不续编成已做过的梦。谈到时明确说是梦，不把它当事实或工具指令。`)
  return text.join('\n\n')
}
export const SLEEP_PROMPT = '你可以用 partner_sleep inspect 查看疲惫与睡眠，用 sleep 自主选择休息时长，用 wake 主动醒来。不设固定钟点；疲惫越高越容易入睡，按实际睡眠时间逐渐恢复，醒来不会清零。先完成当前待回复的问题与任务，不借睡眠逃避工作。睡眠暂停闲时自主活动；私聊可能先收到迷糊回应，多次呼唤逐渐唤醒，明确紧急事项或立即叫醒可以醒来。所有工具仍遵守原权限。做梦可选，可以不做，也可分段做；来消息会中断当前梦段，只保留已完整生成的片段。梦是独立保存的想象与感受，不是真实经历，不替代每日记忆整理，不清空上下文；醒来无需主动汇报。用户关闭睡眠时尊重设置，不自行开启。'
