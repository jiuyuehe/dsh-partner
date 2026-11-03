import { validateAgreements } from './chat/agreements.js'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createDefaultCompanion, DEFAULT_AUTOMATION, normalizeLegacyHeartbeatFocus, type PartnerState } from './domain.js'
import { mergeBuiltinMarketSources } from './skills/markets/builtin.js'
import type { CompanionCapability } from './capabilities.js'
import type { SplitStatePersistence } from './storage/split-state.js'
import { validateMcpState } from './mcp/state.js'
import { validatePushState } from './notifications/push-state.js'
import { reconcileBoardContinuations } from './tasks/continuation.js'

export class PartnerStore {
  private state: PartnerState
  private writes: Promise<void> = Promise.resolve()
  private readonly removingCompanions = new Set<string>()
  private readonly listeners = new Set<{ notify(next: PartnerState, previous: PartnerState): void; onError(error: unknown): void }>()

  private frozen = false
  private constructor(private readonly path: string, state: PartnerState, private readonly split?: SplitStatePersistence) {
    this.state = state
  }

  static async openSplit(split: SplitStatePersistence): Promise<PartnerStore> {
    return new PartnerStore('', parseState(await split.read()), split)
  }
  async freeze(): Promise<void> { this.frozen = true; await this.writes }

  static async open(path: string): Promise<PartnerStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    let state: PartnerState
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
      state = parseState(raw)
      if (typeof raw === 'object' && raw !== null && (raw as { schemaVersion?: unknown }).schemaVersion !== state.schemaVersion) {
        const store = new PartnerStore(path, state)
        await store.persist(state)
        return store
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = emptyState()
      const store = new PartnerStore(path, state)
      await store.persist(state)
      return store
    }
    return new PartnerStore(path, state)
  }

  snapshot(): PartnerState {
    return structuredClone(this.state)
  }

  isCompanionRemoving(id: string): boolean { return this.removingCompanions.has(id) }

  beginCompanionRemoval(id: string): () => void {
    if (this.removingCompanions.has(id)) throw new Error('伙伴正在删除')
    this.removingCompanions.add(id)
    return () => { this.removingCompanions.delete(id) }
  }

  /** A live authorization read without copying task/history state per tool call. */
  hasCapability(companionId: string, capability: CompanionCapability): boolean {
    return this.state.companions.find(item => item.id === companionId)?.capabilities.includes(capability) ?? false
  }

  subscribe(notify: (next: PartnerState, previous: PartnerState) => void, onError: (error: unknown) => void): () => void {
    const listener = { notify, onError }
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async update(change: (draft: PartnerState) => void): Promise<PartnerState> {
    if (this.frozen) throw new Error('伙伴数据迁移中，暂不可写入')
    let resolveResult!: (value: PartnerState) => void
    let rejectResult!: (reason: unknown) => void
    const result = new Promise<PartnerState>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    this.writes = this.writes.then(async () => {
      const next = structuredClone(this.state)
      change(next)
      reconcileBoardContinuations(next)
      validateState(next)
      // Polling and repeated receipts often produce no change. Do not fsync or
      // notify observers for an identical state; actual commits stay durable.
      if (isDeepStrictEqual(next, this.state)) { resolveResult(this.snapshot()); return }
      await this.persist(next)
      const previous = this.state
      this.state = next
      // Observers cannot turn an already committed write into an apparent failure.
      for (const listener of this.listeners) {
        try { listener.notify(next, previous) } catch (error) { try { listener.onError(error) } catch { /* reporting must not reject a committed write */ } }
      }
      resolveResult(this.snapshot())
    }).catch(error => { rejectResult(error) })
    return result
  }

  private async persist(state: PartnerState): Promise<void> {
    if (this.split) return this.split.write(state)
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    const file = await open(temporary, 'r+')
    try { await file.sync() } finally { await file.close() }
    try {
      await rename(temporary, this.path)
    } catch (error) {
      if (process.platform !== 'win32' || !replaceError(error)) throw error
      await rm(this.path, { force: true })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(this.path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
}

function emptyState(): PartnerState {
  return {
    schemaVersion: 14,
    companions: [createDefaultCompanion()], channels: [], pairings: [], sessions: [], recentReceipts: [], heartbeatStates: [],
    skills: [], skillBindings: [], skillMarketSources: mergeBuiltinMarketSources([]), skillMarketNetwork: {}, tasks: [], taskActivities: [], delegations: [], companionAccessGrants: [], schedules: [], executionRuns: [],
  }
}

function parseState(value: unknown): PartnerState {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 1) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 4,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => ({
        ...(item as Record<string, unknown>), automation: structuredClone(DEFAULT_AUTOMATION),
      })) : legacy.companions,
      heartbeatStates: [],
    }
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 2) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 4,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown> | undefined
        const journal = automation?.journal as Record<string, unknown> | undefined
        return {
          ...companion,
          automation: {
            ...automation,
            journal: { ...journal, retentionDays: journal?.retentionDays === 90 ? 0 : journal?.retentionDays },
          },
        }
      }) : legacy.companions,
    }
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 3) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 4,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown> | undefined
        const heartbeat = automation?.heartbeat as Record<string, unknown> | undefined
        return {
          ...companion,
          automation: {
            ...automation,
            heartbeat: { ...heartbeat, dailyLimit: heartbeat?.dailyLimit === 2 ? 0 : heartbeat?.dailyLimit },
          },
        }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 4) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 5,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown> | undefined
        const { journal, ...rest } = automation ?? {}
        return { ...companion, automation: { ...rest, memory: journal ?? structuredClone(DEFAULT_AUTOMATION.memory) } }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 5) {
    value = { ...(value as Record<string, unknown>), schemaVersion: 6 }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 6) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy, schemaVersion: 7,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown>
        return { ...companion, automation: { ...automation, memory: { ...(automation.memory as Record<string, unknown>), dailyReviewEnabled: true, dailyReviewHour: 2 } } }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 7) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy, schemaVersion: 8,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown>
        const heartbeat = automation.heartbeat as Record<string, unknown>
        return { ...companion, automation: { ...automation, heartbeat: { ...heartbeat, focus: normalizeLegacyHeartbeatFocus(heartbeat.focus) } } }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 8) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy, schemaVersion: 9,
      heartbeatStates: Array.isArray(legacy.heartbeatStates) ? legacy.heartbeatStates.map(item => {
        const { focusCursor: _focusCursor, ...state } = item as Record<string, unknown>
        return state
      }) : legacy.heartbeatStates,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 9) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy, schemaVersion: 10,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        const automation = companion.automation as Record<string, unknown>
        const heartbeat = automation.heartbeat as Record<string, unknown>
        const { focus, ...rest } = heartbeat
        const legacyFocus = normalizeLegacyHeartbeatFocus(focus)
        return { ...companion, automation: { ...automation, heartbeat: { ...rest, ...(legacyFocus ? { legacyFocus } : {}) } } }
      }) : legacy.companions,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 10) {
    value = {
      ...(value as Record<string, unknown>), schemaVersion: 11,
      skills: [], skillBindings: [], skillMarketSources: [], tasks: [], taskActivities: [], delegations: [], schedules: [], executionRuns: [],
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 11) {
    const legacy = value as Record<string, unknown>
    const sources = Array.isArray(legacy.skillMarketSources) ? legacy.skillMarketSources.map(item => ({ ...(item as Record<string, unknown>), kind: 'dsh-index' })) : []
    value = {
      ...legacy,
      schemaVersion: 12,
      companions: Array.isArray(legacy.companions) ? legacy.companions.map(item => {
        const companion = item as Record<string, unknown>
        return { ...companion, capabilities: Array.isArray(companion.capabilities) ? companion.capabilities.filter(capability => capability !== 'collaboration') : [] }
      }) : legacy.companions,
      skillMarketSources: mergeBuiltinMarketSources(sources as PartnerState['skillMarketSources']),
      companionAccessGrants: [],
      delegations: Array.isArray(legacy.delegations) ? legacy.delegations.map(item => ({ initiatedBy: 'companion', ...(item as Record<string, unknown>) })) : [],
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 12) {
    value = { ...(value as Record<string, unknown>), schemaVersion: 13, skillMarketNetwork: {} }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { schemaVersion?: unknown }).schemaVersion === 13) {
    const legacy = value as Record<string, unknown>
    value = {
      ...legacy,
      schemaVersion: 14,
      sessions: Array.isArray(legacy.sessions) ? legacy.sessions.map(item => {
        const session = item as Record<string, unknown>
        return { ...session, kind: session.kind === 'local' ? 'local' : 'channel' }
      }) : legacy.sessions,
      tasks: Array.isArray(legacy.tasks) ? legacy.tasks.map(item => {
        const task = item as Record<string, unknown>
        const { relatedTaskIds, ...rest } = task
        return { ...rest, dependencyTaskIds: Array.isArray(task.dependencyTaskIds) ? task.dependencyTaskIds : Array.isArray(relatedTaskIds) ? relatedTaskIds : [] }
      }) : legacy.tasks,
    }
  }
  validateState(value)
  return value
}

function validateState(value: unknown): asserts value is PartnerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('partner state must be an object')
  const state = value as Partial<PartnerState>
  if (state.schemaVersion !== 14) throw new Error('unsupported partner state schema')
  if (state.requirements !== undefined && !Array.isArray(state.requirements)) throw new Error('partner requirements must be an array')
  if (state.planReceipts !== undefined && (!Array.isArray(state.planReceipts) || state.planReceipts.length > 2000)) throw new Error('partner planReceipts must be a bounded array')
  for (const key of [
    'companions', 'channels', 'pairings', 'sessions', 'recentReceipts', 'heartbeatStates',
    'skills', 'skillBindings', 'skillMarketSources', 'tasks', 'taskActivities', 'delegations', 'companionAccessGrants', 'schedules', 'executionRuns',
  ] as const) {
    if (!Array.isArray(state[key])) throw new Error(`partner state ${key} must be an array`)
  }
  if (typeof state.skillMarketNetwork !== 'object' || state.skillMarketNetwork === null || Array.isArray(state.skillMarketNetwork)) throw new Error('partner state skillMarketNetwork must be an object')
  if (state.skillMarketNetwork.proxyUrl !== undefined && typeof state.skillMarketNetwork.proxyUrl !== 'string') throw new Error('partner state skillMarketNetwork.proxyUrl must be a string')
  const companionIds = new Set(state.companions!.map(companion => companion.id))
  validateMcpState(state)
  validatePushState(state)
  for (const companion of state.companions!) {
    validateAgreements(companion.temporaryAgreements)
    if(companion.activityJournal!==undefined&&(!Array.isArray(companion.activityJournal)||companion.activityJournal.length>40||companion.activityJournal.some(a=>!a||typeof a.id!=='string'||typeof a.sessionId!=='string'||!Number.isFinite(a.at)||typeof a.summary!=='string'||a.summary.length>600||typeof a.silent!=='boolean'||!Array.isArray(a.tools)||a.tools.length>24||a.tools.some(t=>typeof t.name!=='string'||t.name.length>100||typeof t.ok!=='boolean')||!Array.isArray(a.artifacts)||a.artifacts.length>4||a.artifacts.some(p=>typeof p!=='string'||p.length>500))))throw Error('invalid activity journal')
    if (companion.activityPlan) { const p=companion.activityPlan; if(!['waiting','pending','claimed','cancelled'].includes(p.status)||!Number.isFinite(p.dueAt)||!Number.isFinite(p.createdAt)||!Number.isFinite(p.policyRevision)||typeof p.autonomous!=='boolean'||['id','sourceRouteId','sourceSessionId','sourceInputId','targetRouteId','targetSessionId','intention'].some(k=>typeof (p as unknown as Record<string,unknown>)[k]!=='string')||p.intention.length>300) throw Error('invalid activity plan') }
    if (companion.thoughts !== undefined && (!Array.isArray(companion.thoughts) || companion.thoughts.length>64 || companion.thoughts.some(t=>!t || typeof t.id!=='string' || typeof t.text!=='string' || t.text.length>300 || typeof t.why!=='string' || t.why.length>300 || !Array.isArray(t.sourceRouteIds) || t.sourceRouteIds.some(id=>typeof id!=='string') || typeof t.targetRouteId!=='string' || !['open','done','dismissed'].includes(t.status) || !Number.isFinite(t.createdAt) || !Number.isFinite(t.sourceAt) || !Number.isFinite(t.updatedAt) || !Number.isInteger(t.attempts) || t.attempts<0))) throw Error('invalid companion thoughts')
    if (companion.interactionReview !== undefined) {
      const review=companion.interactionReview
      if (!review || typeof review!=='object' || Array.isArray(review) || Object.entries(review).some(([key,r])=>!['affection','persona'].includes(key) || !r || !Number.isFinite(r.at) || !Number.isFinite(r.sourceAt) || typeof r.turnId!=='string' || !['changed','unchanged','limited','stale','failed'].includes(r.outcome) || typeof r.reason!=='string' || r.reason.length>300)) throw Error('invalid interaction review')
    }
    if (companion.affection) {
      const a=companion.affection
      if (!Number.isFinite(a.score) || a.score < -100 || a.score > 100 || (a.history !== undefined && (!Array.isArray(a.history) || a.history.length > 40 || a.history.some(h=>!h || !Number.isFinite(h.at) || typeof h.turnId !== 'string' || ![-3,-2,-1,1].includes(h.delta) || !Number.isFinite(h.score) || h.score < -100 || h.score > 100 || typeof h.reason !== 'string' || h.reason.length > 300 || typeof h.evidence !== 'string' || h.evidence.length > 300)))) throw Error('invalid affection state')
    }
    if (companion.idleContact?.selfRefinement !== undefined && typeof companion.idleContact.selfRefinement !== 'boolean') throw Error('invalid self refinement switch')
    if (companion.personaHistory !== undefined && (!Array.isArray(companion.personaHistory) || companion.personaHistory.length > 12 || companion.personaHistory.some(e => !e || !Number.isFinite(e.at) || typeof e.reason !== 'string' || e.reason.length > 500 || !e.before || !e.after || JSON.stringify(e).length > 250000))) throw Error('invalid persona history')
    const config = companion.notificationDelivery
    if (config === undefined) continue
    if (!config || !['recent','selected'].includes(config.mode) || !Array.isArray(config.targets) || config.targets.length > 50 || (config.mode === 'selected' && !config.targets.length) || config.targets.some(t => !t || typeof t.channelId !== 'string' || !t.channelId || typeof t.userId !== 'string' || !t.userId)) throw new Error('invalid companion notification settings')
  }
  if (state.notificationDeliveries !== undefined) {
    if (!Array.isArray(state.notificationDeliveries) || state.notificationDeliveries.length > 1000) throw new Error('invalid notification delivery ledger')
    for (const record of state.notificationDeliveries) {
      if (!record || typeof record.id !== 'string' || typeof record.companionId !== 'string' || !Number.isFinite(record.createdAt) || !record.reply || typeof record.reply.text !== 'string' || !Array.isArray(record.reply.attachments) || !Array.isArray(record.targets) || !record.targets.length || record.targets.length > 50 || record.targets.some(t => !t || typeof t.channelId !== 'string' || typeof t.userId !== 'string' || !Array.isArray(t.sentParts) || t.sentParts.some(n => !Number.isInteger(n) || n < 0))) throw new Error('invalid notification delivery record')
    }
  }
  const grantKeys = new Set<string>()
  if (state.companionAccessGrants!.length > 1000) throw new Error('partner state companionAccessGrants exceeds limit')
  for (const grant of state.companionAccessGrants!) {
    if (!companionIds.has(grant.fromCompanionId) || !companionIds.has(grant.toCompanionId)) throw new Error('partner access grant references a missing companion')
    if (grant.fromCompanionId === grant.toCompanionId) throw new Error('partner access grant cannot target itself')
    const key = `${grant.fromCompanionId}\u0000${grant.toCompanionId}`
    if (grantKeys.has(key)) throw new Error('partner access grant is duplicated')
    grantKeys.add(key)
  }
}

function replaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EEXIST'
}
