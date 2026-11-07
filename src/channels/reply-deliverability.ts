import type { PartnerReply } from '../channel-message.js'

/** 持久化渠道批次只有在 Agent 产生可投递内容或已确认自行投递后才能完成。 */
export function hasDeliverableChannelReply(reply: PartnerReply): boolean {
  return reply.alreadyDelivered === true
    || reply.text.trim().length > 0
    || reply.attachments.length > 0
    || (reply.chatParts?.length ?? 0) > 0
}
