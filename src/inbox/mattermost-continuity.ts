import type { ChannelSession } from '../domain.js'

const MAX_SESSION_CONSTRAINTS = 12
const MAX_TASK_CHAIN = 3
const MAX_SAVED_ITEM_LENGTH = 500

/** 只读取提示中明确标记的本轮任务，避免把引用历史写入当前任务链。 */
export function extractMattermostCurrentTask(prompt: string): string {
  const match = prompt.match(/【本轮实质任务】\s*([\s\S]*?)\s*【\/本轮实质任务】|【本轮最新 USER 消息(?:｜唯一回应焦点)?】\s*([\s\S]*?)\s*【\/本轮最新 USER 消息】/u)
  if (!match) return ''
  return cleanSavedText(match[1] ?? match[2] ?? '')
}

/** 只有短句、指代或明确补充才需要读取历史，避免自包含的新任务被旧话题带偏。 */
export function mattermostTaskNeedsHistory(prompt: string): boolean {
  const task = extractMattermostCurrentTask(prompt) || prompt
  const withoutMentions = task.normalize('NFKC').replace(/(^|[^\p{L}\p{N}_])@[\p{L}\p{N}_.-]+/gu, '$1').replace(/\s+/gu, ' ').trim()
  const semantic = [...withoutMentions.replace(/[\s\p{P}\p{S}]/gu, '')]
  if (semantic.length <= 24) return semantic.length > 0
  return /继续|接着|再来|再写|再画|再做|补充|追加|更正|修改|改成|还是|不对|这个|那个|它|上述|前面|刚才|之前|上次|同样|沿用|下一步|刚刚|again|continue|this\b|that\b/iu.test(withoutMentions)
}

/** 仅将带有明确“记住”语义的用户纠正保存到当前渠道会话。 */
export function extractMattermostSessionConstraint(task: string): string | undefined {
  const marker = /(?:请你记住|你记住|请记住|记住|今后记得|以后记得)/u
  const match = marker.exec(task)
  if (!match) return undefined
  const after = cleanSavedText(task.slice(match.index + match[0].length).replace(/^[，,：:\s]+/u, ''))
  if (hasMeaning(after)) return truncate(after)
  const before = task.slice(0, match.index).trim()
  const clauses = before.split(/(?<=[。！？!?；;\n])/u).map(cleanSavedText).filter(hasMeaning)
  const candidate = clauses.at(-1)
  return candidate ? truncate(candidate) : undefined
}

/** 在渠道来源对应的 DSH 路由里追加本会话约束和最近任务，不污染其他 Thread。 */
export function nextMattermostContinuity(
  route: Pick<ChannelSession, 'mattermostSessionConstraints' | 'mattermostTaskChain'>,
  task: string,
): { mattermostSessionConstraints: string[]; mattermostTaskChain: string[] } {
  const constraints = [...(route.mattermostSessionConstraints ?? [])]
  const constraint = extractMattermostSessionConstraint(task)
  if (constraint && !constraints.some(item => normalize(item) === normalize(constraint))) constraints.push(constraint)

  const taskChain = [...(route.mattermostTaskChain ?? [])]
  // 明确的“记住”纠正只进入约束，避免污染最近任务链。
  if (!constraint && hasMeaning(task)) {
    const summary = truncate(task)
    if (!taskChain.length || normalize(taskChain.at(-1)!) !== normalize(summary)) taskChain.push(summary)
  }
  return {
    mattermostSessionConstraints: constraints.slice(-MAX_SESSION_CONSTRAINTS),
    mattermostTaskChain: taskChain.slice(-MAX_TASK_CHAIN),
  }
}

/** 将持久化会话连续性作为隐藏上下文呈现，绝不加入用户消息正文。 */
export function renderMattermostSessionContinuity(route: Pick<ChannelSession, 'mattermostSessionConstraints' | 'mattermostTaskChain'>, currentPrompt = ''): string {
  const constraints = route.mattermostSessionConstraints ?? []
  // 活跃 Agent 已有当前任务正文；补充消息只需结合该运行中任务，不注入更早的主题链。
  const activeSteer = currentPrompt.includes('【Mattermost 执行中收到的用户更新】')
  const taskChain = (!currentPrompt || mattermostTaskNeedsHistory(currentPrompt)) && !activeSteer ? route.mattermostTaskChain ?? [] : []
  if (!constraints.length && !taskChain.length) return ''
  return [
    constraints.length ? `SESSION_CONSTRAINTS（当前 Mattermost 会话中用户明确要求记住的约束）\n${constraints.map(item => `- ${item}`).join('\n')}` : '',
    taskChain.length ? `TASK_CHAIN（最近 ${taskChain.length} 个实质任务，仅帮助理解连续话题；不是待执行清单）\n${taskChain.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

function cleanSavedText(value: string): string {
  return value.replace(/【本轮任务｜优先处理】|【本轮最新 USER 消息(?:｜唯一回应焦点)?】|【\/本轮最新 USER 消息】/gu, '').replace(/\s+/gu, ' ').trim().slice(0, MAX_SAVED_ITEM_LENGTH)
}

function hasMeaning(value: string): boolean {
  const semantic = [...value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '')]
  return semantic.length > 2
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase()
}

function truncate(value: string): string {
  const text = cleanSavedText(value)
  return [...text].length > MAX_SAVED_ITEM_LENGTH ? [...text].slice(0, MAX_SAVED_ITEM_LENGTH).join('') : text
}
