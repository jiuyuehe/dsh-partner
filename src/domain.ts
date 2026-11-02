import { normalizeSleepPolicy } from './character/sleep.js'
import { normalizeIdleContact } from './character/idle-contact.js'
import { normalizeCharacterCard, type CharacterCard } from './character/domain.js'
import type { CompanionSkillBinding, PartnerSkill, SkillMarketSource } from './skills/domain.js'
import type { BoardTask, TaskActivity } from './tasks/domain.js'
import type { BoardRequirement } from './requirements/domain.js'
import type { PartnerDelegation } from './collaboration/domain.js'
import type { ExecutionRun } from './execution/domain.js'
import type { ScheduledPartnerTask } from './scheduler/domain.js'
import { isCompanionCapability, type CompanionCapability } from './capabilities.js'
export type { CompanionCapability } from './capabilities.js'

export type PairingStatus = 'pending' | 'approved' | 'blocked'

export interface Companion {
  temporaryAgreements?: import('./chat/agreements.js').TemporaryAgreement[]
  affection?: import('./character/affection.js').AffectionState
  toolDiscovery?: boolean
  sleepPolicy?: import('./character/sleep.js').SleepPolicy
  sleepState?: import('./character/sleep.js').SleepState
  personaHistory?: import('./companions/persona-refinement.js').PersonaRevision[]
  identityDraft?: import('./companions/identity.js').CompanionIdentity
  idleContact?: import('./character/idle-contact.js').IdleContactPolicy
  characterCard?: CharacterCard
  notificationDelivery?: { mode: 'recent' | 'selected'; targets: {channelId: string; userId: string}[] }
  id: string
  name: string
  role: string
  description: string
  instructions: string
  relationshipText?: string
  presetId?: string
  provider?: string
  model?: string
  capabilities: CompanionCapability[]
  automation: CompanionAutomation
  createdAt: number
  updatedAt: number
}

export interface CompanionAutomation {
  memory: {
    enabled: boolean
    retentionDays: number
    provider?: string
    model?: string
    rollingContextEnabled?: boolean
    rollingContextTurns?: number
    rollingContextMaxChars?: number
    contextRenewalEnabled?: boolean
    contextRenewalHour?: number
    dailyReviewEnabled: boolean
    dailyReviewHour: number
  }
  heartbeat: {
    enabled: boolean
    /** One-shot migration source. Cleared after the Concern store accepts it. */
    legacyFocus?: string
    intervalMinutes: number
    quietStartHour: number
    quietEndHour: number
    dailyLimit: number
  }
}

export interface HeartbeatRuntimeState {
  lastOutcome?: 'success' | 'partial' | 'blocked'
  companionId: string
  lastCheckedAt?: number
  lastSentAt?: number
  nextCheckAt: number
  sentDay: string
  sentCount: number
  consecutiveFailures: number
  lastError?: string
}

export interface WeixinChannel {
  /** Missing platform is legacy WeChat; IDs and credential keys stay unchanged. */
  qq?: import('./channels/qq/settings.js').QqSettings
  qqActivity?: import('./channels/qq/actions.js').QqActionReceipt[]
  platform?: 'weixin' | 'matrix' | 'mattermost' | 'qq'
  direct?: { baseUrl: string; targetId: string; peerId: string; cursor?: string }
  id: string
  companionId: string
  accountId: string
  name: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface PairingRequest {
  directTargetId?: string
  pairingCode?: string
  lastInboundAt?: number
  contactKey?: string
  deliveryTarget?: {channelId: string; userId: string}
  id: string
  channelId: string
  userId: string
  displayName: string
  status: PairingStatus
  createdAt: number
  updatedAt: number
}

export interface ChannelSession {
  /** QQ contexts can be separate while using companion-wide long-term memory. */
  memoryScopeId?: string
  qqSessionTarget?: string
  qqSessionMode?: 'main' | 'separate'
  qqSeparateSessionId?: string
  qqSeparateCwd?: string
  qqSessionTitle?: string
  qqAppliedTitle?: string
  idleContactState?: import('./character/idle-contact.js').IdleContactState
  postReplyOpportunity?: import('./character/post-reply.js').PostReplyOpportunity
  idleActivityCheck?: { at: number; probability: number }
  id: string
  /** Local DSH conversation or a channel-backed contact conversation. */
  kind: 'local' | 'channel'
  channelId: string
  userId: string
  companionId: string
  sessionId: string
  /** Immutable working directory copied into the DSH Session header. */
  cwd?: string
  lastMessageAt: number
  /** Stable user-message identities received on this route; never inferred from text. */
  inboundMessageIds?: string[]
}

export interface PartnerState {
  concernExecutions?: import('./concern-execution.js').ConcernExecutionReceipt[]
  mcpServers?: import('./mcp/domain.js').McpServer[]
  mcpBindings?: import('./mcp/domain.js').McpBinding[]
  schemaVersion: 14
  companions: Companion[]
  channels: WeixinChannel[]
  pairings: PairingRequest[]
  sessions: ChannelSession[]
  recentReceipts: string[]
  notificationDeliveries?: import('./channels/notification-delivery.js').NotificationDeliveryRecord[]
  pushChannels?: import('./notifications/push-domain.js').PushChannel[]
  pushDeliveries?: import('./notifications/push-domain.js').PushDelivery[]
  heartbeatStates: HeartbeatRuntimeState[]
  skills: PartnerSkill[]
  skillBindings: CompanionSkillBinding[]
  skillMarketSources: SkillMarketSource[]
  skillMarketNetwork: SkillMarketNetworkSettings
  tasks: BoardTask[]
  requirements?: BoardRequirement[]
  planReceipts?: import('./requirements/plan.js').PlanReceipt[]
  taskActivities: TaskActivity[]
  delegations: PartnerDelegation[]
  companionAccessGrants: CompanionAccessGrant[]
  schedules: ScheduledPartnerTask[]
  executionRuns: ExecutionRun[]
}

export interface SkillMarketNetworkSettings {
  proxyUrl?: string
}

/** A directed capability-directory and delegation grant: from -> to. */
export interface CompanionAccessGrant {
  fromCompanionId: string
  toCompanionId: string
  createdAt: number
}

export interface CompanionDraft {
  toolDiscovery?: boolean
  sleepPolicy?: import('./character/sleep.js').SleepPolicy
  idleContact?: import('./character/idle-contact.js').IdleContactPolicy
  characterCard?: CharacterCard
  name: string
  role: string
  description: string
  instructions: string
  relationshipText?: string
  presetId?: string
  provider?: string
  model?: string
  capabilities: CompanionCapability[]
}

export const DEFAULT_AUTOMATION: CompanionAutomation = {
  memory: { rollingContextEnabled: false, rollingContextTurns: 20, rollingContextMaxChars: 48000, contextRenewalHour: 4, contextRenewalEnabled: true, enabled: false, retentionDays: 0, dailyReviewEnabled: false, dailyReviewHour: 2 },
  heartbeat: { enabled: false, intervalMinutes: 360, quietStartHour: 22, quietEndHour: 8, dailyLimit: 0 },
}

export function normalizeAutomation(value: unknown): CompanionAutomation {
  const input = object(value, 'automation')
  const memory = object(input.memory, 'automation.memory')
  const heartbeat = object(input.heartbeat, 'automation.heartbeat')
  return {
    memory: {
      enabled: boolean(memory.enabled, 'memory.enabled'),
      retentionDays: retentionDays(memory.retentionDays),
      rollingContextEnabled: boolean(memory.rollingContextEnabled ?? false, 'memory.rollingContextEnabled'),
      rollingContextTurns: integer(memory.rollingContextTurns ?? 20, 'memory.rollingContextTurns', 2, 100),
      rollingContextMaxChars: integer(memory.rollingContextMaxChars ?? 48000, 'memory.rollingContextMaxChars', 4000, 200000),
      contextRenewalHour: integer(memory.contextRenewalHour ?? 4, 'memory.contextRenewalHour', 0, 23),
      contextRenewalEnabled: boolean(memory.contextRenewalEnabled ?? true, 'memory.contextRenewalEnabled'),
      dailyReviewEnabled: boolean(memory.dailyReviewEnabled ?? true, 'memory.dailyReviewEnabled'),
      dailyReviewHour: integer(memory.dailyReviewHour ?? 2, 'memory.dailyReviewHour', 0, 23),
      ...optionalRoute(memory),
    },
    heartbeat: {
      enabled: boolean(heartbeat.enabled, 'heartbeat.enabled'),
      ...(typeof heartbeat.legacyFocus === 'string' && normalizeLegacyHeartbeatFocus(heartbeat.legacyFocus)
        ? { legacyFocus: normalizeLegacyHeartbeatFocus(heartbeat.legacyFocus) }
        : {}),
      intervalMinutes: integer(heartbeat.intervalMinutes, 'heartbeat.intervalMinutes', 30, 1440),
      quietStartHour: integer(heartbeat.quietStartHour, 'heartbeat.quietStartHour', 0, 23),
      quietEndHour: integer(heartbeat.quietEndHour, 'heartbeat.quietEndHour', 0, 23),
      dailyLimit: integer(heartbeat.dailyLimit, 'heartbeat.dailyLimit', 0, 24),
    },
  }
}

export function normalizeLegacyHeartbeatFocus(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new Error('legacy heartbeat focus must be a string')
  return uniqueLegacyTopics(value.split(/[\r\n;；]+/)).join('\n')
}

function uniqueLegacyTopics(values: unknown[]): string[] {
  const seen = new Set<string>()
  return values.flatMap(value => {
    if (typeof value !== 'string') return []
    const focus = value.replace(/\s+/g, ' ').trim()
    const key = focus.toLocaleLowerCase()
    if (!focus || seen.has(key)) return []
    seen.add(key)
    return [focus]
  })
}

function optionalRoute(value: Record<string, unknown>): { provider?: string; model?: string } {
  const provider = optionalText(value.provider, 'memory.provider', 100)
  const model = optionalText(value.model, 'memory.model', 200)
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
}

export interface ChannelView extends WeixinChannel {
  runtimeStatus: 'stopped' | 'starting' | 'running' | 'error'
  activity?: {kind:string;label:string;sessionId?:string}[]
  groupDecision?: {at:number;groupId:string;reason:string}
  qqLatency?: import('./channels/qq/latency.js').QqLatencySample[]
  idleDelivery?: string
  lastError?: string
  credentialConfigured: boolean
}

export function normalizeCompanionDraft(value: unknown): CompanionDraft {
  const input = object(value, 'companion')
  if(input.toolDiscovery!==undefined&&typeof input.toolDiscovery!=='boolean')throw Error('按需加载工具开关无效')
  const capabilities = Array.isArray(input.capabilities)
    ? input.capabilities.map(item => text(item, 'capability', 32)).filter(isCompanionCapability)
    : []
  const draft: CompanionDraft = {
    ...(input.toolDiscovery===undefined?{}:{toolDiscovery:input.toolDiscovery}),
    ...(input.sleepPolicy === undefined ? {} : { sleepPolicy: normalizeSleepPolicy(input.sleepPolicy) }),
    ...(input.idleContact === undefined ? {} : { idleContact: normalizeIdleContact(input.idleContact) }),
    ...(input.characterCard === undefined ? {} : { characterCard: normalizeCharacterCard(input.characterCard) }),
    name: text(input.name, 'name', 60),
    role: optionalText(input.role, 'role', 120) ?? '长期 AI 工作伙伴',
    description: optionalText(input.description, 'description', 500) ?? '',
    instructions: optionalText(input.instructions, 'instructions', 12_000) ?? '',
    ...(input.relationshipText !== undefined ? { relationshipText: optionalText(input.relationshipText, '关系设定', 12000) ?? '' } : {}),
    capabilities: [...new Set(capabilities)],
  }
  const presetId = optionalText(input.presetId, 'presetId', 100)
  const provider = optionalText(input.provider, 'provider', 100)
  const model = optionalText(input.model, 'model', 200)
  if (presetId !== undefined) draft.presetId = presetId
  if (provider !== undefined) draft.provider = provider
  if (model !== undefined) draft.model = model
  return draft
}

export function createDefaultCompanion(now = Date.now()): Companion {
  return {
    id: 'companion-default',
    name: '墨伴',
    role: '长期 AI 工作伙伴',
    description: '在桌面和微信之间保持同一工作身份与独立上下文。',
    instructions: '你是用户长期信任的工作伙伴。保持清晰、可靠、克制；需要使用工具时先核对目标和权限，不要猜测执行结果。',
    capabilities: [],
    automation: structuredClone(DEFAULT_AUTOMATION),
    createdAt: now,
    updatedAt: now,
  }
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} is out of range`)
  return value as number
}

function retentionDays(value: unknown): number {
  if (value === 0) return 0
  return integer(value, 'memory.retentionDays', 7, 3650)
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`)
  const normalized = value.trim()
  if (normalized.length > max) throw new Error(`${label} is too long`)
  return normalized
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return text(value, label, max)
}
