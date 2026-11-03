import type { ThoughtService } from './character/thoughts.js'
import type { InteractionReviewService } from './character/interaction-review.js'
import { renderQqIdentityRelation } from './channels/qq/identity-binding.js'
import { characterStateReflectionPrompt } from './character/state-policy.js'
import { normalizeReflectedCharacterState } from './character/domain.js'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Companion } from './domain.js'
import { concernSubjectSimilarity, extractConcernResources, type ConcernCandidate, type ConcernWatchKind, type PartnerConcern } from './concern-domain.js'
import type { ConversationTurn, DailyReviewResult, DailyReviewTarget, MemoryCandidate, MemoryKind, MemoryRelationKind, ReflectionResult } from './memory-domain.js'
import type { PartnerMemoryStore } from './memory-store.js'
import type { PartnerConcernStore } from './concern-store.js'
import { canonicalProfileSubject } from './profile-domain.js'
import { dailyReviewPromptInput, reflectionPromptInput } from './memory-prompt-context.js'
import { groundMemoryCandidates, requireGroundedMemories } from './memory-quality.js'
import { groundExperiences, parseArtifactProposals } from './memory-artifacts.js'
import { AsyncSemaphore } from './core/semaphore.js'
import type { MemoryJob } from './memory-journal.js'
import {redactObservationError} from './observation-errors.js'
import {memoryFinishError} from './memory-errors.js'

type ReflectionContext = Context & { llm: Context['llm']; agentDefaultModel: AgentDefaultModelConfig }

export class MemoryReflectionService {
  private readonly running = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private readonly modelSlots = new AsyncSemaphore(1)
  private readonly lastPruned = new Map<string, number>()
  private closed = false
  close(): void { this.closed = true; for (const controller of this.controllers) controller.abort(); this.lastPruned.clear() }
  constructor(private readonly ctx: ReflectionContext, private readonly store: PartnerMemoryStore, private readonly concerns: PartnerConcernStore, private readonly interactionReview?: InteractionReviewService, private readonly thoughts?: ThoughtService) {}

  async reflect(companion: Companion, turn: ConversationTurn): Promise<PartnerConcern[]> {
    if (this.closed) throw new Error('memory service is stopping')
    if (turn.companionId !== companion.id) throw new Error('memory turn owner mismatch')
    await this.store.enqueue(turn)
    return []
  }

  isRunning(companionId: string): boolean { return this.running.has(companionId) }

  async processPending(companion: Companion, notify?: (scopeId: string, created: PartnerConcern[]) => Promise<void>): Promise<{ scopeId: string; created: PartnerConcern[] } | undefined> {
    if (this.closed || this.running.has(companion.id)) return undefined
    this.running.add(companion.id)
    try {
      return await this.modelSlots.use(async () => {
        if (this.closed) return undefined
        const job = await this.store.claimJob(companion.id)
        return job ? this.processJob(companion, job, notify) : undefined
      })
    } finally { this.running.delete(companion.id) }
  }

  private async processJob(companion: Companion, job: MemoryJob, notify?: (scopeId: string, created: PartnerConcern[]) => Promise<void>): Promise<{ scopeId: string; created: PartnerConcern[] }> {
    try {
      const result = job.result ?? await this.extract(companion, job.turn, job.repair)
      if (!job.result) await this.store.checkpointJob(job, result)
      if (job.repair) {
        await this.store.restoreProfileJob(job, result)
        await this.store.settleJob(job)
        return { scopeId: job.turn.scopeId, created: [] }
      }
      await this.store.consolidate(job.turn, result, job)
      if (result.thought) await this.thoughts?.apply(job.turn, result.thought)
      if (result.interactionReview) await this.interactionReview?.apply(job.turn, result.interactionReview)
      const created = await this.applyConcerns(companion, job.turn, result)
      if (created.length && notify) await notify(job.turn.concernScopeId ?? job.turn.scopeId, created)
      await this.store.settleJob(job)
      if (Date.now() - (this.lastPruned.get(companion.id) ?? 0) > 6 * 60 * 60_000) {
        try {
          await this.store.prune(companion.id, companion.automation.memory.retentionDays)
          this.lastPruned.set(companion.id, Date.now())
        } catch { this.ctx.logger.warn('dsh-partner: memory maintenance failed; will retry on the next completed job') }
      }
      return { scopeId: job.turn.concernScopeId ?? job.turn.scopeId, created }
    } catch (error) {
      await this.store.settleJob(job, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  async reviewDay(companion: Companion, target: DailyReviewTarget): Promise<PartnerConcern[]> {
    if (this.closed) throw new Error('memory service is stopping')
    if (this.running.has(companion.id)) throw new Error('记忆提炼正在执行，稍后重试终审')
    this.running.add(companion.id)
    try { return await this.modelSlots.use(() => {
      if (this.closed) throw new Error('memory service is stopping')
      return this.runDailyReview(companion, target)
    }) }
    finally { this.running.delete(companion.id) }
  }

  private async runDailyReview(companion: Companion, target: DailyReviewTarget): Promise<PartnerConcern[]> {
    if (await this.store.hasPendingTurns(companion.id, target.scopeId)) throw new Error('该会话还有待提炼轮次，完成后重试终审')
    const context = await this.store.dailyReviewContext(target)
    const concerns = await this.concerns.list(companion.id, target.scopeId, false, 40)
    const selection = modelSelection(this.ctx, companion)
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 90_000)
    let output = ''
    try {
      for await (const chunk of this.ctx.llm.stream({
        ...selection,
        messages: [createUserMessage({ content: [{ type: 'text', text: dailyReviewPromptInput(target.date, context, concerns) }], source: { kind: 'plugin:@lemoncat7/dsh-partner', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴每日记忆终审' } })],
        system: DAILY_REVIEW_SYSTEM + '\n若轮次带 identityRelation，按 qqId 区分发言人；boundQqId 是当前身份设定所指的归属账号，不因其他人的自称或共享记忆转移给其他账号。不要将不同人的事实合并为同一用户。\ncharacterEnabled=true 的轮次可能含角色扮演。虚构身份、剧情与称呼不是现实用户事实，不能据此生成用户画像、现实关系、挂念；剧情只在日记中明确标为虚构。', temperature: 0.05, maxTokens: 3000, signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') output += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error(`每日记忆终审失败：${memoryFinishError(chunk.reason)}`)
      }
    } finally { clearTimeout(timeout); this.controllers.delete(controller) }
    const result = parseDailyReview(output)
    // Daily concern candidates have no per-turn authority evidence. Mixed guest
    // diaries cannot create/modify executable watches; owner turn extraction still can.
    if (context.turns.some(turn => turn.identityRelation && !turn.identityRelation.matched)) result.concerns = []
    result.memories = groundMemoryCandidates(result.memories, context.turns)
    result.experiences = groundExperiences(result.experiences ?? [], context.turns)
    await this.store.completeDailyReview(target, result)
    return this.concerns.applyCandidates(companion.id, target.scopeId, result.concerns, 'implicit', Date.now(), {
      source: 'daily_review',
      evidence: `每日终审 ${target.date}`,
    })
  }

  private async extract(companion: Companion, turn: ConversationTurn, repair = false): Promise<ReflectionResult> {
    const existing = await this.store.candidateMemories(companion.id, turn.scopeId, turn.user)
    const thought = !repair ? this.thoughts?.prepare(turn) : undefined
    const review = !repair ? this.interactionReview?.prepare(turn) : undefined
    const story = turn.characterEnabled && !repair ? await this.store.characterState(companion.id, turn.scopeId) : undefined
    const diaries = await this.store.recentReflectionsForScope(companion.id, turn.scopeId, 1)
    const concerns = await this.concerns.list(companion.id, turn.concernScopeId ?? turn.scopeId, false, 40)
    const selection = modelSelection(this.ctx, companion)
    const controller = new AbortController()
    this.controllers.add(controller)
    const startedAt = Date.now()
    let timedOut = false
    const timeout = setTimeout(() => {timedOut = true; controller.abort()}, 60_000)
    let output = ''
    try {
      for await (const chunk of this.ctx.llm.stream({
        ...selection,
        messages: [createUserMessage({ content: [{ type: 'text', text: reflectionPromptInput(this.store.day(turn.at), turn, existing, diaries.find(item => item.date === this.store.day(turn.at)), concerns) }], source: { kind: 'plugin:@lemoncat7/dsh-partner', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴记忆提炼' } })],
        system: REFLECTION_SYSTEM + '\n' + renderQqIdentityRelation(turn.identityRelation) + (story ? characterStateReflectionPrompt(story) : '') + (review?.prompt ?? '') + (thought?.prompt ?? '') + (repair ? '\n本次是历史画像修复：只输出有原话证据的 profile/preference upsert。不要生成任务、事件、挂念或撤销操作；concerns 返回空数组。不能把助手的话当用户事实。' : ''),
        temperature: 0.1,
        maxTokens: review || thought ? 3000 : 1800,
        signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') output += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error(memoryFinishError(chunk.reason))
      }
    } catch(error) {
      const cause = timedOut ? '达到60秒模型时限' : this.closed ? '服务停止，任务保留' : redactObservationError(error instanceof Error ? error.message : String(error))
      throw new Error(`记忆提炼失败：${cause}；耗时${Math.round((Date.now()-startedAt)/1000)}秒，正文${output.length}字`)
    } finally { clearTimeout(timeout); this.controllers.delete(controller) }
    const result = parseReflection(output, true)
    if (review || thought) {
      const payload = JSON.parse(output.match(/\{[\s\S]*\}/)![0]) as Record<string, unknown>
      if (review) result.interactionReview = {request:review.request, evaluation:payload.interactionReview ?? null}
      if (thought) result.thought = {sourceRouteIds:thought.sourceRouteIds, value:payload.thought ?? null}
    }
    if (!story) delete result.characterState
    // Shared state must not reassign the bound relationship after a different QQ member speaks.
    if (story && result.characterState && turn.identityRelation && !turn.identityRelation.matched) result.characterState.relationship = story.relationship
    result.memories = requireGroundedMemories(result.memories, [turn])
    return result
  }

  private async applyConcerns(companion: Companion, turn: ConversationTurn, result: ReflectionResult): Promise<PartnerConcern[]> {
    if (turn.identityRelation && !turn.identityRelation.matched) return []
    const resources = extractConcernResources(turn.user)
    const reflected = protectConcernDirective(result.concerns, turn.concernDirective)
    const candidates = resources.length === 0 ? reflected : reflected.map(item => item.operation === 'upsert' ? { ...item, resources } : item)
    const origin = explicitConcernDirective(turn.user) ? 'explicit' : 'implicit'
    const created = await this.concerns.applyCandidates(companion.id, turn.concernScopeId ?? turn.scopeId, candidates, origin, turn.at, {
      source: 'reflection', sessionId: turn.sessionId, evidence: turn.user, batchId: turn.id,
    })
    const current = await this.concerns.list(companion.id, turn.concernScopeId ?? turn.scopeId, true, 1000)
    if (turn.concernDirective !== undefined && current.some(item => item.id === turn.concernDirective?.concernId)) {
      await this.concerns.act(companion.id, turn.concernDirective.concernId, turn.concernDirective.action, turn.at)
    }
    return origin === 'implicit' ? created.filter(item => current.some(latest => latest.id === item.id && ['watching', 'active'].includes(latest.state))) : []
  }
}

export function protectConcernDirective(
  candidates: ConcernCandidate[],
  directive: ConversationTurn['concernDirective'],
): ConcernCandidate[] {
  return directive === undefined
    ? candidates
    : candidates.filter(item => item.operation !== 'upsert' || concernSubjectSimilarity(item.subject, directive.subject) < .74)
}

export function explicitConcernDirective(value: string): boolean {
  const text = value.normalize('NFKC').toLocaleLowerCase('zh-CN')
  if (/(?:不要|不用|无需|别|取消|停止).{0,12}(?:关注|留意|盯着|跟进|惦记|记着)/u.test(text)) return false
  return /(?:请|麻烦|帮我|替我|让(?:伙伴|你)?).{0,24}(?:关注|留意|盯着|跟进|惦记|记着)/u.test(text)
    || /^(?:持续|继续|长期|定期)?\s*(?:关注|留意|盯着|跟进|追踪)(?:一些|一下|这些|这个|下|\s|[\p{L}\p{N}])/u.test(text.trim())
    || /(?:有|出现)(?:新)?(?:变化|更新|进展|消息).{0,8}(?:告诉我|通知我|提醒我)/u.test(text)
    || /(?:关注|留意|盯着|跟进|惦记).{0,24}(?:一下|这件事|这个|这些)/u.test(text)
    || /(?:keep\s+an?\s+eye\s+on|watch|track|follow).{0,80}(?:for\s+me|this|these)/iu.test(text)
}

function modelSelection(ctx: ReflectionContext, companion: Companion): { provider: string; model: string } {
  return {
    ...ctx.agentDefaultModel.currentSelection(),
    ...(companion.provider ? { provider: companion.provider } : {}), ...(companion.model ? { model: companion.model } : {}),
    ...(companion.automation.memory.provider ? { provider: companion.automation.memory.provider } : {}),
    ...(companion.automation.memory.model ? { model: companion.automation.memory.model } : {}),
  }
}

const MEMORY_QUALITY_RULES = `梦境、想象和角色主观联想不是用户真实经历，不能因为助手提到梦而写成事实记忆。记忆写入契约：每个 memories 候选（包括 complete/remove）必须附 evidenceQuote（用户原话的连续引用，2-300 字）和 sourceTurnId（该原话所在轮次 id），不能引用助手回答或日记摘要；无证据则不输出。更新同义旧记忆时附 targetMemoryId，必须是输入中的同类型记忆 id，并沿用原 subject；不要凭标题相似合并不同项目或相反偏好。纠错时 confidence 应反映新证据，允许降低。一次性执行请求和过程细节只进 daily，不新增 task；task 仅保留明确跨轮次未完承诺，已有任务完成仍应 complete。持续观察交 concerns，项目技术正文交知识库，记忆不复制整篇资料。emotion 仅限用户明确自述感受，不得把催促、设计反馈或工作要求当情绪。长期偏好、画像默认不设 expiresInDays，只有用户明确有效期时才设置。`

function memoryCandidateContract(): string {
  return `memories 每项必须包含完整字段，例如：{"kind":"profile","subject":"常用环境","content":"用户日常使用 macOS。","confidence":0.95,"importance":0.8,"operation":"upsert","evidenceQuote":"我平时用 macOS","sourceTurnId":"复制输入中对应的 id"}。该例仅说明格式，不是待记录事实。evidenceQuote 必须来自输入 user 的连续原话，不能包含压缩标记省略号；sourceTurnId 取 newTurn.id 或 turns[].id。targetMemoryId 仅更新已有记忆时填写；长期画像和偏好不要填写 expiresInDays。用户明确陈述的长期背景和明确的长期协作偏好，应当及时提炼，不要求先重复多次；不能从临时任务推断身份。`
}

const REFLECTION_SYSTEM = `你是长期伙伴的记忆整理器。你不回答用户，只从有证据的对话中维护每日回顾和结构化记忆。优先保留稳定偏好、明确要求记住的事实、重要约定和有后续价值的进展；闲聊、问候、一次性查询、工具过程和重复事实不新增长期条目，无值得保留的信息时 memories 和 concerns 返回空数组。记忆不是聊天流水账。
${MEMORY_QUALITY_RULES}
${memoryCandidateContract()}
只输出一个 JSON 对象，不要 Markdown。格式：
{"daily":{"summary":"当天截至当前的简洁总结","events":[],"openTasks":[],"completedTasks":[],"learnings":[]},"memories":[{"kind":"profile|preference|task|event|relationship|emotion","subject":"稳定且简短的索引主题","content":"带场景边界的准确内容","confidence":0.9,"importance":0.8,"operation":"upsert|complete|remove","evidenceQuote":"用户连续原话","sourceTurnId":"newTurn.id"}],"concerns":[{"subject":"尚未闭环的具体事情","reason":"为什么伙伴应该继续惦记","operation":"upsert|resolve|dismiss","priority":0.0,"confidence":0.0,"watchKind":"auto|knowledge|workspace|web","watchQuery":"用于观察变化的具体对象或问题"}]}
规则：
1. 不把寒暄、模型猜测、助手自述当成用户事实；没有长期价值时 memories 返回空数组。
2. 偏好必须保留适用场景和例外；任务只记录用户明确提出或双方明确承诺的事项。
3. emotion 只是短期信号，必须设置 1-7 天过期，不做心理诊断。
4. profile 表示伙伴从用户明确陈述中形成的长期人物理解，只能使用“基本身份、工作背景、长期职责、常用环境、长期目标”五个 subject。普通喜好归 preference，临时任务、情绪和事件不得写入画像。
5. 不根据语气或单次行为推断职业、性格、健康、财务、政治、宗教、亲密关系等敏感或隐私事实。profile 必须有明确用户证据；不确定时不要输出。建议 confidence 至少 0.72、importance 至少 0.55。
6. 与已有记忆同主题时沿用 subject；用户纠正旧理解时用 upsert 替换，撤销时 remove，任务完成时 complete。不得用相近措辞创建第二条同槽位画像。
7. concerns 只表示有用户原话证明会延续到当前轮次之后的具体事情：持续未解决、临时方案、等待外部结果、反复不满意或用户明确要求持续留意。一次性资料收集、网页搜索、总结、翻译、写作、即时执行和普通问答一律不产生 concern，即使话题本身很重要；不得仅凭主题推测用户以后还想关注。特别是“又出错了，修复一下”“还没生成完，去排查”仍是工作请求，不是持续关注；已有看板或续接计划负责的进度不要另建关注。没有持续性证据时 concerns 返回空数组。
8. 已有关注由伙伴自主维护，不需要用户使用固定授权措辞。根据新进展、影响与相关性调整 priority（关注度，0–1），允许升高或降低：>=0.8 重点关注，>=0.4 持续跟进，否则暂时观察；隐式关注低于0.18会归档。沿用同一 subject，用 reason 说明具体调整依据；不能仅因时间流逝或没提及降温。用户置顶/停止的 control 不能覆盖。明确交代的事项不能因降温 dismiss，核实解决可 resolve。watchKind 按来源选择；一次性任务不新增关注。
9. daily 应综合已有当日日记与新对话，不能只复述最后一句。数组每类最多 20 条，记忆候选最多 12 条。`

const DAILY_REVIEW_SYSTEM = `你是长期伙伴的每日记忆终审器。根据当天每一轮对话的双向代表片段、滚动回顾和已有记忆，输出一次最终整理，不回答用户。
${MEMORY_QUALITY_RULES}
${memoryCandidateContract()}
还可输出 scenes:[{"title":"具体项目或场景名称","memoryIds":["输入中已有的记忆 id"]}]，每个场景只关联同一项目的有效事实，最多 8 个，不把不同项目因名称相似而混在一起；无可靠关联返回空数组。
还可输出 experiences:[{"title":"可复用方法","steps":["带适用条件的操作步骤"],"evidence":[{"turnId":"原始轮次 id","quote":"用户明确确认成功的连续原话"}]}]。只有至少两个不同会话均有用户明确确认成功，且方法确实可复用时才提出，最多 3 个；重复尝试、反复失败、助手自称成功均不算。这里只生成待人工审核的草稿，不安装、不授权、不修改现有 Skill。没有足够证据返回空数组。
只输出 JSON：{"daily":{"summary":"","events":[],"openTasks":[],"completedTasks":[],"learnings":[]},"memories":[与逐轮提炼相同的候选格式],"concerns":[与逐轮提炼相同的挂念格式],"relations":[{"sourceSubject":"必须等于已有或候选记忆主题","sourceKind":"profile|preference|task|event|relationship|emotion","targetSubject":"必须等于已有或候选记忆主题","targetKind":"同上","kind":"supports|depends_on|about|conflicts_with|follows","label":"有证据的简短关系说明","confidence":0.0,"operation":"upsert|remove"}]}
要求：合并重复理解；人物画像只使用“基本身份、工作背景、长期职责、常用环境、长期目标”五个稳定槽位，并遵守逐轮提炼中的画像证据与隐私规则；结合所有轮次片段纠正逐轮偏差，对被压缩而证据不足的细节保持原状而非猜测；明确任务完成状态；复核并关闭已经完成或失效的挂念；只有对话原文证明事情会延续到当前轮次之后时才能新增挂念，一次性资料收集、搜索、总结、写作、即时执行和普通问答不得新增挂念；不创造对话中没有的事实；relations 只输出需要新增、更新或明确移除的关系，已有且仍成立的关系无需重复；关系两端必须填写准确 kind，upsert 必须有对话证据且 confidence 至少 0.62；remove 用于已有关系已被纠正或失效；conflicts_with 只用于无法同时为真的明确矛盾，不能把普通差异标成冲突；关系最多 80 条；无变化时 relations 返回空数组。`

export function parseReflection(raw: string, strict = false): ReflectionResult {
  const match = raw.trim().match(/\{[\s\S]*\}/)
  if (!match) throw new Error('memory reflection returned no JSON object')
  const value = JSON.parse(match[0]) as Record<string, unknown>
  const daily = record(value.daily)
  const memories = Array.isArray(value.memories) ? value.memories.map(parseCandidate).filter((item): item is MemoryCandidate => item !== undefined).slice(0, 12) : []
  if (strict && value.memories !== undefined && (!Array.isArray(value.memories) || value.memories.length !== memories.length)) {
    throw new Error('记忆候选格式无效：请使用支持的类型、画像主题及完整字段；将自动重试')
  }
  const concerns = Array.isArray(value.concerns)
    ? value.concerns.map(parseConcern).filter((item): item is ConcernCandidate => item !== undefined)
    : []
  return {
    daily: {
      summary: string(daily.summary, 1200), events: stringArray(daily.events), openTasks: stringArray(daily.openTasks),
      completedTasks: stringArray(daily.completedTasks), learnings: stringArray(daily.learnings),
    },
    memories,
    concerns,
    ...(value.characterState === undefined ? {} : { characterState: normalizeReflectedCharacterState(value.characterState) }),
  }
}

function parseConcern(value: unknown): ConcernCandidate | undefined {
  const item = record(value)
  if (item.operation !== 'upsert' && item.operation !== 'resolve' && item.operation !== 'dismiss') return undefined
  const subject = string(item.subject, 300)
  const watchKind = item.watchKind
  if (!subject || !isWatchKind(watchKind)) return undefined
  return {
    subject, reason: string(item.reason, 800), operation: item.operation,
    priority: number(item.priority), confidence: number(item.confidence), watchKind,
    watchQuery: string(item.watchQuery, 500) || subject,
  }
}

function isWatchKind(value: unknown): value is ConcernWatchKind { return value === 'auto' || value === 'knowledge' || value === 'workspace' || value === 'web' }

export function parseDailyReview(raw: string): DailyReviewResult {
  const base = parseReflection(raw)
  const match = raw.trim().match(/\{[\s\S]*\}/)
  const value = match ? JSON.parse(match[0]) as Record<string, unknown> : {}
  const relations = Array.isArray(value.relations) ? value.relations.flatMap(item => {
    const relation = record(item); const kind = relation.kind
    if (!isRelationKind(kind)) return []
    const sourceSubject = string(relation.sourceSubject, 120); const targetSubject = string(relation.targetSubject, 120); const label = string(relation.label, 120)
    const operation: 'upsert' | 'remove' = relation.operation === 'remove' ? 'remove' : 'upsert'
    if (!sourceSubject || !targetSubject || (operation === 'upsert' && !label)) return []
    const sourceKind = isKind(relation.sourceKind) ? relation.sourceKind : undefined
    const targetKind = isKind(relation.targetKind) ? relation.targetKind : undefined
    return [{ sourceSubject, ...(sourceKind ? { sourceKind } : {}), targetSubject, ...(targetKind ? { targetKind } : {}), kind, label, confidence: number(relation.confidence), operation }]
  }).slice(0, 80) : []
  return { ...base, relations, ...parseArtifactProposals(value) }
}

function isRelationKind(value: unknown): value is MemoryRelationKind { return value === 'supports' || value === 'depends_on' || value === 'about' || value === 'conflicts_with' || value === 'follows' }

function parseCandidate(value: unknown): MemoryCandidate | undefined {
  const item = record(value)
  const kind = item.kind
  const operation = item.operation
  if (!isKind(kind) || (operation !== 'upsert' && operation !== 'complete' && operation !== 'remove')) return undefined
  const rawSubject = string(item.subject, 120)
  const subject = kind === 'profile' ? canonicalProfileSubject(rawSubject) : rawSubject
  const content = string(item.content, 800)
  if (!subject || (operation === 'upsert' && !content)) return undefined
  const candidate: MemoryCandidate = {
    kind, operation, subject, content,
    ...(string(item.targetMemoryId, 160) ? { targetMemoryId: string(item.targetMemoryId, 160) } : {}),
    evidenceQuote: string(item.evidenceQuote, 300), sourceTurnId: string(item.sourceTurnId, 160),
    confidence: number(item.confidence), importance: number(item.importance),
  }
  if (kind === 'emotion') candidate.expiresInDays = Math.min(7, Math.max(1, Math.round(finite(item.expiresInDays, 3))))
  else if (typeof item.expiresInDays === 'number' && item.expiresInDays > 0) candidate.expiresInDays = Math.min(3650, Math.round(item.expiresInDays))
  else if (kind === 'task' || kind === 'event') candidate.expiresInDays = 30
  return candidate
}

function isKind(value: unknown): value is MemoryKind { return value === 'profile' || value === 'preference' || value === 'task' || value === 'event' || value === 'relationship' || value === 'emotion' }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function string(value: unknown, max: number): string { const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; return text.slice(0, max) }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.map(item => string(item, 240)).filter(Boolean))].slice(0, 20) : [] }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5 }
function finite(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
