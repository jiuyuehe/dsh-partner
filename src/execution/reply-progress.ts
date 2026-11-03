import type {SessionEvent} from '@deepseek-ai/dsh-session'

export type ReplyStage = 'queued' | 'working' | 'tools' | 'composing'
export type ReplyActivity = {kind:'text';text:string} | {kind:'tool-start';id:string;name:string} | {kind:'tool-end';id:string;failed:boolean}
export type ReplyProgress = ((stage:ReplyStage | ReplyActivity)=>void) & {acknowledge?:(text:string)=>Promise<void>;sendChat?:(parts:import('../chat/protocol.js').ChatPart[],routeId:string,receipt:string)=>Promise<void>}

/** Deliberately expose only fixed labels, never tool names, arguments or reasoning. */
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
    // Terminal chat tools own their text; forwarding it here would deliver twice.
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
  try{notify?.(stage)}catch{ /* A UI observer cannot interrupt agent execution. */ }
}
