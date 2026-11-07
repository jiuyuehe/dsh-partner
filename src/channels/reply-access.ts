import { qqGroupPeer, qqSettings, type QqSettings } from './qq/settings.js'

interface ReplyAccessState {
  channels: readonly {id:string;enabled:boolean;platform?:string;qq?:Partial<QqSettings>;direct?:{targetId:string;allowedChannelIds?:readonly string[]}}[]
  pairings: readonly {channelId:string;userId:string;status:string;directTargetId?:string;allowedChannelIds?:readonly string[]}[]
}

/** Group membership is encoded by the verified channel peer, never message text.
 * A whitelisted QQ group grants chat access; other connected groups require member approval. */
export function channelReplyAllowed(
  state: ReplyAccessState,
  channelId:string,
  userId:string,
  targetId?:string,
  conversationType:'dm'|'channel'|'thread'='dm',
  isChannelConversation=false,
):boolean {
  const channel=state.channels.find(c=>c.id===channelId)
  if(!channel?.enabled)return false
  const pairing=state.pairings.find(p=>p.channelId===channelId&&p.userId===userId)
  if (channel.platform === 'mattermost') {
    if (isChannelConversation) {
      return conversationType !== 'dm'
        && !!targetId && channel.direct?.allowedChannelIds?.includes(targetId) === true
        && pairing?.allowedChannelIds?.includes(targetId) === true
    }
    // Mattermost 的 DM 必须同时匹配已批准联系人和实际 DM channel ID；空目标不做通配授权。
    const directTarget = targetId ?? channel.direct?.targetId
    return pairing?.status === 'approved' && !!directTarget && pairing.directTargetId === directTarget
  }
  if(channel.platform==='qq') {
    const settings=qqSettings(channel.qq),group=qqGroupPeer(userId)
    if(group) {
      const target=`group:${group.groupId}`
      return settings.groupReplies&&settings.groupIds.includes(group.groupId)&&pairing?.status!=='blocked'
        &&(settings.autonomousGroupIds.includes(group.groupId)||pairing?.status==='approved')
        &&(!channel.direct?.targetId||channel.direct.targetId===target)
        &&(!targetId||targetId===target)&&(!pairing?.directTargetId||pairing.directTargetId===target)
    }
    if(!settings.privateReplies)return false
  }
  return pairing?.status==='approved'&&(!targetId||!pairing.directTargetId||pairing.directTargetId===targetId)
}

/** Preserve direct-room routing; QQ group replies need no synthetic per-member grant. */
export function directReplyTarget(state:ReplyAccessState, channelId:string, userId:string):string {
  const channel=state.channels.find(c=>c.id===channelId)
  const group=channel?.platform==='qq'?qqGroupPeer(userId):undefined
  return channel?.direct?.targetId || (group?`group:${group.groupId}`:state.pairings.find(p=>p.channelId===channelId&&p.userId===userId)?.directTargetId) || ''
}
