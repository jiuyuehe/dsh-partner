import { ChannelActivityRegistry } from './activity-registry.js'
import { qqActivityProvider } from './qq/activity-provider.js'

/** Transport-independent conversation capability plus channel-specific providers. */
export function createChannelActivities(onError?: (provider:string,error:unknown)=>void): ChannelActivityRegistry {
  const registry = new ChannelActivityRegistry(onError)
  registry.register({id:'conversation',platform:'*',discover:({sessions})=>sessions.length ? [{
    id:'conversation',title:'与已授权会话交流',tool:'partner_chat_reply',visibility:'public',
    description:'有想分享的内容时，可通过 partner_thoughts 查看已授权目标并安排对应会话的后续活动；partner_chat_reply 只回复当前活动会话，不因本目录而转发到其他渠道。文字、分段和表情沿用渠道设置。',
  }] : []})
  registry.register(qqActivityProvider)
  return registry
}
