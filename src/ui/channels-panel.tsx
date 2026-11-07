import {QqConnectionGuide} from './qq-connection-guide.js'
import {useState, useRef, type ReactNode, type FormEvent} from 'react'
import {api, type ChannelView, type CompanionView, type PartnerSnapshot} from '../client-api.js'
import {NotificationSettings} from './notification-settings.js'
import {SectionHeading, ChannelStatus} from './partner-components.js'
import {errorMessage, WorkspaceDialog, DiscardChangesDialog} from './workspace-components.js'
import {QqChannelSettings} from './qq-channel-settings.js'
import {PushChannels} from './push-channels.js'

export function ChannelsPanel({companion,snapshot,onChanged,weixin}: {companion:CompanionView;snapshot:PartnerSnapshot;onChanged():Promise<void>;weixin:ReactNode}):JSX.Element {
  const [platform,setPlatform]=useState<'matrix'|'mattermost'|'qq'>('matrix')
  const [name,setName]=useState('')
  const [baseUrl,setBaseUrl]=useState('')
  const [targetId,setTargetId]=useState('')
  const [mattermostChannels,setMattermostChannels]=useState<Array<{id:string;name:string;displayName:string;type:'O'|'P'}>>([])
  const [allowedChannelIds,setAllowedChannelIds]=useState<string[]>([])
  const [editingAllowedChannels,setEditingAllowedChannels]=useState<string[]>([])
  const [editingAllowedChannelsDirty,setEditingAllowedChannelsDirty]=useState(false)
  const [editingThreadHistoryRounds,setEditingThreadHistoryRounds]=useState(3)
  const [editingThreadHistoryDirty,setEditingThreadHistoryDirty]=useState(false)
  const [botToken,setToken]=useState('')
  const [authMode,setAuthMode]=useState<'password'|'token'>('password')
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[mfaToken,setMfaToken]=useState('')
  const [busy,setBusy]=useState(false)
  const [feedback,setFeedback]=useState('')
  const [deleting,setDeleting]=useState<string>()
  const [adding,setAdding]=useState(false)
  const [addingPush,setAddingPush]=useState(false)
  const [fixedPlatform,setFixedPlatform]=useState(false)
  const [configuring,setConfiguring]=useState<string>()
  const qqEdit=useRef({dirty:false,busy:false})
  const [discardQq,setDiscardQq]=useState(false)
  const closeAdd=()=>{setAdding(false);setToken('');setPassword('');setMfaToken('');setMattermostChannels([]);setAllowedChannelIds([])}
  const openAdd=(selected?:'matrix'|'mattermost'|'qq')=>{
    setFixedPlatform(Boolean(selected));setPlatform(selected??'matrix');setName('');setBaseUrl('');setTargetId('');setUsername('');setPassword('');setToken('');setMfaToken('');setAuthMode(selected==='qq'?'token':'password');setFeedback('');setMattermostChannels([]);setAllowedChannelIds([]);setAdding(true)
  }
  const channels=snapshot.channels.filter(c=>c.companionId===companion.id)
  const pairings=snapshot.pairings.filter(p=>channels.some(c=>c.id===p.channelId))
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setFeedback('');try{await action()}catch(error){setFeedback(errorMessage(error))}finally{setBusy(false)}}
  const saveMattermostSettings=(channel:ChannelView)=>run(async()=>{
    await api(`/channels/${channel.id}/enabled`,{method:'POST',body:JSON.stringify({enabled:channel.enabled,allowedChannelIds:editingAllowedChannels,threadHistoryRounds:editingThreadHistoryRounds})})
    setEditingAllowedChannelsDirty(false);setEditingThreadHistoryDirty(false);await onChanged()
  })
  const configure=async(save:boolean)=>run(async()=>{
    const body={companionId:companion.id,platform,name:name.trim()||platform,baseUrl:baseUrl.trim(),targetId:targetId.trim(),authMode:platform==='qq'?'token':authMode,...(platform==='mattermost'?{allowedChannelIds}:{}),...(platform!=='qq'&&authMode==='password'?{username,password,mfaToken}:{botToken:botToken.trim()})}
    const result=await api<{mattermostChannels?:typeof mattermostChannels}>(save?'/channels':'/channels/test',{method:'POST',body:JSON.stringify({...body,...(!save&&platform==='mattermost'?{listMattermostChannels:true}:{})})})
    if(!save&&platform==='mattermost'&&result.mattermostChannels){setMattermostChannels(result.mattermostChannels);setAllowedChannelIds(current=>current.filter(id=>result.mattermostChannels!.some(item=>item.id===id)))}
    if(save){await onChanged();closeAdd()}
    setFeedback(save?'账号已保存。请启用渠道，再向机器人发送私聊消息，核对配对码并批准联系人。':platform==='mattermost'?'账号验证通过，已读取机器人加入的频道；频道默认不接收，勾选后仍须逐个批准发言人。':'账号验证通过，可以保存。')
  })
  return <div id="dsh-partner-channels" className="dsh-partner-form is-channel dsh-partner-channels">
    <div className="dsh-partner-channel-toolbar">
      <SectionHeading eyebrow="CHANNELS" title="我的渠道" detail="查看连接状态，管理联系人与通知投递。" />
      <button type="button" onClick={()=>openAdd()}>添加渠道</button>
    </div>
    {!adding&&feedback&&<p role="status">{feedback}</p>}
    {adding&&<WorkspaceDialog title={fixedPlatform?`${platform==='qq'?'QQ · SnowLuma':platform==='matrix'?'Matrix':'Mattermost'} 配置`:'添加渠道'} detail={platform==='qq'?'正向 WebSocket 同时收发消息，无需 HTTP API。先在 SnowLuma 登录 QQ，再填写连接信息。':platform==='matrix'?'仅未加密的双人会话可获取配对码。请新建未开启端到端加密的会话，邀请机器人后发送文字消息。':'先登录，再向机器人发私聊消息，核对配对码后授权。'} close={()=>{if(!busy)closeAdd()}}>
      <form className="dsh-partner-feature-form dsh-partner-channel-form" aria-busy={busy} onSubmit={(event:FormEvent)=>{event.preventDefault();void configure(true)}}>
        {!fixedPlatform&&<FormField label="平台"><select autoFocus disabled={busy} value={platform} onChange={e=>{if(e.target.value==='bark'){closeAdd();setAddingPush(true);return}setPlatform(e.target.value as typeof platform);setAuthMode(e.target.value==='qq'?'token':'password');setPassword('');setToken('');setMfaToken('');setTargetId('');setFeedback('')}}><option value="qq">QQ · SnowLuma / OneBot v11</option><option value="matrix">Matrix</option><option value="mattermost">Mattermost</option><option value="bark">Bark · 单向通知</option></select></FormField>}
        {platform==='qq'&&<QqConnectionGuide />}
        <FormField label="渠道名称"><input autoFocus={fixedPlatform} disabled={busy} maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder={`例如：我的 ${platform==='qq'?'QQ · SnowLuma':platform==='matrix'?'Matrix':'Mattermost'}`} /></FormField>
        <FormField label={platform==='qq'?'正向 WebSocket 地址':'服务器地址'} hint={platform==='qq'?'同在 appnet 时填写 ws://snowluma:3001。选择 SnowLuma 的 Universal WebSocket 服务；不要填写 HTTP API 地址。':''}><input disabled={busy} required type="url" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder={platform==='qq'?'ws://snowluma:3001':'https://chat.example.com'} /></FormField>
        <details><summary>高级配置（可选）</summary><FormField label={platform==='qq'?'固定联系人 QQ 号':platform==='matrix'?'固定房间 ID':'固定 DM 会话 ID'} hint="留空则自动发现私聊，通过配对授权。填写后仅监听指定会话。"><input disabled={busy} value={targetId} onChange={e=>setTargetId(e.target.value)} placeholder={platform==='qq'?'可留空，自动发现好友私聊':platform==='matrix'?'!room:example.com':'DM channel ID'} /></FormField></details>
        {platform==='mattermost'&&<section className="dsh-partner-channel-access"><h3>允许接收 @机器人的频道</h3><p>先测试连接读取机器人已加入的频道。未勾选频道不会读取；勾选频道后，每位发言人仍需单独审批。</p>{mattermostChannels.length===0?<button type="button" disabled={busy||!(authMode==='password'?username&&password:botToken)||!baseUrl} onClick={()=>void configure(false)}>读取 Mattermost 频道</button>:<>
          <div className="dsh-partner-channel-directory">{mattermostChannels.map(item=><label key={item.id}><input type="checkbox" disabled={busy} checked={allowedChannelIds.includes(item.id)} onChange={event=>setAllowedChannelIds(current=>event.target.checked?[...current,item.id]:current.filter(id=>id!==item.id))}/><span><strong>{item.displayName}</strong><small>#{item.name} · {item.type==='O'?'公开':'私有'}</small></span></label>)}</div>
          <button type="button" disabled={busy} onClick={()=>void configure(false)}>重新读取频道</button>
        </>}</section>}
        {platform!=='qq'&&<FormField label="登录方式"><select disabled={busy} value={authMode} onChange={e=>{setAuthMode(e.target.value as typeof authMode);setToken('');setPassword('');setMfaToken('')}}><option value="password">账号密码</option><option value="token">Access Token</option></select></FormField>}
        {platform!=='qq'&&authMode==='password'?<>
          <FormField label="账号"><input disabled={busy} required autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder={platform==='matrix'?'@账号:服务器域名':'用户名或邮箱'}/></FormField>
          <FormField label="密码" hint="仅用于换取令牌，不保存密码；请优先使用 HTTPS 服务器。"><input disabled={busy} required type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></FormField>
          {platform==='mattermost'&&<FormField label="双重验证验证码（如已开启）"><input disabled={busy} autoComplete="one-time-code" inputMode="numeric" value={mfaToken} onChange={e=>setMfaToken(e.target.value)}/></FormField>}
        </>:<FormField label={platform==='qq'?'WS Access Token':'Access Token'} hint={platform==='qq'?'复制 SnowLuma 正向 WebSocket 的令牌；HTTP 与 WS 的令牌可能不同。令牌仅存入 DSH 凭据库。':'仅保存至 DSH 凭据库；建议 HTTPS，HTTP 会明文传输凭据。'}><input disabled={busy} required type="password" autoComplete="new-password" value={botToken} onChange={e=>setToken(e.target.value)} /></FormField>}
        {feedback&&<p role="status">{feedback}</p>}
        <footer><button type="button" disabled={busy} onClick={closeAdd}>取消</button><button type="button" disabled={busy||!(platform!=='qq'&&authMode==='password'?username&&password:botToken)||!baseUrl} onClick={()=>void configure(false)}>{platform==='mattermost'?'测试连接并读取频道':'测试连接'}</button><button className="is-primary" disabled={busy}>{busy?'处理中…':'保存渠道'}</button></footer>
      </form>
    </WorkspaceDialog>}
    <div className="dsh-partner-channel-list">
    <PushChannels companion={companion} snapshot={snapshot} onChanged={onChanged} adding={addingPush} closeAdd={()=>setAddingPush(false)}/>
    <div className="dsh-partner-channel-row">
      <span><strong>微信</strong><small>{channels.some(c=>!c.platform||c.platform==='weixin')?'管理连接与私聊授权':'尚未连接 · 扫码接入'}</small></span>{channels.find(c=>!c.platform||c.platform==='weixin')&&<ChannelStatus channel={channels.find(c=>!c.platform||c.platform==='weixin')!}/>}<button type="button" aria-label="配置微信" onClick={()=>setConfiguring('weixin')}>配置</button>
      {configuring==='weixin'&&<WorkspaceDialog title="微信配置" detail="管理扫码登录、连接与联系人授权。" close={()=>setConfiguring(undefined)}>{weixin}</WorkspaceDialog>}
    </div>
    {(['qq','matrix','mattermost'] as const).filter(platform=>!channels.some(c=>c.platform===platform)).map(platform=><div className="dsh-partner-channel-row" key={platform}><span><strong>{platform==='qq'?'QQ · SnowLuma':platform==='matrix'?'Matrix':'Mattermost'}</strong><small>尚未连接</small></span><button type="button" aria-label={`配置 ${platform}`} onClick={()=>openAdd(platform)}>配置</button></div>)}
    {channels.filter(c=>c.platform&&c.platform!=='weixin').map(channel=><div key={channel.id} className="dsh-partner-channel-row has-notice-slot">
      <span><strong>{channel.name}</strong><small>{channel.platform==='qq'?'QQ':channel.platform} · {pairings.filter(p=>p.channelId===channel.id&&(p.status==='pending'||(p.pendingChannelIds?.length??0)>0)).length} 个待授权</small></span><ChannelStatus channel={channel}/><button type="button" aria-label={`配置 ${channel.name}`} onClick={()=>{setFeedback('');setEditingAllowedChannels(channel.direct?.allowedChannelIds??[]);setEditingAllowedChannelsDirty(false);setEditingThreadHistoryRounds(channel.direct?.threadHistoryRounds??3);setEditingThreadHistoryDirty(false);setConfiguring(channel.id)}}>配置</button>
      {configuring===channel.id&&<WorkspaceDialog title={`${channel.name} · 配置`} detail="管理连接状态及联系人访问权限。" close={()=>{if(busy||qqEdit.current.busy)return;if(channel.platform==='qq'&&qqEdit.current.dirty){setDiscardQq(true);return}setConfiguring(undefined);setDeleting(undefined)}}>
      {channel.platform==='qq'?<QqChannelSettings editState={qqEdit} channel={channel} pairings={pairings} onChanged={onChanged} onDeleted={()=>setConfiguring(undefined)}/>:<div className="dsh-partner-channel-detail dsh-partner-channel-manage">
      <div className="dsh-partner-channel-connection"><span><small>登录账号</small><strong>{channel.accountId}</strong>{channel.direct?.targetId&&<small>{channel.direct.targetId}</small>}</span><ChannelStatus channel={channel}/></div>
      {channel.platform==='matrix'&&<p>仅支持未加密的双人会话。加密会话无法读取消息或发送配对码；请新建未开启端到端加密的会话，邀请机器人后发送文字消息。检测到加密会话时会在此提示，不影响其他未加密会话。</p>}
      {channel.platform==='mattermost'&&<section className="dsh-partner-channel-access"><h3>允许接收 @机器人的频道</h3><p>频道范围与 DM 分开授权；保存时会重新验证机器人仍加入所选频道。</p>{channel.direct?.mattermostChannels?.length?<div className="dsh-partner-channel-directory">{channel.direct.mattermostChannels.map(item=><label key={item.id}><input type="checkbox" disabled={busy} checked={editingAllowedChannels.includes(item.id)} onChange={event=>{setEditingAllowedChannelsDirty(true);setEditingAllowedChannels(current=>event.target.checked?[...current,item.id]:current.filter(id=>id!==item.id))}}/><span><strong>{item.displayName}</strong><small>#{item.name} · {item.type==='O'?'公开':'私有'}</small></span></label>)}</div>:<button type="button" disabled={busy} onClick={()=>void run(async()=>{await api(`/channels/${channel.id}/enabled`,{method:'POST',body:JSON.stringify({enabled:channel.enabled,allowedChannelIds:editingAllowedChannels})});await onChanged()})}>读取机器人已加入的 Mattermost 频道</button>}
        <FormField label="Thread 历史轮数" hint="每轮按 USER 消息与对应 BOT 回复成组注入；0 表示不带历史，最多 10 轮。保存后新收到的消息生效。"><input type="number" min={0} max={10} step={1} disabled={busy} value={editingThreadHistoryRounds} onChange={event=>{setEditingThreadHistoryRounds(Number(event.target.value));setEditingThreadHistoryDirty(true)}}/></FormField>
        <button type="button" disabled={busy||(!editingAllowedChannelsDirty&&!editingThreadHistoryDirty)} onClick={()=>void saveMattermostSettings(channel)}>保存 Mattermost 设置</button>
      </section>}
      {!channel.direct?.targetId&&<p>向机器人发私聊消息，在下方核对配对码后批准。请求会自动更新。</p>}
      {!!channel.activity?.length&&<div className="dsh-partner-channel-inline-notice" role="status"><strong>当前任务</strong>{channel.activity.map((a,i)=><p key={i}>{a.label}{a.sessionId&&<small> · {a.sessionId.slice(-8)}</small>}</p>)}</div>}
      {channel.groupDecision&&<div className="dsh-partner-channel-inline-notice" role="status"><strong>最近群聊判断 · {new Date(channel.groupDecision.at).toLocaleTimeString()}</strong><p>群 {channel.groupDecision.groupId}：{channel.groupDecision.reason}</p></div>}
      {channel.idleDelivery&&<div className="dsh-partner-channel-inline-notice" role="status"><strong>主动联系投递</strong><p>{channel.idleDelivery}</p></div>}
      {channel.lastError&&<p role="alert">{channel.lastError}</p>}
      <div className="dsh-partner-form-actions">
        {/* 停用、停止或连接异常时始终提供同一个恢复入口；后端会启用渠道并启动接收循环。 */}
        {(!channel.enabled||channel.runtimeStatus==='stopped'||channel.runtimeStatus==='error')&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{const wasEnabled=channel.enabled;await api(`/channels/${channel.id}/enabled`,{method:'POST',body:JSON.stringify({enabled:true})});await onChanged();setFeedback(wasEnabled?'已提交重连请求。':'渠道已启用，正在连接并接收消息。')})}>{channel.enabled?'重新连接':'启动并连接'}</button>}
        {channel.enabled&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await api(`/channels/${channel.id}/enabled`,{method:'POST',body:JSON.stringify({enabled:false})});await onChanged();setFeedback('渠道已停用。')})}>停用</button>}
        <button disabled={busy} onClick={()=>deleting===channel.id?void run(async()=>{await api(`/channels/${channel.id}`,{method:'DELETE'});setDeleting(undefined);await onChanged()}):setDeleting(channel.id)}>{deleting===channel.id?'确认删除配置与凭据':'删除渠道'}</button>
        {deleting===channel.id&&<button onClick={()=>setDeleting(undefined)}>取消</button>}
      </div>
      <section className="dsh-partner-channel-access"><h3>联系人授权</h3><p role="status">{pairings.filter(p=>p.channelId===channel.id&&(p.status==='pending'||(p.pendingChannelIds?.length??0)>0)).length} 个待授权 · 自动刷新</p>
      {pairings.filter(p=>p.channelId===channel.id).map(p=>{
        const channelIds=(channel.platform==='mattermost'?(channel.direct?.allowedChannelIds??[]):[]).filter(id=>p.allowedChannelIds?.includes(id)||p.pendingChannelIds?.includes(id))
        const isMm=channel.platform==='mattermost'
        return <div key={p.id} className="dsh-partner-channel-person"><div><strong>{p.displayName}</strong><small>{isMm?`DM ${p.status==='approved'?'已授权':p.directTargetId&&p.status==='pending'?'待批准':p.status==='blocked'?'已阻止':'未授权'}`:p.status==='approved'?'已授权':p.status==='pending'?'等待批准':'已阻止'}</small>{p.status==='pending'&&p.pairingCode&&<span>配对码 <code>{p.pairingCode}</code></span>}{channelIds.map(id=>{const item=channel.direct?.mattermostChannels?.find(option=>option.id===id);const approved=p.allowedChannelIds?.includes(id);return <small key={id}>{item?.displayName??id}：{approved?'频道已授权':'频道待批准'}</small>})}</div>
          {isMm? <><div className="dsh-partner-channel-person-actions">{p.directTargetId&&<button disabled={busy} onClick={()=>void run(async()=>{await api(`/pairings/${p.id}/status`,{method:'POST',body:JSON.stringify({status:p.status==='approved'?'blocked':'approved'})});await onChanged()})}>{p.status==='approved'?'撤销 DM 授权':'批准 DM'}</button>}{channelIds.map(id=><button key={id} disabled={busy} onClick={()=>void run(async()=>{await api(`/pairings/${p.id}/status`,{method:'POST',body:JSON.stringify({status:p.allowedChannelIds?.includes(id)?'blocked':'approved',channelId:id})});await onChanged()})}>{p.allowedChannelIds?.includes(id)?'撤销频道':'批准频道'}</button>)}</div></>:
            <button disabled={busy} onClick={()=>void run(async()=>{await api(`/pairings/${p.id}/status`,{method:'POST',body:JSON.stringify({status:p.status==='approved'?'blocked':'approved'})});await onChanged()})}>{p.status==='approved'?'撤销授权':'批准联系人'}</button>}
        </div>
      })}
      </section>
      {feedback&&<p role="status">{feedback}</p>}
    </div>}</WorkspaceDialog>}
      {!!channel.activity?.length&&<div className="dsh-partner-channel-inline-notice" role="status"><strong>当前任务</strong>{channel.activity.map((a,i)=><p key={i}>{a.label}{a.sessionId&&<small> · {a.sessionId.slice(-8)}</small>}</p>)}</div>}
      {channel.groupDecision&&<div className="dsh-partner-channel-inline-notice" role="status"><strong>最近群聊判断 · {new Date(channel.groupDecision.at).toLocaleTimeString()}</strong><p>群 {channel.groupDecision.groupId}：{channel.groupDecision.reason}</p></div>}
      {channel.idleDelivery&&<div className="dsh-partner-channel-inline-notice" role="status"><strong>主动联系投递</strong><p>{channel.idleDelivery}</p></div>}
      {channel.lastError&&<div className="dsh-partner-channel-inline-notice" role="status" aria-atomic="true"><strong>{channel.runtimeStatus==='running'?'会话提示':'连接提示'}</strong><p>{channel.lastError}</p></div>}
    </div>)}
    </div>
    <section className="dsh-partner-channel-notifications" aria-label="通知设置"><div className="dsh-partner-channel-row"><span><strong>通知与交付</strong><small>{companion.notificationDelivery?.mode==='selected'?`已指定 ${companion.notificationDelivery.targets.length} 位接收人`:'默认跟随最近渠道与用户'}</small></span><button type="button" onClick={()=>setConfiguring('delivery')}>配置</button></div></section>
    {discardQq&&<DiscardChangesDialog keepEditing={()=>setDiscardQq(false)} discard={()=>{setDiscardQq(false);setConfiguring(undefined)}}/>}
    {configuring==='delivery'&&<WorkspaceDialog title="通知与交付" detail="选择通知渠道，再选择各渠道的接收人；支持同时投递。" close={()=>setConfiguring(undefined)}><NotificationSettings companion={companion} snapshot={snapshot} onChanged={onChanged}/></WorkspaceDialog>}
  </div>
}

function FormField({label,hint,children}:{label:string;hint?:string;children:ReactNode}):JSX.Element {
  return <label className="dsh-partner-channel-field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>
}
