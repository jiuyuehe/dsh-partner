import { useEffect, useState } from 'react'
import { loadPartner, type PartnerSnapshot } from '../client-api.js'
import { errorMessage } from './workspace-components.js'

export function ThoughtsPanel({companionId}:{companionId:string}):JSX.Element {
  const [open,setOpen]=useState(false),[snapshot,setSnapshot]=useState<PartnerSnapshot>(),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0)
  useEffect(()=>{
    if(!open)return
    let alive=true,running=false
    const refresh=async()=>{
      if(running||document.hidden)return
      running=true;setLoading(true)
      try{const data=await loadPartner();if(alive){setSnapshot(data);setError('')}}catch(e){if(alive)setError(errorMessage(e))}finally{running=false;if(alive)setLoading(false)}
    }
    void refresh();const timer=setInterval(()=>void refresh(),30000)
    return()=>{alive=false;clearInterval(timer)}
  },[companionId,open,revision])
  const plan=snapshot?.companions.find(c=>c.id===companionId)?.activityPlan
  const thoughts=[...(snapshot?.companions.find(c=>c.id===companionId)?.thoughts??[])].sort((a,b)=>b.updatedAt-a.updatedAt)
  const label=(id:string)=>{
    const route=snapshot?.sessions.find(r=>r.id===id)
    if(!route)return '原会话已移除'
    if(route.kind==='local')return '网页主会话'
    const group=route.userId.match(/^group:(\d+):/)
    return group?`群 ${group[1]}`:`${snapshot?.channels.find(c=>c.id===route.channelId)?.name??'渠道'} · ${snapshot?.pairings.find(p=>p.channelId===route.channelId&&p.userId===route.userId)?.displayName??route.userId}`
  }
  return <details className="dsh-partner-memory-record" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>最近在想什么 <small>{snapshot?`${thoughts.filter(t=>t.status==='open').length} 个还惦记着的念头`:'见闻、想法与后续'}</small></summary>
    <div className="dsh-partner-character-fields">
      <p className="dsh-partner-character-hint">从真实互动或自主活动中形成，由伙伴决定继续、换个会话聊，或放下。念头不是已发生的事实。</p>
      {plan&&<p className="dsh-partner-character-hint" style={{overflowWrap:'anywhere'}}>下一步：{plan.intention}<br/>{label(plan.targetRouteId)} · {{waiting:'等待本轮完成',pending:'等待唤起',claimed:'已唤起',cancelled:'已取消'}[plan.status]}{plan.status==='pending'?` · ${new Date(plan.dueAt).toLocaleString()}`:''}</p>}
      {error&&<p role="alert" className="dsh-partner-inline-error">{error}</p>}
      {!snapshot&&loading&&<p role="status">正在读取…</p>}
      {snapshot&&!thoughts.length&&<p className="dsh-partner-character-hint">暂时没有留下念头，不要求每次互动都产生。</p>}
      {thoughts.map(t=><details key={t.id} className="dsh-partner-memory-record">
        <summary><span style={{whiteSpace:'normal',overflowWrap:'anywhere'}}>{t.text}</span><small>{t.status==='done'?'已完成（自主标记）':t.status==='dismissed'?'已放下':t.lastOutcome?{considered:'已考虑',silent:'暂时安静',delivered:'已发送',failed:'未确认送达'}[t.lastOutcome]:'还惦记着'}</small></summary>
        <div className="dsh-partner-character-fields"><p>{t.why}</p><small>来自：{t.sourceRouteIds.map(label).join('、')} · {new Date(t.sourceAt).toLocaleString()}</small><small>想去：{label(t.targetRouteId)}</small>{t.result&&<p>{t.result}</p>}<details><summary>来源依据</summary><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{t.evidence}</p></details></div>
      </details>)}
      <button type="button" disabled={loading} onClick={()=>setRevision(n=>n+1)}>{loading?'读取中…':'刷新念头'}</button>
    </div>
  </details>
}
