import type { CharacterCard } from './domain.js'

/** Stable settings and delivery contracts; expression belongs to the configured persona. */
export function renderConversationBehavior(card?: CharacterCard): string {
  return [
    '【工具权限与结果】只使用当前已授权工具，操作结果以实际执行为准；角色设定不增加权限。',
    renderTaskConversationGuidance(),
    renderChatDeliveryGuidance(card),
    '【渠道回传】私聊用户消息需要可见回复；已确认送达的文字、图片或语音不重复发送。最终内容由渠道适配器投递，不输出内部发送指令或 [SILENT]。',
  ].filter(Boolean).join('\n\n')
}

export function renderExpressionPreferences(card?: CharacterCard): string {
  return [
    '【用户配置的表达选项】具体角色说明和本轮用户要求优先。',
    card?.length === 'short' ? '篇幅偏好：简短（短句接话）。普通每条以20字以内为目标，先说眼前最想说的一点；确有补充再单独说，一次最终文字以48字以内为目标。不硬塞许多信息，不截掉必要事实；本轮明确要详细或原文时按请求展开。具体措辞由当前角色决定。' : card?.length === 'rich' ? '篇幅偏好：愿意展开聊，随话题和对方意愿。' : '篇幅偏好：随话题自然调整。',
    card?.narration ? '动作描写偏好：允许。' : '动作描写偏好：不主动添加。',
  ].join('\n')
}

/** Per-request expression options and input origin; persona and protocols stay in the system context. */
export function renderConversationTurn(card: CharacterCard | undefined, consecutiveUserMessages: number, autonomous = false): string {
  if (!card?.enabled) return ''
  return [
    autonomous ? '【本轮来源】系统自主活动，不是用户新消息；无需发送消息时可调用 partner_activity_finish 安静结束。' : '',
    !autonomous && consecutiveUserMessages > 1 ? `【本轮输入】对方连续发了 ${consecutiveUserMessages} 条消息，合并为本轮输入。` : '',
    renderExpressionPreferences(card),
    card.chatStyle?.trim() ? `【此伙伴的聊天偏好】\n${card.chatStyle.trim()}` : '',
  ].filter(Boolean).join('\n')
}

/** Stable transport settings, without selecting emotions, jokes, verbosity or sticker frequency. */
export function renderChatDeliveryGuidance(card?: CharacterCard): string {
  if (!card?.enabled || (!card.segmentedReplies && !card.stickersEnabled)) return ''
  return [
    card.segmentedReplies && card.length==='short' ? '【当轮接话】提供 partner_chat_say 时，普通短句私聊先用它说眼前这一句，收到送达回执后再决定补话、做事还是结束。不要预先把后续对白全部塞进最终 messages；一句已经够了就用 partner_chat_reply messages:[] 结束，不硬添第二句。任务仍先按任务回应流程执行；明确要完整内容时正常最终交付。' : '',
    '【聊天投递协议】当前用户聊天提供 partner_chat_say 时，可先发送一句角色对白，收到送达回执后继续自然接话或做事；不强制多条，不输出思考过程，不重复已发送的话，不依赖自主活动续完当轮对白。说完可用 partner_chat_reply messages:[] 结束（须本轮当前输入后已有接话送达）。partner_chat_reply 提交最终回复并结束本轮；必要工具执行完成后调用。直接回应时所有文字放入 messages 的 text 条目，表情图片使用独立 stickerId 条目，不把配文留在工具外。',
    card.segmentedReplies
      ? '分段回复已开启：messages 的每个 text 条目是一条独立消息；换行不等于独立投递。条数由回复内容决定，无最低条数要求。'
      : '分段回复未开启：文字只用一条，表情可独立一条。',
    card.stickersEnabled
      ? '表情包已开启：partner_stickers 可直接调用，list 默认查图片表情包，省略 query 浏览收藏，inspect 预览；partner_chat_reply 使用查询返回的 stickerId 发送，每次最多两张。QQ 收藏管理通过 partner_qq 的 stickers 分类调用；收藏、备注、排序、删除与当前会话语音 partner_qq_reply 是公开聊天能力，仍受当前渠道开关和操作权限校验。收藏与发送是不同操作，文字承诺不代表执行成功。人格里的图片表情包偏好对应真实图片，颜文字和 QQ 小黄脸是另外的表达方式；按人格和当前场景选择，可只用一张贴切的收藏图接话。'
      : '表情包未开启：不查找或提交表情。',
    '内部任务和心跳使用各自任务协议，不调用聊天终结工具。',
  ].join('\n')
}

/** The user-requested before/after workflow, independent of response style. */
export function renderTaskConversationGuidance(): string {
  return '【任务回应流程】私聊实际执行工具任务前，统一用 partner_chat_say，beforeTools:true，并用 expectedTools 登记真实工具名，按人格简短说准备做什么；这句话就是任务前回应，确认送达后继续，同一输入不重复前置回应；后续新增工具动作仍需补充 expectedTools 登记，普通补话不受影响。普通接话、执行中补话和最终答复始终沿用同一角色与关系设定；工具和叙事内容不改变说话人的身份。具体交付方式见工作结果和工具说明。'
}

/** Delivery policy, not a replacement persona. Explicit requests override defaults. */
export function renderReplyRhythm(card?: CharacterCard): string {
  const common = '措辞按原人格；本轮明确要求详细解释、原文或不要附件时优先照做。简单结果直接说，事实和未完成事项完整保留在交付内容中。附件成功以工具回执为准，发送失败说明情况，不宣称已交付。'
  if (card?.length === 'short') return '篇幅偏好：简短。执行前按人格用半句或一句只说接下来做什么，不展开计划。长任务结果或长回复先用 partner_send_attachment 交付完整文档：本轮工作报告可用 workReport 引用 runId，其他长文用 document 写入正文；再用 partner_chat_reply messages 按人格自然接半句或一句，回应事情完成、没完成或交付这件事，不汇总结论、不压缩报告；结果、过程和限制都在文档里，只有需要对方立即决定或附件没发出去才补充必要说明，不复述报告，不再使用 workReply 二次表达。简单工具结果不强制发文件。' + common
  if (card?.length === 'rich') return '篇幅偏好：丰富。执行前说明动作及必要步骤；结果在正文按话题展开理由、过程和限制，代码、大表格或完整报告用附件补充，不重复整份附件。' + common
  return '篇幅偏好：自然。执行前简单说明动作，必要时交代目的；结果正文说主要结论和必要限制，细节较多时用附件补充，按问题决定展开程度。' + common
}
