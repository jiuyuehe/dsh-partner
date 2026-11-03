import {channelReplyAllowed} from '../reply-access.js'
import { createHash } from 'node:crypto'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerStore } from '../../store.js'
import { questionOrigin } from '../question-origin.js'
import { isIdleContactNotice } from '../../character/idle-contact.js'
import { qqSettings, qqGroupPeer, validQqId } from './settings.js'
import { qqMediaUrl } from './transport.js'
import type { QqActionCall } from './actions.js'

/** Conversation-only voice delivery: no target, file, URL or arbitrary API arguments. */
export function qqReplyTool(owner: string, store: PartnerStore, call: QqActionCall): ToolDefinition {
  return {
    name: 'partner_qq_reply',
    description: '真正群 @ 用 mention（userId 为当前群成员 QQ 号，text 可附带短句），不能用文字 @昵称 冒充提及；戳一戳用 poke（默认当前发言人，可指定当前群成员 userId，需已开启 send_poke）。这两项发送后可以继续说话，只能作用于当前聊天。向当前 QQ 聊天对象回复语音，属于公开聊天能力，不需要归属账号或私有能力总开关。按人格与场景可自行选择语音，不必等用户点名索要。voices 查询当前可用音色；voice 把 text 转成语音并发送，成功后结束回合，不重复发文字。无需填写接收人；不能读取本地文件、转发到其他联系人或使用 QQ 空间/管理能力。语音是否可用由渠道的聊天回复设置控制。普通文字和表情仍使用 partner_chat_reply 或最终正文。',
    parameters: { type:'object', additionalProperties:false, required:['action'], properties:{
      action:{type:'string',enum:['voices','voice','mention','poke']}, text:{type:'string',minLength:1,maxLength:2000}, character:{type:'string',minLength:1,maxLength:200}, userId:{type:'string',pattern:'^[0-9]{5,12}$'},
    }},
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
    presentationMeta:(_args,value)=>{
      const result=value as {status?:string;originRouteId?:string;spokenText?:string;interactionText?:string;inputMessageId?:string}
      if(result.status==='confirmed'&&result.interactionText&&result.originRouteId)return {kind:'partner-chat-v1',parts:[{type:'text',text:result.interactionText}],intermediate:true,delivered:true,...(result.inputMessageId?{inputMessageId:result.inputMessageId}:{}),originRouteId:result.originRouteId}
      return result.status==='confirmed'&&result.originRouteId?{kind:'partner-chat-v1',parts:[],delivered:true,originRouteId:result.originRouteId,...(result.spokenText?{spokenText:result.spokenText}:{})}:null
    }},
    presentCall:()=>({card:'generic',title:'QQ 聊天互动'}),
    async execute(raw, exec) {
      const args=raw as {action:string;text?:string;character?:string;userId?:string}
      if (!args || Object.keys(args).some(k=>!['action','text','character','userId'].includes(k)) || !['voices','voice','mention','poke'].includes(args.action)) throw Error('语音回复参数无效')
      if(args.action==='voice' && (typeof args.text!=='string'||!args.text.trim()||args.text.length>2000))throw Error('请提供 1–2000 字的语音内容')
      if(args.character!==undefined && (typeof args.character!=='string'||!args.character.trim()||args.character.length>200))throw Error('音色标识无效')
      const agent=exec.agent
      if(!agent)throw Error('需要当前 QQ 会话')
      const origin=()=>{
        const state=store.snapshot(),events=agent.session.snapshotEvents()
        const latest=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)))
        const route=latest&&isIdleContactNotice(latest)
          ? state.sessions.find(r=>r.sessionId===agent.session.id&&latest.type==='user/message'&&r.idleContactState?.messageId===latest.data.id)
          : questionOrigin(agent.session.id,events,state.sessions)
        return {state,route,messageId:latest?.type==='user/message'?latest.data.id:undefined}
      }
      const initial=origin(),route=initial.route
      const channel=initial.state.channels.find(c=>c.id===route?.channelId&&c.companionId===owner&&c.platform==='qq')
      if(!route||route.companionId!==owner||!channel)throw Error('只能回复本轮实际来自的 QQ 会话')
      const group=qqGroupPeer(route.userId)
      const guard=()=>{
        exec.signal.throwIfAborted()
        const now=origin(),current=now.state.channels.find(c=>c.id===channel.id),settings=qqSettings(current?.qq)
        if(store.isCompanionRemoving(owner)||now.route?.id!==route.id||now.messageId!==initial.messageId||!current?.enabled||current.updatedAt!==channel.updatedAt||(['voices','voice'].includes(args.action)&&!settings.replyVoiceEnabled))throw Error('语音回复已关闭，或当前对象/渠道配置已变化')
        if(!channelReplyAllowed(now.state,channel.id,route.userId,group?'group:'+group.groupId:route.userId))throw Error('当前联系人访问许可已撤回')
        if(group ? !settings.groupReplies||!settings.groupIds.includes(group.groupId) : !settings.privateReplies)throw Error('当前会话回复已关闭')
        return settings
      }
      const settings=guard()
      if(args.action==='mention'||args.action==='poke') {
        if(!exec.callId)throw Error('当前宿主缺少互动回执标识')
        if(args.userId!==undefined&&(typeof args.userId!=='string'||!validQqId(args.userId)))throw Error('请提供有效 QQ 号码，不能使用昵称或 @全体')
        if(args.text!==undefined&&(typeof args.text!=='string'||args.text.length>2000))throw Error('附带文字最多 2000 字')
        if(args.character!==undefined||args.action==='poke'&&args.text!==undefined)throw Error('互动参数不匹配')
        if(args.action==='mention'&&(!group||!args.userId))throw Error('真正 @ 仅用于当前群，请提供群成员 userId')
        const target=args.userId??group?.userId??route.userId
        if(!group&&target!==route.userId)throw Error('不能戳其他私聊对象')
        const interactionGuard=()=>{const current=guard();if(args.action==='poke'&&!current.enabledActions.includes('send_poke'))throw Error('渠道尚未开启戳一戳（send_poke）')}
        interactionGuard()
        const signal=AbortSignal.any([exec.signal,AbortSignal.timeout(30000)])
        if(group){
          const member=await call(channel.id,'get_group_member_info',{group_id:Number(group.groupId),user_id:Number(target)},signal,interactionGuard) as any
          if(String(member?.user_id)!==target||String(member?.group_id)!==group.groupId)throw Error('无法确认目标是当前群成员')
        }
        const receiptId=createHash('sha256').update(JSON.stringify(['reply-interaction',owner,agent.session.id,exec.callId])).digest('hex')
        let previous:string|undefined
        await store.update(state=>{interactionGuard();const log=state.channels.find(c=>c.id===channel.id)!.qqActivity??=[];previous=log.find(r=>r.id===receiptId)?.status;if(!previous)log.push({id:receiptId,action:'reply_'+args.action,at:Date.now(),status:'pending'})})
        const interactionText=args.action==='mention'?'@'+target+(args.text?.trim()?' '+args.text.trim():''):'[戳了戳 '+target+']'
        const result=(status:string)=>({status,originRouteId:route.id,inputMessageId:initial.messageId,interactionText})
        if(previous)return {...result(previous),resent:false}
        try {
          interactionGuard()
          const sent=await call(channel.id,args.action==='mention'?'send_group_msg':'send_poke',args.action==='mention'
            ?{group_id:Number(group!.groupId),message:[{type:'at',data:{qq:target}},...(args.text?.trim()?[{type:'text',data:{text:' '+args.text.trim()}}]:[])]}
            :{user_id:Number(target),...(group?{group_id:Number(group.groupId)}:{})},signal,interactionGuard) as any
          if(args.action==='mention'&&(!sent||!['string','number'].includes(typeof sent.message_id)||!String(sent.message_id)||Number(sent.message_id)===0))throw Error('QQ 未确认提及发送')
          await store.update(state=>{const r=state.channels.find(c=>c.id===channel.id)?.qqActivity?.find(r=>r.id===receiptId);if(r)r.status='confirmed'})
          return result('confirmed')
        }catch(error){
          await store.update(state=>{const r=state.channels.find(c=>c.id===channel.id)?.qqActivity?.find(r=>r.id===receiptId);if(r)r.status='unknown'})
          throw Error('QQ 互动未确认发送，不要自动重发：'+(error instanceof Error?error.message:'请求失败'))
        }
      }
      if(args.userId!==undefined)throw Error('语音回复不能指定其他对象')
      const sourceGroup=group?.groupId||settings.replyVoiceGroupId||settings.groupIds[0]
      if(!sourceGroup||!settings.groupIds.includes(sourceGroup))throw Error('请在聊天回复中选择可用的 QQ 音色来源群')
      const signal=AbortSignal.any([exec.signal,AbortSignal.timeout(60000)])
      const voices=async()=>{
        const result=await call(channel.id,'get_ai_characters',{group_id:Number(sourceGroup),chat_type:1},signal,()=>{guard()})
        guard()
        return Array.isArray(result)?result.flatMap(row=>Array.isArray(row?.characters)?row.characters.filter((v:any)=>typeof v.character_id==='string'&&typeof v.character_name==='string').map((v:any)=>({id:v.character_id,name:v.character_name})):[]).slice(0,100):[]
      }
      if(args.action==='voices')return {voices:await voices()}
      if(typeof exec.concludeTurn!=='function'||!exec.callId)throw Error('当前宿主不支持语音回复终结')
      const character=args.character?.trim()||settings.voiceCharacter||(await voices())[0]?.id
      if(!character)throw Error('当前没有可用音色，请选择音色或改用文字')
      const receiptId=createHash('sha256').update(JSON.stringify(['reply-voice',owner,agent.session.id,exec.callId])).digest('hex')
      let previous:string|undefined
      await store.update(state=>{
        guard()
        const current=state.channels.find(c=>c.id===channel.id)!
        const log=current.qqActivity??=[]
        previous=log.find(r=>r.id===receiptId)?.status
        if(!previous)log.push({id:receiptId,action:'reply_voice',at:Date.now(),status:'pending'})
      })
      if(previous){if(previous==='confirmed')exec.concludeTurn();return {status:previous,resent:false,originRouteId:route.id}}
      let sendAttempted=false
      try {
        guard()
        let result:any
        if(group){sendAttempted=true;result=await call(channel.id,'send_group_ai_record',{group_id:Number(group.groupId),character,text:args.text!.trim(),chat_type:1},signal,()=>{guard()})}
        else {
          const generated=await call(channel.id,'get_ai_record',{group_id:Number(sourceGroup),character,text:args.text!.trim(),chat_type:1},signal,()=>{guard()})
          if(typeof generated!=='string')throw Error('未取得生成语音')
          // Only a trusted QQ-generated media URL, never a caller supplied file/URL.
          const url=qqMediaUrl(generated).href
          guard()
          sendAttempted=true
          result=await call(channel.id,'send_private_msg',{user_id:Number(route.userId),message:[{type:'record',data:{file:url}}]},signal,()=>{guard()})
        }
        if(!result||!['string','number'].includes(typeof result.message_id)||!String(result.message_id)||Number(result.message_id)===0)throw Error('QQ 未确认语音发送')
        await store.update(state=>{const receipt=state.channels.find(c=>c.id===channel.id)?.qqActivity?.find(r=>r.id===receiptId);if(receipt)receipt.status='confirmed'})
        exec.concludeTurn()
        return {status:'confirmed',originRouteId:route.id,spokenText:args.text!.trim(),messageId:String(result.message_id)}
      } catch {
        await store.update(state=>{
          const current=state.channels.find(c=>c.id===channel.id),receipt=current?.qqActivity?.find(r=>r.id===receiptId)
          if(receipt&&receipt.status!=='confirmed'){
            if(sendAttempted)receipt.status='unknown'
            else current!.qqActivity=current!.qqActivity!.filter(r=>r.id!==receiptId)
          }
        })
        throw Error(sendAttempted?'语音未确认发送，请查看 QQ 实际结果；不要自动重复发送。':'语音合成或地址校验失败，尚未发送消息。私聊支持文字转语音；请核对音色与音色来源群，不能据此判断私聊不支持语音。')
      }
    },
  }
}
