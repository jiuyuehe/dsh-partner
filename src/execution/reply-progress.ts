import type {SessionEvent} from '@deepseek-ai/dsh-session'

export type ReplyStage = 'queued' | 'working' | 'tools' | 'composing'
export type ReplyActivity = {kind:'text';text:string} | {kind:'tool-start';id:string;name:string} | {kind:'tool-end';id:string;failed:boolean}
export type ReplyLifecycleStage='agent-followup-starting'|'agent-followup-submitted'|'agent-followup-completed'
// 生命周期仅供渠道诊断观察 DSH 是否真正收到本轮消息，不作为用户消息或模型提示词。
export type ReplyProgress = ((stage:ReplyStage | ReplyActivity)=>void) & {
  acknowledge?:(text:string)=>Promise<void>
  sendChat?:(parts:import('../chat/protocol.js').ChatPart[],routeId:string,receipt:string)=>Promise<void>
  lifecycle?:(stage:ReplyLifecycleStage,durationMs?:number)=>void
}

/** 仅向渠道暴露固定进度标签，不暴露工具名、参数或模型推理。 */
export function replyStage(event:SessionEvent):ReplyStage|undefined {
  if(event.type==='tool/call')return 'tools'
  if(event.type==='request/header')return 'composing'
  return undefined
}
export function replyActivity(event:SessionEvent):ReplyActivity|undefined {
  if(event.type==='tool/call')return {kind:'tool-start',id:event.data.callId,name:/^[\w.:-]{1,100}$/.test(event.data.name)?event.data.name:'工具'}
  if(event.type==='tool/result'){
    const result=event.data.message
    return {kind:'tool-end',id:result.toolCallId,failed:!!event.data.error||!!result.isError}
  }
  if(event.type==='assistant/message'&&!event.data.interrupted&&event.data.message.content.some(block=>block.type==='tool-call')){
    // 最终答复工具已经负责发送文本；再次转发会造成重复投递。
    if(event.data.message.content.some(block=>{
      if(block.type!=='tool-call')return false
      if(['partner_chat_reply','partner_chat_say'].includes(block.name))return true
      if(block.name!=='partner_tools')return false
      try{return ['partner_chat_reply','partner_chat_say'].includes(JSON.parse(block.arguments).name)}catch{return false}
    }))return undefined
    const text=event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n').trim()
    if(text)return {kind:'text',text}
  }
  return undefined
}
export function reportProgress(notify:ReplyProgress|undefined,stage:ReplyStage|ReplyActivity):void {
  try{notify?.(stage)}catch{ /* UI 观察器异常不能中断 Agent 执行。 */ }
}

// 诊断回调与进度回调一样是旁路观察，不能让浏览器日志故障中断 Agent。
export function reportLifecycle(notify:ReplyProgress|undefined,stage:ReplyLifecycleStage,durationMs?:number):void {
  try{notify?.lifecycle?.(stage,durationMs)}catch{ /* 诊断观察失败时继续本轮执行。 */ }
}
