import { useEffect, useState } from 'react'
import { api, type CompanionView } from '../client-api.js'
import { affectionProgress } from '../character/affection.js'
import type { CharacterCard } from '../character/domain.js'
import { errorMessage } from './workspace-components.js'

export function AffectionPanel({companion,card,active,disabled,onChange}:{companion:CompanionView;card:CharacterCard;active:boolean;disabled:boolean;onChange(card:CharacterCard):void}):JSX.Element {
  const [progress,setProgress]=useState(()=>affectionProgress(companion.affection))
  const [error,setError]=useState<string>()
  const [revision,setRevision]=useState(0)
  const [loading,setLoading]=useState(false)
  useEffect(()=>{
    if(!active)return
    let alive=true,running=false
    const refresh=async()=>{
      if(running||document.hidden)return
      running=true;setLoading(true)
      try{const value=await api<ReturnType<typeof affectionProgress>>(`/companions/${encodeURIComponent(companion.id)}/character/affection`);if(alive){setProgress(value);setError(undefined)}}
      catch(e){if(alive)setError(errorMessage(e))}finally{running=false;if(alive)setLoading(false)}
    }
    void refresh();const timer=setInterval(()=>void refresh(),30000)
    return()=>{alive=false;clearInterval(timer)}
  },[companion.id,active,revision])
  const enabled=card.affectionEnabled!==false
  return <div className="dsh-partner-affection" aria-label="好感度">
    <div className="dsh-partner-affection-line"><span>好感度 <strong>{progress.score}</strong><small> / −100～100</small></span><span>阶段 {progress.level}/{progress.totalLevels} · {progress.name}</span><button type="button" role="switch" className="dsh-partner-switch" aria-label="启用好感度变化与主动加成" aria-checked={enabled} data-on={enabled} disabled={disabled} onClick={()=>onChange({...card,affectionEnabled:!enabled})}><i aria-hidden="true"/></button></div>
    <div className="dsh-partner-affection-track" role="meter" aria-label={`${companion.name}的好感度`} aria-valuemin={-100} aria-valuemax={100} aria-valuenow={progress.score} aria-valuetext={`${progress.score}，${progress.name}`}><span data-negative={progress.score<0} style={{left:`${progress.score<0?50+progress.score/2:50}%`,width:`${Math.abs(progress.score)/2}%`}}/><i aria-hidden="true"/></div>
    <div className="dsh-partner-affection-scale" aria-hidden="true"><span>−100</span><span>0</span><span>+100</span></div>
    <small className="dsh-partner-affection-caption">{!card.enabled||!enabled?'已暂停，进度保留':`随真实互动涨跌 · 主动概率 ×${progress.multiplier.toFixed(2)}`}</small>
    <p className="dsh-partner-affection-caption">普通聊天不自动加分。每次增加 1，至少间隔 4 小时；每次减少 1–3。滚动 24 小时最多增加 2、减少 6，每条消息只记一次。不会因离线自动扣分。旧版分数保留。</p>
    <details><summary>最近变化与原因</summary>{!progress.history.length?<p className="dsh-partner-affection-caption">新规则尚无变化记录。模型没有判断到明显变化时，好感度保持不变。</p>:<ol className="dsh-partner-affection-history">{[...progress.history].reverse().map(item=><li key={item.turnId}><span>{item.delta>0?'+':''}{item.delta} → {item.score} · {new Date(item.at).toLocaleString()}</span><p>{item.reason}</p><details><summary>互动依据</summary><p>{item.evidence}</p></details></li>)}</ol>}</details>
    {error&&<div className="dsh-partner-affection-error"><small role="alert">进度读取失败</small><button type="button" disabled={loading} onClick={()=>setRevision(n=>n+1)}>重试</button></div>}
  </div>
}
