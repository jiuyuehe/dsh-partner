import {useEffect, type Dispatch, type SetStateAction} from 'react'
import {api, type PartnerSnapshot} from '../client-api.js'

type Status=Pick<PartnerSnapshot,'channels'|'pairings'> & Partial<Pick<PartnerSnapshot,'channelDiagnostics'>>
const listeners=new Set<(value:Status)=>void>()
let timer:ReturnType<typeof setTimeout>|undefined
let active:AbortController|undefined
let lastValue=''
let lastDiagnosticSequence=0
let lastPollError=''

function logDiagnostics(entries:Status['channelDiagnostics']):void {
  if(!isLocalDiagnosticsEnabled()||!entries?.length)return
  const newest=entries[entries.length-1]!.sequence
  // DSH 重启会重置内存序号；检测到回绕后从新进程的首条记录继续输出。
  if(newest<lastDiagnosticSequence)lastDiagnosticSequence=0
  for(const entry of entries) {
    if(entry.sequence<=lastDiagnosticSequence)continue
    const label=`[dsh-partner][${entry.platform}][${entry.phase}]`
    const payload={...entry}
    if(entry.level==='error')console.error(label,payload)
    else if(entry.level==='warn')console.warn(label,payload)
    else console.log(label,payload)
    lastDiagnosticSequence=entry.sequence
  }
}

function isLocalDiagnosticsEnabled():boolean {
  return ['localhost','127.0.0.1','::1'].includes(window.location.hostname)
}

async function poll():Promise<void> {
  if(active||!listeners.size)return
  const controller=new AbortController();active=controller
  try {
    if(document.visibilityState!=='hidden') {
      const value=await api<Status>('/channels/status',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])})
      lastPollError=''
      logDiagnostics(value.channelDiagnostics)
      const serialized=JSON.stringify(value)
      if(serialized!==lastValue){lastValue=serialized;listeners.forEach(listener=>listener(value))}
    }
  } catch (reason) {
    // 状态请求的真实失败也写进浏览器开发者控制台，避免 UI 只静默保留旧状态。
    const detail=reason instanceof Error?reason.message:String(reason)
    if(isLocalDiagnosticsEnabled()&&detail!==lastPollError){console.error('[dsh-partner][channel-status][poll-error]',detail);lastPollError=detail}
  }
  finally {
    if(active===controller)active=undefined
    if(listeners.size)timer=setTimeout(()=>void poll(),3000)
  }
}

/** 本地 DSH 页面启用常驻收件诊断；仍复用既有 /channels/status 请求，不新增网络路由。 */
export function observeChannelDiagnostics():()=>void {
  if(!isLocalDiagnosticsEnabled())return ()=>{}
  const keepAlive=()=>{}
  listeners.add(keepAlive)
  if(!active){clearTimeout(timer);void poll()}
  return ()=>{
    listeners.delete(keepAlive)
    if(!listeners.size){clearTimeout(timer);active?.abort();lastValue=''}
  }
}

export function useChannelStatus(setSnapshot:Dispatch<SetStateAction<PartnerSnapshot|undefined>>):void {
  useEffect(()=>{
    const update=(value:Status)=>setSnapshot(previous=>previous?{...previous,...value}:previous)
    listeners.add(update)
    lastValue=''
    if(!active){clearTimeout(timer);void poll()}
    return ()=>{listeners.delete(update);if(!listeners.size){clearTimeout(timer);active?.abort();lastValue=''}}
  },[setSnapshot])
}
