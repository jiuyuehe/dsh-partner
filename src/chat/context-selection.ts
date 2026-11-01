import { memoryTerms } from '../memory-retrieval.js'
import type { MemoryRecallContext, UserProfileSnapshot } from '../memory-domain.js'

/** Strip channel scaffolding only for verified QQ routes; never rewrite stored input. */
export function conversationRecallQuery(text: string, qq = false): string {
  let value = text
  if (qq) {
    const header = /^\[QQ 群 \d+ · 发言人 [^\n]*\]\r?\n?/m.exec(value)
    if (header) value = value.slice(header.index + header[0].length)
    value = value.replace(/^渠道图片已保存：[^\n]*(?:\n|$)/gm, '')
  }
  return value.trim()
}

const GENERAL = new Set(['什么','怎么','这个','那个','现在','刚才','自己','可以','不是','就是','还是','没有','一下','已经','时候','觉得','知道','用户','角色','助手','回复','对话','聊天','我们','你们','他们','的是','是的','没关系'])
export function topicMatches(text: string, query: string): boolean {
  const terms = memoryTerms(query).filter(t => t.length >= 2 && !GENERAL.has(t))
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  return terms.some(t => normalized.includes(t))
}

/** Composite persona summaries are not topic-isolated; keep them for explicit recall.
 * Automatically recalled history must not reintroduce old assistant identities. */
export function conversationProfile(profile: UserProfileSnapshot, query: string): UserProfileSnapshot {
  const relevant = (item: UserProfileSnapshot['entries'][number]) =>
    !/助手.*(?:身份|形象|年龄)|角色.*(?:设定|人格|身份|年龄)|人物设定/.test(item.subject)
    && topicMatches(item.subject + ' ' + item.content, query)
  const {persona: _persona, ...rest} = profile
  return {...rest, entries: profile.entries.filter(relevant).slice(0, 4), preferences: (profile.preferences ?? []).filter(relevant).slice(0, 4)}
}

export function dreamContextRequested(query: string, _autonomous: boolean): boolean {
  // Autonomous origin alone is not a topic: do not promote dreams above chat history.
  return /梦|dream/i.test(query)
}

export function conversationMemories(recall: MemoryRecallContext, query: string): MemoryRecallContext {
  const relevant = recall.relevant.filter(item => topicMatches(item.subject + ' ' + item.content, query))
  const ids = new Set(relevant.map(item => item.id))
  return {...recall, relevant,
    connections: recall.connections.filter(c => ids.has(c.source.id) && topicMatches(c.target.subject + ' ' + c.target.content, query)),
    scenes: (recall.scenes ?? []).filter(s => topicMatches(s.title + ' ' + s.summary, query)),
    profile: conversationProfile(recall.profile, query)}
}
