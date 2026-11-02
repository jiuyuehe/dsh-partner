import { useEffect, useState } from 'react'
import { api, type CompanionView } from '../client-api.js'
import { affectionEnabled, affectionProgress } from '../character/affection.js'
import { fatigueLabel, fatigueValue } from '../character/fatigue.js'
import { isSleeping, sleepPolicy, type SleepState } from '../character/sleep.js'

/** Mounted only on overview; runtime meters are independent of identity form drafts. */
export function CompanionVitals({ companion }: { companion: CompanionView }): JSX.Element {
  const [affection, setAffection] = useState(() => affectionProgress(companion.affection))
  const [sleep, setSleep] = useState<{state: SleepState; serverNow: number}>(() => ({state: companion.sleepState ?? {}, serverNow: Date.now()}))
  const [stale, setStale] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true, running = false
    const refresh = async () => {
      if (running || document.hidden) return
      running = true
      const results = await Promise.allSettled([
        api<ReturnType<typeof affectionProgress>>(`/companions/${encodeURIComponent(companion.id)}/character/affection`),
        api<{state: SleepState; serverNow: number}>(`/companions/${encodeURIComponent(companion.id)}/sleep`),
      ])
      if (alive) {
        if (results[0].status === 'fulfilled') setAffection(results[0].value)
        if (results[1].status === 'fulfilled') setSleep(results[1].value)
        setStale(results.some(r => r.status === 'rejected'))
      }
      running = false
    }
    void refresh(); const timer = setInterval(() => void refresh(), 15000)
    const visible = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [companion.id, retry])
  const current = {...companion, sleepState:sleep.state}, fatigue = Math.round(fatigueValue(current, sleep.serverNow)), enabled = sleepPolicy(companion).enabled
  const sleeping = isSleeping(current, sleep.serverNow)
  const state = !enabled ? '已暂停' : sleeping ? '睡眠中' : '清醒'
  return <section className="dsh-partner-vitals" aria-label="伙伴状态">
    <div className="dsh-partner-vital"><div className="dsh-partner-vital-heading"><span>好感度</span><small>{affectionEnabled(companion) ? `阶段 ${affection.level}/${affection.totalLevels} · ${affection.name}` : '已暂停'}</small></div><strong>{affection.score}<small> / −100～100</small></strong><div className="dsh-partner-affection-track" role="meter" aria-label={`${companion.name}的好感度`} aria-valuemin={-100} aria-valuemax={100} aria-valuenow={affection.score} aria-valuetext={`${affection.score}，${affection.name}`}><span data-negative={affection.score<0} style={{left:`${affection.score<0?50+affection.score/2:50}%`,width:`${Math.abs(affection.score)/2}%`}}/><i aria-hidden="true"/></div></div>
    <div className="dsh-partner-vital"><div className="dsh-partner-vital-heading"><span>疲惫值</span><small>{state}{enabled ? ` · ${fatigueLabel(fatigue)}` : ''}</small></div><strong>{fatigue}<small> / 100</small></strong><div className="dsh-partner-vital-track" role="meter" aria-label={`${companion.name}的疲惫值`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={fatigue} aria-valuetext={`${fatigue} / 100，${state}`}><i style={{transform:`scaleX(${fatigue / 100})`}} /></div></div>
    {stale && <p className="dsh-partner-vitals-error" role="status">部分状态刷新失败，保留上次读数。<button type="button" onClick={() => setRetry(n=>n+1)}>重试</button></p>}
  </section>
}
