import type { ChannelActivity, ChannelActivityProvider } from '../activity-registry.js'
import { qqSettings } from './settings.js'
import { QQ_ACTIONS, QQ_ACTION_CATEGORIES } from './action-catalog.js'
import { QQ_PUBLIC_CHAT_ACTIONS, QQ_PUBLIC_SCOPED_ACTIONS } from './chat-actions.js'

/** QQ owns its discovery policy; actual execution remains in partner_qq's live guards. */
export const qqActivityProvider: ChannelActivityProvider = {
  id: 'qq.capabilities', platform: 'qq',
  discover({channel}) {
    const settings = qqSettings(channel.qq)
    const actions = QQ_ACTIONS.filter(a => settings.enabledActions.includes(a.id) &&
      (settings.autonomousActions || QQ_PUBLIC_CHAT_ACTIONS.has(a.id) && !QQ_PUBLIC_SCOPED_ACTIONS.has(a.id)))
    return QQ_ACTION_CATEGORIES.flatMap(category => (['public','private'] as const).flatMap(visibility => {
      const operations = actions.filter(a => a.category === category.id && (QQ_PUBLIC_CHAT_ACTIONS.has(a.id) ? 'public' : 'private') === visibility).map(a => a.id)
      if (!operations.length) return []
      const activity: ChannelActivity = {id:category.id+'.'+visibility,title:category.title,tool:'partner_qq',visibility,operations,
        description:'通过 partner_tools describe 查询 partner_qq，再用其 list/describe/call 按 channelId 和具体操作执行。仅列出配置中的能力，执行仍核验当前授权、目标范围和审批；不代表自动发布或联系任何人。'}
      return [activity]
    }))
  },
}
