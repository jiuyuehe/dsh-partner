import { ThoughtsPanel } from './thoughts-panel.js'
import {channelReplyAllowed} from '../channels/reply-access.js'
import { useEffect, useState } from 'react'
import { loadPartner, type PartnerSnapshot } from '../client-api.js'
import { DEFAULT_IDLE_CONTACT, type IdleContactPolicy } from '../character/idle-contact.js'
import { FormField as Field } from './partner-components.js'
import { errorMessage } from './workspace-components.js'

export function IdleContactEditor({companionId,value,disabled,onChange}:{companionId:string;value:IdleContactPolicy|undefined;disabled:boolean;onChange(value:IdleContactPolicy):void}):JSX.Element {
  const policy=value??DEFAULT_IDLE_CONTACT
  const [snapshot,setSnapshot]=useState<PartnerSnapshot>(),[error,setError]=useState<string>()
  useEffect(()=>{let active=true;void loadPartner().then(s=>{if(active)setSnapshot(s)}).catch(e=>{if(active)setError(errorMessage(e))});return()=>{active=false}},[companionId])
  const routes=snapshot?.sessions.filter(r=>r.companionId===companionId&&!r.archived&&(r.kind==='local'||(snapshot.channels.some(c=>c.id===r.channelId&&c.enabled)&&channelReplyAllowed(snapshot,r.channelId,r.userId))))??[]
  const review=snapshot?.companions.find(c=>c.id===companionId)?.interactionReview?.persona
  const patch=(p:Partial<IdleContactPolicy>)=>onChange({...policy,...p})
  return <section className="dsh-partner-character" aria-label="闲时自主活动">
    <header><div><h3>闲时自主活动 <small>可选</small></h3><p>空闲时逐渐增加活动概率，让伙伴自己决定聊天、使用已授权能力，或安静待着。</p></div><div className="dsh-partner-character-toggle"><button type="button" role="switch" className="dsh-partner-switch" aria-label="开启闲时自主活动" aria-checked={policy.enabled} data-on={policy.enabled} disabled={disabled} onClick={()=>patch({enabled:!policy.enabled})}><i aria-hidden="true"/></button><span>{policy.enabled?'已开启':'已关闭'}</span></div></header>
    <p className="dsh-partner-character-hint">每分钟检查一次，抽中才唤起 AI 决定做什么；不是每分钟请求模型。正在聊天、执行任务或睡觉时等待。回复送达后有 10%–80% 概率获得自主活动机会，好感度影响初始概率；活动后继续机会逐轮减半，不设固定轮数上限，选择不行动时停止。新消息优先。QQ 回复后延续仅对归属账号生效。修改后保存身份生效。</p>
    {error&&<p role="alert" className="dsh-partner-inline-error">{error}</p>}
    <ThoughtsPanel companionId={companionId}/>
    {policy.enabled&&<fieldset disabled={disabled} className="dsh-partner-character-fields">
      <div className="dsh-partner-persona-option"><div><span id="persona-refinement-label">自主调整角色设定</span><small>{policy.selfRefinement?'已开启':'已关闭'}</small></div><button type="button" role="switch" className="dsh-partner-switch" aria-labelledby="persona-refinement-label" aria-describedby="persona-refinement-hint" aria-checked={policy.selfRefinement===true} data-on={policy.selfRefinement===true} disabled={disabled} onClick={()=>patch({selfRefinement:!policy.selfRefinement})}><i aria-hidden="true"/></button></div>
      <p id="persona-refinement-hint" className="dsh-partner-character-hint">默认关闭。开启后，闲时及回复后的自主活动可以决定是否调整自己的性格、兴趣与表达方式，不要求每轮修改。开启记忆学习时，后台也会结合新互动检查表达方式，两次检查至少间隔 6 小时；没有新互动不重复检查。不会修改你的身份、关系或能力权限。保留最近 12 次变更，可在下方查看并载入旧内容，保存身份后恢复。关闭后保留已形成的设定。</p>
      {policy.selfRefinement&&<p className="dsh-partner-character-hint">{review?`最近整理检查 ${new Date(review.at).toLocaleString()} · ${{changed:'已调整',unchanged:'保持原设定',limited:'保持原设定',stale:'等待重新检查',failed:'检查失败'}[review.outcome]}：${review.reason}`:'尚无后台检查记录；开启记忆学习并继续真实互动后检查。'}</p>}
      <Field label="默认活动会话" hint="没有特别想去的地方时在这里活动。有相关念头时，可以选择其他已授权会话；不会自动群发。"><select required value={policy.routeId} onChange={e=>patch({routeId:e.target.value})}><option value="">选择一个会话</option>{routes.map(r=><option key={r.id} value={r.id}>{r.kind==='local'?'网页聊天':`${snapshot?.channels.find(c=>c.id===r.channelId)?.name??'渠道'} · ${snapshot?.pairings.find(p=>p.channelId===r.channelId&&p.userId===r.userId)?.displayName??r.userId}`}</option>)}</select></Field>
      {snapshot&&!routes.length&&<p>还没有可用会话，先在网页或已授权渠道和伙伴聊一次。</p>}
      <div className="dsh-partner-fields two"><Field label="基础概率升至 100% 的间隔" hint="基础概率 = 已空闲分钟 ÷ 此间隔。适用好感度加成时再乘以主动系数，上限 100%；最短 30 分钟，不是平均活动间隔。"><select value={policy.idleMinutes} onChange={e=>patch({idleMinutes:Number(e.target.value)})}>{[...new Set([30,60,120,240,480,1440,policy.idleMinutes])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n<60?`${n} 分钟`:`${n/60} 小时`}</option>)}</select></Field></div>
      <p className="dsh-partner-character-hint">未计好感度加成时，间隔 {policy.idleMinutes} 分钟：第 1 分钟约 {(100/policy.idleMinutes).toFixed(1)}%，第 {policy.idleMinutes/2} 分钟约 50%，到 {policy.idleMinutes} 分钟为 100%。提前抽中就开始新周期，因此通常会更早触发。100% 代表做一次决定，不保证发送消息。</p>
      <p className="dsh-partner-character-hint">不限制每天活动次数，也不要求每次发消息。抽中后重置计时；新聊天会重新累计空闲时间。你没回复时，伙伴仍可做其他事情，避免反复追问。睡眠期间暂停，醒来后恢复检查。</p>
    </fieldset>}
  </section>
}
