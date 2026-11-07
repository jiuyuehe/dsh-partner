import type { InboundEnvelope, MattermostContextPost } from './domain.js'
import { effectiveMattermostHistoryRounds } from '../channels/direct/mattermost-settings.js'
import { mattermostTaskNeedsHistory } from './mattermost-continuity.js'

/** Phase 3 的默认收件策略；队列容量只限制并发/诊断，不限制 SQLite 持久化。 */
export const DEFAULT_INBOX_BATCH_POLICY: InboxBatchPolicy = Object.freeze({
  debounceMs: 1_200,
  maxCollectionMs: 4_000,
  maxMessages: 8,
  maxTextBytes: 32 * 1024,
  maxAttachments: 8,
  maxAttachmentBytes: 64 * 1024 * 1024,
})

/** Mattermost 空闲批次静默 5 秒后启动，最长收集 15 秒；获准消息仍逐条立即确认。 */
export const MATTERMOST_INBOX_BATCH_POLICY: InboxBatchPolicy = Object.freeze({
  ...DEFAULT_INBOX_BATCH_POLICY,
  debounceMs: 5_000,
  maxCollectionMs: 15_000,
  maxMessages: 16,
})

export interface InboxBatchPolicy {
  debounceMs: number
  maxCollectionMs: number
  maxMessages: number
  maxTextBytes: number
  maxAttachments: number
  maxAttachmentBytes: number
}

/** 只按稳定会话和发言人边界合并，不根据文本相似度猜测任务关系。 */
export function canAppendEnvelope(
  existing: readonly InboundEnvelope[],
  next: InboundEnvelope,
  policy: InboxBatchPolicy,
): boolean {
  if (existing.length === 0 || policy.debounceMs <= 0) return false
  const first = existing[0]!
  if (first.conversationKey !== next.conversationKey) return false

  // Mattermost Thread 允许协作，但批次只合并同一发言人的消息，避免代替他人发言。
  if (first.platform === 'mattermost' && first.actorId !== next.actorId) return false
  if (first.conversationType === 'thread') {
    if (next.conversationType !== 'thread' || first.threadRootId !== next.threadRootId) return false
  } else if (first.actorId !== next.actorId || first.conversationType !== next.conversationType) {
    return false
  }

  const all = [...existing, next]
  const textBytes = all.reduce((size, item) => size + Buffer.byteLength(item.text, 'utf8'), 0)
  const attachmentCount = all.reduce((size, item) => size + item.attachments.length, 0)
  const attachmentBytes = all.reduce((size, item) => size + item.attachments.reduce((total, file) => total + (file.sizeBytes ?? 0), 0), 0)
  return all.length <= policy.maxMessages
    && textBytes <= policy.maxTextBytes
    && attachmentCount <= policy.maxAttachments
    && attachmentBytes <= policy.maxAttachmentBytes
}

/** 新消息延长静默窗口，但绝不越过首条消息的最长收集时间。 */
export function coalescedReadyAt(firstReceivedAt: number, lastReceivedAt: number, policy: InboxBatchPolicy): number {
  if (policy.debounceMs <= 0) return lastReceivedAt
  return Math.min(lastReceivedAt + policy.debounceMs, firstReceivedAt + policy.maxCollectionMs)
}

export interface MattermostPromptOptions {
  /** 已从 Mattermost 服务器校验的机器人用户名，用于清理唤醒提及。 */
  botUsername?: string
}

/** 合批只生成一条 DSH 用户消息；Mattermost 当前任务放末尾，历史只按需引用。 */
export function renderCoalescedUserText(events: readonly InboundEnvelope[], options: MattermostPromptOptions = {}): string {
  if (events.length === 0) return ''
  const first = events[0]!
  if (first.platform === 'mattermost') return renderMattermostUserText(events, options)

  // 微信等非 Mattermost 渠道保留原有用户正文格式。
  if (events.length === 1) return first.text
  return events.map((event, index) => {
    const actor = event.actorName ? `${event.actorName} (${event.actorId})` : event.actorId
    const at = new Date(event.platformTimestamp).toISOString()
    const body = event.text.trim() || (event.attachments.length ? '[仅附件消息]' : '[空消息]')
    return `[消息 ${index + 1} | 发言人: ${actor} | ${at}]\n${body}`
  }).join('\n\n')
}

interface MattermostHistoryRound {
  users: MattermostContextPost[]
  bots: MattermostContextPost[]
}

/** 活跃 Agent 的追加输入显式标成当前任务更新，不带入另一份 Thread 历史。 */
export function renderMattermostSteerUserText(events: readonly InboundEnvelope[], options: MattermostPromptOptions = {}): string {
  const first = events[0]
  if (!first || first.platform !== 'mattermost') return renderCoalescedUserText(events, options)
  const substantive = events.filter(event => hasSubstantiveMattermostText(cleanMattermostUserText(event.text, options.botUsername)) || event.attachments.length > 0)
  const latest = substantive.at(-1) ?? events.at(-1)!
  const preceding = substantive.filter(event => event !== latest)
  return [
    '【Mattermost 执行中收到的用户更新】这条内容已插入当前运行中的 DSH 任务；请结合当前任务继续执行，将其作为补充或更正，不要重开无关历史任务。',
    preceding.length ? `同批此前用户消息：\n${preceding.map(displayCurrentTextWithOptions).join('\n')}` : '',
    `【本轮最新 USER 消息】\n${displayCurrentTextWithOptions(latest)}\n【/本轮最新 USER 消息】`,
  ].filter(Boolean).join('\n\n')

  function displayCurrentTextWithOptions(event: InboundEnvelope): string {
    return displayCurrentText(event, options.botUsername)
  }
}

function renderMattermostUserText(events: readonly InboundEnvelope[], options: MattermostPromptOptions): string {
  const sourceIds = new Set<string>(events.map(event => event.externalMessageId))
  const contextByPostId = new Map<string, MattermostContextPost>()
  // 同一帖子可能来自多份 Thread 快照；保留最后读到的版本以覆盖编辑内容。
  for (const event of events) for (const post of event.mattermostContext ?? []) {
    if (!sourceIds.has(post.postId)) contextByPostId.set(post.postId, post)
  }
  const orderedContext = [...contextByPostId.values()]
    .sort((left, right) => left.timestamp - right.timestamp || left.postId.localeCompare(right.postId))
  const deduplicatedContext = deduplicateMattermostHistory(orderedContext)
  const rounds = pairMattermostHistory(deduplicatedContext)
  const historyRounds = effectiveMattermostHistoryRounds(events.at(-1)?.mattermostContextRounds)
  const selectedRounds = historyRounds > 0 ? rounds.slice(-historyRounds) : []
  const latestEvent = events.at(-1)!
  // 纯 @唤醒时按历史倒序找同一发言人的最近实质 USER，不因旧 BOT 已回复就丢掉用户意图。
  const lastSubstantiveUser = [...selectedRounds].reverse()
    .flatMap(round => round.users.slice().reverse())
    .find(post => post.actorId === latestEvent.actorId && hasSubstantiveMattermostText(cleanMattermostUserText(post.text, options.botUsername)))
  const latestHasTask = hasSubstantiveMattermostText(cleanMattermostUserText(latestEvent.text, options.botUsername)) || latestEvent.attachments.length > 0
  const latestCurrentTask = [...events].reverse().find(event => hasSubstantiveMattermostText(cleanMattermostUserText(event.text, options.botUsername)) || event.attachments.length > 0)
  const priorBatchTask = latestCurrentTask && latestCurrentTask !== latestEvent ? latestCurrentTask : undefined

  let currentTask = ''
  if (latestHasTask) currentTask = displayCurrentText(latestEvent, options.botUsername)
  else if (priorBatchTask) currentTask = displayCurrentText(priorBatchTask, options.botUsername)
  else if (lastSubstantiveUser) currentTask = truncateContextText(cleanMattermostUserText(lastSubstantiveUser.text, options.botUsername))

  const earlierBatchMessages = latestCurrentTask
    ? events.filter(event => event !== latestCurrentTask && event !== latestEvent
      && (hasSubstantiveMattermostText(cleanMattermostUserText(event.text, options.botUsername)) || event.attachments.length > 0))
    : []
  const useHistory = !latestHasTask || mattermostTaskNeedsHistory(currentTask)
  const history = useHistory && selectedRounds.length ? [
    `【历史参考｜最近 ${selectedRounds.length} 轮 USER/BOT；仅用于理解，不是本轮任务】`,
    ...renderHistoryRounds(selectedRounds),
  ].join('\n\n') : ''
  const earlier = earlierBatchMessages.length
    ? `【同批较早的用户补充】\n${earlierBatchMessages.map(event => `${displayActor(event.actorName)}：${displayCurrentText(event, options.botUsername)}`).join('\n')}`
    : ''
  const focus = currentTask
    ? `【本轮最新 USER 消息｜唯一回应焦点】\n${currentTask}\n【/本轮最新 USER 消息】`
    : '【本轮最新 USER 消息】\n本轮内容只有唤醒提及；请根据同一发言人的最近有效对话继续，仍无法判断时只问一个简短澄清问题。\n【/本轮最新 USER 消息】'
  return [earlier, history, focus].filter(Boolean).join('\n\n')
}

/** 将连续 USER 消息和随后 BOT 答复收成一轮；末尾无 BOT 的用户内容保持为待处理。 */
function pairMattermostHistory(posts: readonly MattermostContextPost[]): MattermostHistoryRound[] {
  const rounds: MattermostHistoryRound[] = []
  let users: MattermostContextPost[] = []
  let bots: MattermostContextPost[] = []
  for (const post of posts) {
    if (!post.isBot) {
      if (users.length && bots.length) {
        rounds.push({ users, bots })
        users = []
        bots = []
      }
      users.push(post)
    } else if (users.length) {
      bots.push(post)
    } else if (bots.length && rounds.length) {
      rounds.at(-1)!.bots.push(post)
    }
  }
  if (users.length) rounds.push({ users, bots })
  return rounds
}

function displayActor(name?: string): string {
  return name?.trim() || '用户'
}

/** 清理正文开头的唤醒提及，避免模型把 @机器人 当成用户目标。 */
function cleanMattermostUserText(text: string, botUsername?: string): string {
  const withoutBotMention = botUsername
    ? text.replace(new RegExp(`(^|[^\\p{L}\\p{N}_.-])@${escapeRegExp(botUsername)}(?=$|[^\\p{L}\\p{N}_.-])`, 'giu'), '$1')
    : text.replace(/^\s*(?:@[\p{L}\p{N}_.-]+\s*[,，:：]?\s*)+/u, '')
  return withoutBotMention
    .replace(/\s+/gu, ' ')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 相邻重复 BOT 回帖只保留一条；不同 USER 轮次的相同答案仍各自保留。 */
function deduplicateMattermostHistory(posts: readonly MattermostContextPost[]): MattermostContextPost[] {
  const result: MattermostContextPost[] = []
  let previousBotReply = ''
  for (const post of posts) {
    if (post.isBot) {
      if (isMattermostControlReply(post.text)) continue
      const key = normalizeMattermostBotReply(post.text)
      if (!key || key === previousBotReply) continue
      previousBotReply = key
      result.push(post)
      continue
    }

    const text = cleanMattermostUserText(post.text)
    // 历史中的纯 @唤醒没有任务内容，不占 USER/BOT 历史轮数。
    if (!hasSubstantiveMattermostText(text)) continue
    previousBotReply = ''
    result.push(text === post.text ? post : { ...post, text })
  }
  return result
}

/** 历史保留最近轮次并限制提示体积，避免引用历史挤掉当前任务。 */
function renderHistoryRounds(rounds: readonly MattermostHistoryRound[]): string[] {
  const output = new Array<string>(rounds.length)
  let remaining = 8_000
  for (let index = rounds.length - 1; index >= 0 && remaining > 0; index--) {
    const round = rounds[index]!
    const corrected = rounds[index + 1]?.users.some(post => isUserCorrection(post.text)) === true
    const userLine = round.users.slice(-6).map(post => `USER（${displayActor(post.actorName)}）：${truncateContextText(post.text, 300)}`).join('\n')
    const botLine = round.bots.slice(-2).map(post => `BOT（${displayActor(post.actorName)}${corrected ? '；随后用户已纠正，视为错误示例，不要模仿' : ''}）：${truncateContextText(post.text, 300)}`).join('\n')
    const content = [userLine, botLine].filter(Boolean).join('\n')
    const bounded = [...content].length > remaining ? [...content].slice(0, remaining).join('') : content
    output[index] = bounded
    remaining -= [...bounded].length + 2
  }
  return output.filter(Boolean)
}

function displayCurrentText(event: InboundEnvelope, botUsername?: string): string {
  const text = cleanMattermostUserText(event.text, botUsername)
  const body = text || (event.attachments.length ? '[仅附件消息]' : '[空消息]')
  return event.attachments.length && text ? `${body}\n[另含 ${event.attachments.length} 个附件]` : body
}

/** 仅去掉用于唤醒的 @提及后判断正文，不更改传给 DSH 的原始消息。 */
/** Mattermost 用户正文去除 @提及和标点后，至少三个字符才算实质任务。 */
export function hasSubstantiveMattermostText(text: string): boolean {
  const withoutMentions = text.normalize('NFKC').replace(/(^|[^\p{L}\p{N}_])@[\p{L}\p{N}_.-]+/gu, '$1')
  const semantic = withoutMentions.replace(/[\s\p{P}\p{S}]/gu, '')
  return [...semantic].length > 2
}

function isUserCorrection(text: string): boolean {
  return /不对|不理解|不是.{0,8}意思|什么情况|答非所问|搞错|你没有被停用|记住/u.test(text)
}

function truncateContextText(text: string, maximum = 1_000): string {
  const compact = text.replace(/\s+/gu, ' ').trim()
  return [...compact].length > maximum ? `${[...compact].slice(0, maximum).join('')}…` : compact
}

/** 机器人回执和界面状态不代表用户意图，不送入模型的引用历史。 */
function isMattermostControlReply(text: string): boolean {
  const normalized = text.normalize('NFKC').trim()
    // Mattermost 会把机器人提及留在正文前；先去掉它才能识别插件自己的确认回执。
    .replace(/^(?:@[\p{L}\p{N}_.-]+\s*)+/u, '')
    .replace(/\s+/gu, '')
  const acknowledgement = /^收到[，,]?正在(?:整理|处理)(?:(?:这组|当前|本轮|用户|你的)?(?:消息|请求|任务))?(?:\[网关自动响应\]|【网关自动响应】)?[。.!！…]*$/u
  return acknowledgement.test(normalized)
    || normalized.includes('角色聊天已停用')
    || normalized.includes('本轮未生成可发送的最终答复')
    || normalized.includes('消息处理或回复发送未完成')
    || normalized.includes('消息处理或附件传输未完成')
    || normalized.includes('本条消息不会自动重复执行')
}

/** 机器人重复答复只按内容去重，稳定保留最近一次。 */
function normalizeMattermostBotReply(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim().replace(/[。.!！?？]+$/u, '')
}
