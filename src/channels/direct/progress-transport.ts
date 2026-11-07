import {randomUUID} from 'node:crypto'
import {formatDirectMessages} from './message-format.js'
import type {DirectConfig} from './transport.js'

export interface ProgressTransport {
  readonly finalDelivery?: 'replace' | 'separate'
  readonly activityBlocks?: boolean
  typing(active:boolean,signal:AbortSignal):Promise<void>
  create(text:string,signal:AbortSignal):Promise<string>
  edit(id:string,text:string,signal:AbortSignal):Promise<void>
  send(text:string,signal:AbortSignal):Promise<void>
}
type Request=(path:string,signal:AbortSignal,body:unknown,method?:string)=>Promise<any>

/** Only channel protocol mapping. Message lifecycle belongs to ReplyProgressController. */
export function directProgressTransport(config:DirectConfig,userId:string,validate:(signal:AbortSignal)=>Promise<{accountId:string;peerId:string}>,request:Request,send:ProgressTransport['send']):ProgressTransport {
  let typingIdentity: {accountId:string;peerId:string}|undefined
  const identity=async(signal:AbortSignal)=>{const who=await validate(signal);const roomPeerRequired=config.roomMode!=='mattermost-channel'&&config.roomMode!=='mattermost-thread';if(!config.targetId||roomPeerRequired&&who.peerId!==userId)throw Error('进度消息接收人不匹配');return who}
  const matrixPath=()=>`/_matrix/client/v3/rooms/${encodeURIComponent(config.targetId)}/send/m.room.message/${randomUUID()}`
  const content=(text:string)=>{const p=formatDirectMessages(text)[0];if(!p)throw Error('进度消息为空');return {msgtype:'m.text',body:p.body,format:'org.matrix.custom.html',formatted_body:p.formattedBody}}
  const progressCard=(text:string)=>({message:'',props:{attachments:[{fallback:`伙伴执行进度：${text}`,title:'伙伴执行进度',text}]}})
  return {
    finalDelivery:config.platform==='mattermost'?'separate':'replace',
    activityBlocks:config.platform==='mattermost',
    async typing(active,signal){
      const who=typingIdentity??await identity(signal)
      typingIdentity=who
      if(config.platform==='matrix')await request(`/_matrix/client/v3/rooms/${encodeURIComponent(config.targetId)}/typing/${encodeURIComponent(who.accountId)}`,signal,{typing:active,...(active?{timeout:30000}:{})},'PUT')
      else if(active)await request(`/api/v4/users/${encodeURIComponent(who.accountId)}/typing`,signal,{channel_id:config.targetId,parent_id:config.threadRootId??''},'POST')
      // Mattermost typing expires on the client; its API has no explicit stop flag.
    },
    async create(text,signal){
      await identity(signal)
      // Mattermost 的进度卡和输入状态沿用已经验证过的 Thread 根，避免落到频道主时间线。
      const response=config.platform==='matrix'?await request(matrixPath(),signal,content(text),'PUT'):await request('/api/v4/posts',signal,{channel_id:config.targetId,...(config.threadRootId?{root_id:config.threadRootId}:{}),...progressCard(text)},'POST')
      const id=config.platform==='matrix'?response.event_id:response.id
      if(typeof id!=='string'||!id)throw Error('渠道未返回消息 ID')
      return id
    },
    async edit(id,text,signal){
      await identity(signal)
      const parts=formatDirectMessages(text)
      if(!parts.length)return
      if(config.platform==='matrix'){
        const replacement=content(parts[0]!.markdown)
        await request(matrixPath(),signal,{...replacement,body:'* '+replacement.body,'m.new_content':replacement,'m.relates_to':{rel_type:'m.replace',event_id:id}},'PUT')
      }else await request(`/api/v4/posts/${encodeURIComponent(id)}/patch`,signal,progressCard(parts[0]!.markdown),'PUT')
      // The original progress message holds the first block; remaining blocks follow.
      try {for(const part of parts.slice(1))await send(part.markdown,signal)}
      catch(error){throw new Error('首段已更新，但后续回复分段未完成',{cause:error})}
    },send,
  }
}
