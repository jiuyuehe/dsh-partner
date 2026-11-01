import type { SessionEvent } from '@deepseek-ai/dsh-session'
function object(value: unknown): Record<string,any> | undefined {
  try { const v=typeof value==='string'?JSON.parse(value):value; return v&&typeof v==='object'&&!Array.isArray(v)?v:undefined } catch { return undefined }
}
export function attachmentDeliveryMeta(value:unknown):{kind:'partner-attachment-delivered-v1';originRouteId:string}|null {
  const v=object(value)
  return v?.channel==='sent'&&v.conversation==='attachment_recorded'&&typeof v.originRouteId==='string'&&v.originRouteId?{kind:'partner-attachment-delivered-v1',originRouteId:v.originRouteId}:null
}
export function deliveredAttachment(event:SessionEvent):string|undefined {
  if(event.type!=='tool/result'&&event.type!=='tool/ptc-dispatch')return
  if(!event.data||(event.type==='tool/result'?event.data.message?.isError:event.data.isError))return
  const meta=event.data.meta as {kind?:string;originRouteId?:unknown}|undefined
  return meta?.kind==='partner-attachment-delivered-v1'&&typeof meta.originRouteId==='string'?meta.originRouteId:undefined
}
